import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../../config.js";
import type { Run } from "../run.js";
import type { RiskAssessment, Tool, ToolResult } from "../types.js";
import { isAllowedUrl } from "./http.js";
import { snapshotDom, truncateSnapshot } from "./snapshot.js";

const SNAPSHOT_LIMIT = 4500;
const STATE_CHANGING_WORDS = /\b(submit|save|send|post|delete|remove|pay|approve|confirm|transfer|purchase|create|update)\b/i;

let sharedBrowser: Promise<Browser> | undefined;
// Memory-saving flags for tiny hosts: no /dev/shm (often 64 MB in containers), no GPU, one renderer process.
const LOW_MEMORY_ARGS = ["--disable-dev-shm-usage", "--disable-gpu", "--renderer-process-limit=1", "--disable-extensions", "--no-zygote"];
const getBrowser = () => (sharedBrowser ??= chromium.launch({ headless: config.headless, args: config.lowMemory ? LOW_MEMORY_ARGS : [] }));

export async function closeSharedBrowser() {
  if (sharedBrowser) await (await sharedBrowser).close().catch(() => {});
  sharedBrowser = undefined;
}

/**
 * One browser tab per agent (worker and verifier get separate sessions so the verifier
 * cannot inherit the worker's page state).
 */
export class BrowserSession {
  private context?: BrowserContext;
  private page?: Page;
  private lastStatus?: number;

  constructor(private run: Run) {}

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const browser = await getBrowser();
    this.context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(10_000);
    this.page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.frame() === this.page?.mainFrame()) this.lastStatus = r.status();
    });
    return this.page;
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = undefined;
    this.page = undefined;
  }

  /** Text snapshot of the current page + screenshot saved as evidence. */
  async observe(label: string): Promise<ToolResult> {
    const page = await this.getPage();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    // tsx/esbuild wraps named inner functions in __name(); define it in the page so serialised functions run.
    await page.evaluate("globalThis.__name ??= (f) => f");
    const body = truncateSnapshot(await page.evaluate(snapshotDom), SNAPSHOT_LIMIT);
    const shot = this.run.nextScreenshotPath(label);
    await page.screenshot({ path: shot.abs }).catch(() => {});
    const status = this.lastStatus && this.lastStatus >= 400 ? `\nHTTP status: ${this.lastStatus} (error)` : "";
    return {
      ok: !(this.lastStatus && this.lastStatus >= 400),
      output: `URL: ${page.url()}\nTitle: ${await page.title()}${status}\n---\n${body}`,
      screenshot: shot.rel,
    };
  }

  async locate(ref: number | string) {
    const page = await this.getPage();
    const loc = page.locator(`[data-agent-ref="${ref}"]`);
    if ((await loc.count()) === 0) throw new Error(`No element with ref ${ref} on the current page. Take a fresh browser_snapshot; refs change after every page load.`);
    return loc.first();
  }

  /** Inspect an element to decide whether clicking it changes state somewhere. */
  async assessClick(ref: number | string): Promise<RiskAssessment> {
    try {
      const loc = await this.locate(ref);
      const info = await loc.evaluate((el) => {
        const form = (el as HTMLButtonElement).form ?? el.closest("form");
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || (tag === "button" ? "submit" : "")).toLowerCase();
        return {
          tag,
          text: (el as HTMLElement).innerText || (el as HTMLInputElement).value || "",
          submitsForm: !!form && (tag === "button" || tag === "input") && type === "submit",
          method: (form?.getAttribute("method") || "get").toLowerCase(),
          action: form?.getAttribute("action") || "",
          // What will actually be sent, so the human approves values rather than "click [14]".
          fields: form
            ? Array.from(form.querySelectorAll("input, select, textarea"))
                .filter((f) => !["submit", "button", "hidden", "password"].includes((f as HTMLInputElement).type))
                .map((f) => {
                  const s = f as HTMLSelectElement;
                  const label = (f.id && document.querySelector(`label[for="${f.id}"]`)?.textContent?.trim()) || f.getAttribute("name") || "?";
                  const value = f.tagName === "SELECT" ? (s.options[s.selectedIndex]?.text ?? "") : (f as HTMLInputElement).value;
                  return `${label}: ${value || "(empty)"}`;
                })
            : [],
        };
      });
      if (info.submitsForm && info.method !== "get")
        return {
          level: "risky",
          reason: `Submits a ${info.method.toUpperCase()} form to ${info.action || "the current page"} via "${info.text.trim()}" — this changes data in a company system.${info.fields.length ? `\nForm values: ${info.fields.join(" · ")}` : ""}`,
        };
      if (info.tag !== "a" && STATE_CHANGING_WORDS.test(info.text))
        return { level: "risky", reason: `Clicks "${info.text.trim()}", which looks state-changing.` };
      return { level: "none", reason: "navigation" };
    } catch {
      return { level: "none", reason: "element not found; the click will fail harmlessly" };
    }
  }

  async settle() {
    const page = await this.getPage();
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
  }
}

