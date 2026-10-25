import { BASE, ScriptedLLM, lastObservation } from "./helpers.js";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createMockco } from "../src/mockco/app.js";
import { Run, runTask } from "../src/agent/worker.js";
import { closeSharedBrowser } from "../src/agent/tools/browser.js";
import { truncateSnapshot } from "../src/agent/tools/snapshot.js";
import type { RunEvent } from "../src/agent/types.js";

const mockco = createMockco({ chaos: true });
let server: Server;
before(() => new Promise<void>((r) => (server = mockco.app.listen(4555, r))));
after(async () => {
  server.close();
  await closeSharedBrowser();
});
beforeEach(() => mockco.reset());

const TASK = "Find the latest invoice from Acme Corp, extract the amount and due date, enter it into our billing system, and tell me once it is done.";
const plan = {
  goal: "Acme Corp's latest invoice is recorded as a bill",
  success_criteria: ["Exactly one bill for INV-2026-0931 exists with amount 12480.50 and due date 2026-11-15"],
  steps: [{ text: "Find invoice", status: "in_progress" }],
};

/** Auto-answer approvals/questions like a human would, recording what was asked. */
function autoHuman(run: Run, opts: { approve?: boolean | ((ev: RunEvent) => boolean); answer?: string } = {}) {
  const asked: RunEvent[] = [];
  run.on("event", (ev: RunEvent) => {
    if (ev.type === "approval_request") {
      asked.push(ev);
      const ok = typeof opts.approve === "function" ? opts.approve(ev) : (opts.approve ?? true);
      setImmediate(() => run.respond(ev.requestId, { approved: ok, comment: ok ? undefined : "Do not create bills today." }));
    }
    if (ev.type === "question") {
      asked.push(ev);
      setImmediate(() => run.respond(ev.requestId, { answer: opts.answer ?? "yes" }));
    }
  });
  return asked;
}

const verifierPass = [
  (m: Parameters<typeof lastObservation>[0]) => {
    // The verifier must not be anchored on the worker's own criteria/memory, but does get the audit log.
    const brief = String(m[1].content);
    assert.doesNotMatch(brief, /success criteria|working memory/i);
    assert.match(brief, /Audit log[\s\S]*OK (http_request|browser_click)/);
    return { calls: [["http_request", { method: "GET", url: `${BASE}/api/bills?invoiceNumber=INV-2026-0931` }]] as [string, Record<string, unknown>][] };
  },
  (m: Parameters<typeof lastObservation>[0]) => {
    const bills = JSON.parse(lastObservation(m).split("\n").slice(1).join("\n"));
    const ok = bills.length === 1 && bills[0].amount === 12480.5 && bills[0].dueDate === "2026-11-15";
    return {
      calls: [["report_verification", { passed: ok, summary: ok ? "Bill present" : "Bill missing", checks: [{ criterion: plan.success_criteria[0], passed: ok, evidence: JSON.stringify(bills) }] }]] as [string, Record<string, unknown>][],
    };
  },
];

test("invoice → ERP via API: recovers from 503 without duplicating, fixes format errors, gets verified", async () => {
  const llm = new ScriptedLLM(
    [
      { calls: [["update_plan", plan]] },
      { calls: [["http_request", { method: "GET", url: `${BASE}/api/emails?q=acme corp` }]] },
      { calls: [["http_request", { method: "GET", url: `${BASE}/api/attachments/att-acme-0931` }]] },
      { calls: [["remember", { key: "amount", value: "12480.50" }], ["remember", { key: "due_date", value: "2026-11-15" }]] },
      { calls: [["http_request", { method: "POST", url: `${BASE}/api/bills`, body: { vendorId: "V-001", invoiceNumber: "INV-2026-0931", amount: "12,480.50", currency: "USD", dueDate: "15 November 2026" } }]] },
      (m) => {
        assert.match(lastObservation(m), /HTTP 503[\s\S]*RECOVERY HINT/);
        // Check whether the failed attempt took effect before retrying.
        return { calls: [["http_request", { method: "GET", url: `${BASE}/api/bills?invoiceNumber=INV-2026-0931` }]] };
      },
      { calls: [["http_request", { method: "POST", url: `${BASE}/api/bills`, body: { vendorId: "V-001", invoiceNumber: "INV-2026-0931", amount: "12,480.50", currency: "USD", dueDate: "15 November 2026" } }]] },
      (m) => {
        assert.match(lastObservation(m), /HTTP 422[\s\S]*YYYY-MM-DD/);
        return { calls: [["http_request", { method: "POST", url: `${BASE}/api/bills`, body: { vendorId: "V-001", invoiceNumber: "INV-2026-0931", amount: 12480.5, currency: "USD", dueDate: "2026-11-15" } }]] };
      },
      { calls: [["finish", { outcome: "completed", summary: "Entered INV-2026-0931 as bill B-1004.", evidence: ["B-1004"] }]] },
    ],
    [...verifierPass],
  );
  const run = new Run(TASK, "risky");
  const asked = autoHuman(run);
  const result = await runTask(run, llm);

  assert.equal(result.outcome, "completed");
  assert.equal(result.verification?.passed, true);
  assert.equal(asked.filter((e) => e.type === "approval_request").length, 3, "every POST needs approval; GETs don't");
  const bills = mockco.getState().bills.filter((b) => b.invoiceNumber === "INV-2026-0931");
  assert.equal(bills.length, 1);
  assert.equal(bills[0].amount, 12480.5);
  assert.deepEqual(Object.fromEntries(run.memory), { amount: "12480.50", due_date: "2026-11-15" });
});

