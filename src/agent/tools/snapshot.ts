const ACTIONABLE = /\[\d+\] (link|button|input|select|textarea|checkbox|radio)\b|\[ALERT\]|^#|HTTP status/;

/**
 * Shrink a snapshot to `limit` chars without losing what the agent needs to act: interactive [ref]
 * lines, alerts and headings are kept first; plain text fills the remaining budget in page order.
 * (A plain tail cut would drop submit buttons and error banners at the bottom of long pages.)
 */
export function truncateSnapshot(body: string, limit: number): string {
  if (body.length <= limit) return body;
  const lines = body.split("\n");
  const keep = new Array<boolean>(lines.length).fill(false);
  let used = 0;
  const take = (i: number) => {
    const cost = lines[i].length + 1;
    if (used + cost > limit) return false;
    keep[i] = true;
    used += cost;
    return true;
  };
  lines.forEach((l, i) => ACTIONABLE.test(l) && take(i));
  lines.forEach((l, i) => !keep[i] && !ACTIONABLE.test(l) && take(i));
  const omitted = keep.filter((k) => !k).length;
  return lines.filter((_, i) => keep[i]).join("\n") + `\n…(${omitted} lines of page text omitted to fit; interactive elements and alerts were kept)`;
}

/**
 * Runs inside the page. Produces a compact, LLM-friendly text rendering of the visible DOM:
 * headings, text, table rows, and every interactive element tagged with a numeric ref
 * (stored as data-agent-ref so the browser tools can act on it later).
 *
 * Kept as a self-contained function because Playwright serialises it into the page.
 */
export function snapshotDom(): string {
  const out: string[] = [];
  let n = 0;
  document.querySelectorAll("[data-agent-ref]").forEach((e) => e.removeAttribute("data-agent-ref"));

  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || el.tagName === "OPTION";
  };
  const labelFor = (el: HTMLElement) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`) as HTMLElement | null;
      if (l) return clean(l.innerText);
    }
    const wrap = el.closest("label") as HTMLElement | null;
    if (wrap) return clean(wrap.innerText);
    return clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name"));
  };

  function describe(el: HTMLElement, ref: number): string {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return `[${ref}] link "${clean(el.innerText)}" -> ${el.getAttribute("href")}`;
    if (tag === "select") {
      const s = el as HTMLSelectElement;
      const opts = [...s.options].map((o) => (o.value && o.value !== o.text ? `${clean(o.text)} (${o.value})` : clean(o.text))).join(" | ");
      return `[${ref}] select "${labelFor(el)}" selected="${clean(s.options[s.selectedIndex]?.text)}" options=[${opts}]`;
    }
    if (tag === "textarea") return `[${ref}] textarea "${labelFor(el)}" value="${(el as HTMLTextAreaElement).value}"`;
    if (tag === "input") {
      const i = el as HTMLInputElement;
      const type = (i.type || "text").toLowerCase();
      if (["submit", "button", "reset"].includes(type)) return `[${ref}] button "${clean(i.value)}"`;
      if (["checkbox", "radio"].includes(type)) return `[${ref}] ${type} "${labelFor(el)}" checked=${i.checked}`;
      const ph = i.placeholder ? ` placeholder="${i.placeholder}"` : "";
      return `[${ref}] input "${labelFor(el)}" value="${i.value}"${ph}`;
    }
    return `[${ref}] button "${clean(el.innerText || el.getAttribute("aria-label"))}"`;
  }

  const isInteractive = (el: HTMLElement) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href");
    if (["button", "select", "textarea"].includes(tag)) return true;
    if (tag === "input") return (el as HTMLInputElement).type !== "hidden";
    return el.getAttribute("role") === "button";
  };

  const BLOCK = new Set(["p", "div", "li", "ul", "ol", "table", "thead", "tbody", "section", "form", "pre", "header", "main", "footer", "nav", "br", "h1", "h2", "h3", "h4", "h5", "h6"]);

  function walk(node: Node, acc: string[]) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parent = child.parentElement;
        const raw = parent && parent.closest("pre") ? (child.textContent ?? "").trim() : clean(child.textContent);
        if (raw) acc.push(raw);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "template", "label", "option"].includes(tag) || !visible(el)) continue;

      if (isInteractive(el)) {
        const ref = ++n;
        el.setAttribute("data-agent-ref", String(ref));
        acc.push(describe(el, ref));
        if (tag !== "a") acc.push("\n");
        continue;
      }
      if (/^h[1-6]$/.test(tag)) {
        acc.push(`\n${"#".repeat(Number(tag[1]))} ${clean(el.innerText)}\n`);
        continue;
      }
      if (tag === "tr") {
        const cells = Array.from(el.children).map((c) => {
          const a: string[] = [];
          walk(c, a);
          return a.join(" ").replace(/\s*\n\s*/g, " ").trim();
        });
        acc.push(`\n| ${cells.join(" | ")} |\n`);
        continue;
      }
      if (el.getAttribute("role") === "alert" || el.getAttribute("role") === "status") acc.push("\n[ALERT]");
      const block = BLOCK.has(tag);
      if (block) acc.push("\n");
      walk(el, acc);
      if (block) acc.push("\n");
    }
  }

  walk(document.body, out);
  return out
    .join(" ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\|\n\n\|/g, "|\n|")
    .trim();
}