const sessionKey = Symbol("browser");
export function browserFor(run: Run, actor: "worker" | "verifier"): BrowserSession {
  const r = run as unknown as Record<symbol, Record<string, BrowserSession>>;
  r[sessionKey] ??= {};
  return (r[sessionKey][actor] ??= new BrowserSession(run));
}

export async function closeRunBrowsers(run: Run) {
  const r = run as unknown as Record<symbol, Record<string, BrowserSession> | undefined>;
  for (const s of Object.values(r[sessionKey] ?? {})) await s.close();
}

const fail = (e: unknown): ToolResult => ({ ok: false, output: `Error: ${(e as Error).message.split("\n")[0]}` });

export function browserTools(actor: "worker" | "verifier", opts: { readOnly?: boolean } = {}): Tool[] {
  const s = (run: Run) => browserFor(run, actor);

  const tools: Tool[] = [
    {
      name: "browser_open",
      description: "Open a URL in the browser and return a text snapshot of the page. Interactive elements are shown as [ref] for use with other browser tools.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      async execute({ url }: { url: string }, run) {
        if (!isAllowedUrl(url)) return { ok: false, output: `Blocked: ${url} is outside the allowed environment (${config.mockcoPort}). Only internal company apps may be used.` };
        try {
          const page = await s(run).getPage();
          await page.goto(url, { waitUntil: "domcontentloaded" });
          return s(run).observe("open");
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      name: "browser_snapshot",
      description: "Re-read the current page (text snapshot with fresh [ref] numbers).",
      parameters: { type: "object", properties: {} },
      async execute(_args, run) {
        try {
          return await s(run).observe("snapshot");
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      name: "browser_click",
      description: "Click an element by its [ref] from the latest snapshot. Returns the resulting page.",
      parameters: { type: "object", properties: { ref: { type: "integer" } }, required: ["ref"] },
      assessRisk: ({ ref }: { ref: number }, run) => s(run).assessClick(ref),
      async execute({ ref }: { ref: number }, run) {
        try {
          if (opts.readOnly) {
            const risk = await s(run).assessClick(ref);
            if (risk.level !== "none") return { ok: false, output: `Blocked: the verifier is read-only and cannot ${risk.reason}` };
          }
          const loc = await s(run).locate(ref);
          const href = await loc.getAttribute("href");
          if (href && !isAllowedUrl(new URL(href, (await s(run).getPage()).url()).href)) return { ok: false, output: `Blocked: link leads outside the allowed environment.` };
          await loc.click();
          await s(run).settle();
          return s(run).observe("click");
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      name: "browser_back",
      description: "Go back to the previous page.",
      parameters: { type: "object", properties: {} },
      async execute(_args, run) {
        try {
          await (await s(run).getPage()).goBack();
          return s(run).observe("back");
        } catch (e) {
          return fail(e);
        }
      },
    },
  ];

  if (!opts.readOnly) {
    tools.push({
      name: "browser_fill",
      description:
        "Set the value of an input/textarea, or choose an option in a select (by visible text or value), by [ref]. Does not submit — click the submit button afterwards.",
      parameters: { type: "object", properties: { ref: { type: "integer" }, value: { type: "string" } }, required: ["ref", "value"] },
      async execute({ ref, value }: { ref: number; value: string }, run) {
        try {
          const loc = await s(run).locate(ref);
          const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
          if (tag === "select") {
            const options = await loc.evaluate((el) => [...(el as HTMLSelectElement).options].map((o) => ({ value: o.value, label: o.text.trim() })));
            const match =
              options.find((o) => o.value === value || o.label === value) ??
              options.find((o) => o.label.toLowerCase() === value.toLowerCase()) ??
              null;
            if (!match) return { ok: false, output: `Option "${value}" not found. Available: ${options.map((o) => o.label).join(", ")}` };
            await loc.selectOption(match.value);
          } else {
            await loc.fill(String(value));
          }
          const shown = await loc.evaluate((el) => (el as HTMLInputElement).value);
          return { ok: true, output: `Set [${ref}] to "${shown}".` };
        } catch (e) {
          return fail(e);
        }
      },
    });
  }
  return tools;
}