test("invoice → ERP via the browser UI: fills the real form, submit click is gated by approval", async () => {
  mockco.getState().failNextBillSubmit = false;
  const llm = new ScriptedLLM(
    [
      { calls: [["update_plan", plan]] },
      { calls: [["browser_open", { url: `${BASE}/erp/bills/new` }]] },
      (m) => {
        const obs = lastObservation(m);
        const ref = (label: string) => Number(obs.match(new RegExp(`\\[(\\d+)\\] \\w+ "${label}"`))![1]);
        return {
          calls: [
            ["browser_fill", { ref: ref("Vendor"), value: "Acme Corp" }],
            ["browser_fill", { ref: ref("Invoice number"), value: "INV-2026-0931" }],
            ["browser_fill", { ref: ref("Amount"), value: "12480.50" }],
            ["browser_fill", { ref: ref("Due date"), value: "2026-11-15" }],
            ["browser_click", { ref: Number(obs.match(/\[(\d+)\] button "Save bill"/)![1]) }],
          ],
        };
      },
      (m) => {
        assert.match(lastObservation(m), /Bill B-1004 was created successfully/);
        return { calls: [["finish", { outcome: "completed", summary: "Created B-1004", evidence: ["B-1004"] }]] };
      },
    ],
    [...verifierPass],
  );
  const run = new Run(TASK, "risky");
  const asked = autoHuman(run);
  const result = await runTask(run, llm);

  assert.equal(result.outcome, "completed");
  const approvals = asked.filter((e): e is Extract<RunEvent, { type: "approval_request" }> => e.type === "approval_request");
  assert.equal(approvals.length, 1, "only the form submission needs approval, not navigation or typing");
  assert.match(approvals[0].reason, /POST form/);
  assert.match(approvals[0].reason, /Vendor: Acme Corp/, "approval shows the values being submitted");
  assert.match(approvals[0].reason, /Amount: 12480.50/);
  const shots = run.events.filter((e) => e.type === "tool_result" && e.screenshot);
  assert.ok(shots.length >= 2, "browser actions leave screenshot evidence");
});

test("a rejected approval is respected: nothing is created and the worker reports it", async () => {
  const llm = new ScriptedLLM([
    { calls: [["update_plan", plan]] },
    { calls: [["http_request", { method: "POST", url: `${BASE}/api/bills`, body: { vendorId: "V-001", invoiceNumber: "X-1", amount: 1, dueDate: "2026-11-15" } }]] },
    (m) => {
      assert.match(lastObservation(m), /REJECTED.*Do not create bills today/);
      return { calls: [["finish", { outcome: "needs_user", summary: "You rejected creating the bill, so I stopped." }]] };
    },
  ]);
  const run = new Run(TASK, "risky");
  autoHuman(run, { approve: false });
  const result = await runTask(run, llm);
  assert.equal(result.outcome, "needs_user");
  assert.equal(mockco.getState().bills.length, 3);
});

test("ask_user pauses the run and feeds the answer back", async () => {
  const llm = new ScriptedLLM([
    { calls: [["ask_user", { question: "Did you mean Acme Corp or Acme Logistics?" }]] },
    (m) => {
      assert.match(lastObservation(m), /User answered: Acme Logistics/);
      return { calls: [["finish", { outcome: "failed", summary: "stop here for the test" }]] };
    },
  ]);
  const run = new Run("Enter the latest invoice from Acme", "risky");
  autoHuman(run, { answer: "Acme Logistics" });
  const result = await runTask(run, llm);
  assert.equal(result.outcome, "failed");
});

test("loop guard: repeating a failing action triggers a recovery hint", async () => {
  const bad = { calls: [["browser_click", { ref: 999 }]] as [string, Record<string, unknown>][] };
  const llm = new ScriptedLLM([
    { calls: [["browser_open", { url: `${BASE}/mail` }]] },
    bad,
    bad,
    bad,
    (m) => {
      assert.match(String(m[m.length - 1].content), /same call|last 3 actions failed/);
      return { calls: [["finish", { outcome: "failed", summary: "gave up" }]] };
    },
  ]);
  const run = new Run("click around", "never");
  await runTask(run, llm);
  assert.ok(run.events.some((e) => e.type === "recovery"));
});

test("false completion claims are caught by the verifier and sent back; second failure → unverified", async () => {
  const fail = (m: Parameters<typeof lastObservation>[0]) => ({
    calls: [["report_verification", { passed: false, summary: "No bill found", checks: [{ criterion: "bill exists", passed: false, evidence: lastObservation(m) }] }]] as [string, Record<string, unknown>][],
  });
  const look = { calls: [["http_request", { method: "GET", url: `${BASE}/api/bills?invoiceNumber=INV-2026-0931` }]] as [string, Record<string, unknown>][] };
  const llm = new ScriptedLLM(
    [
      { calls: [["update_plan", plan]] },
      { calls: [["finish", { outcome: "completed", summary: "Done! (not really)" }]] },
      (m) => {
        assert.match(String(m[m.length - 1].content), /NOT complete/);
        return { calls: [["finish", { outcome: "completed", summary: "Done, honestly (still not)" }]] };
      },
    ],
    [look, fail, look, fail],
  );
  const run = new Run(TASK, "never");
  const result = await runTask(run, llm);
  assert.equal(result.outcome, "unverified");
  assert.equal(run.events.filter((e) => e.type === "verification").length, 2);
});

test("verifier is read-only: it cannot POST or submit forms", async () => {
  const llm = new ScriptedLLM(
    [{ calls: [["finish", { outcome: "completed", summary: "claim" }]] }],
    [
      { calls: [["http_request", { method: "POST", url: `${BASE}/api/bills`, body: {} }]] },
      (m) => {
        assert.match(lastObservation(m), /read-only|Blocked/);
        return { calls: [["report_verification", { passed: false, summary: "nothing", checks: [{ criterion: "x", passed: false, evidence: "-" }] }]] };
      },
    ],
  );
  // Only one verification round is scripted; the worker's second turn exhausts its script → run fails cleanly.
  const run = new Run(TASK, "never");
  const result = await runTask(run, llm);
  assert.equal(mockco.getState().bills.length, 3);
  assert.equal(result.outcome, "failed");
});

test("environment boundary: external URLs are blocked", async () => {
  const llm = new ScriptedLLM([
    { calls: [["browser_open", { url: "https://example.com" }], ["http_request", { method: "GET", url: "https://api.github.com" }]] },
    (m) => {
      assert.match(lastObservation(m), /Blocked/);
      return { calls: [["finish", { outcome: "failed", summary: "blocked" }]] };
    },
  ]);
  const run = new Run("visit the internet", "never");
  await runTask(run, llm);
  const results = run.events.filter((e) => e.type === "tool_result" && e.name !== "finish");
  assert.equal(results.length, 2);
  assert.ok(results.every((e) => e.type === "tool_result" && !e.ok));
});

test("a finish written as plain JSON text is still recognised", async () => {
  const llm = new ScriptedLLM([
    { say: 'Done.\n```json\n{"outcome":"failed","summary":"Could not find the invoice."}\n```', calls: [] },
  ]);
  const run = new Run("find something", "never");
  const result = await runTask(run, llm);
  assert.equal(result.outcome, "failed");
  assert.equal(result.summary, "Could not find the invoice.");
  assert.equal(result.steps, 1, "no extra nudge turn");
});

test("the first turn forces update_plan via tool_choice", async () => {
  const seen: (string | undefined)[] = [];
  const llm = new ScriptedLLM([{ calls: [["update_plan", plan]] }, { calls: [["finish", { outcome: "failed", summary: "x" }]] }]);
  const spy = { chat: (m: any, t: any, o?: { forceTool?: string }) => (seen.push(o?.forceTool), llm.chat(m)) };
  await runTask(new Run("t", "never"), spy);
  assert.deepEqual(seen, ["update_plan", undefined]);
});

test("snapshot truncation keeps buttons and alerts even at the bottom of a long page", () => {
  const filler = Array.from({ length: 200 }, (_, i) => `| row ${i} | some long static table text here |`).join("\n");
  const page = `# Bills\n${filler}\n[ALERT] Bill not saved: amount invalid\n[301] button "Save bill"`;
  const out = truncateSnapshot(page, 1500);
  assert.ok(out.length <= 1600);
  assert.match(out, /\[301\] button "Save bill"/);
  assert.match(out, /\[ALERT\] Bill not saved/);
  assert.match(out, /^# Bills/);
  assert.match(out, /lines of page text omitted/);
});
