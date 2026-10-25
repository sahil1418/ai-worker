import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config, mockcoUrl, ROOT } from "../config.js";
import { createMockco } from "../mockco/app.js";
import { Run, runTask } from "../agent/worker.js";
import type { ApprovalMode } from "../config.js";
import type { RunEvent } from "../agent/types.js";

// The simulated company runs in the same process for convenience; it is a separate app on its own port.
const mockco = createMockco({ chaos: config.chaos });
mockco.app.listen(config.mockcoPort, () => console.log(`Northwind Ops (mock company) → ${mockcoUrl()}  chaos=${config.chaos}`));

const runs = new Map<string, Run>();
const app = express();

// Serve the mock company's UI through this same port too, so a hosted deployment needs only one public
// port. The agent itself still talks to the mock company on its own internal port.
app.use((req, res, next) => {
  if (!/^\/(mail|erp|chat)(\/|$)/.test(req.path)) return next();
  if ((config.publicDemo || config.demoPassword) && req.method !== "GET")
    return void res.status(403).send("The company apps are read-only for visitors of the public demo. Ask the AI worker to make changes.");
  mockco.app(req, res, next);
});

app.use(express.json());

/** Hosted demo: everything is viewable, but anything that spends LLM quota or changes state needs the password. */
function requirePassword(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!config.demoPassword) return next();
  const given = Buffer.from(String(req.get("x-demo-password") ?? ""));
  const expected = Buffer.from(config.demoPassword);
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
  res.status(401).json({ error: "Demo password required." });
}
app.use(express.static(path.join(ROOT, "public")));
app.use("/runs", express.static(config.runsDir));

app.get("/api/config", (_req, res) => {
  res.json({
    model: config.llm.model,
    llmHost: new URL(config.llm.baseUrl).host,
    hasApiKey: config.llm.apiKeys.length > 0 || /localhost|127\.0\.0\.1/.test(config.llm.baseUrl),
    approvalMode: config.approvalMode,
    mockcoUrl: "/mail",
    passwordRequired: !!config.demoPassword,
    maxSteps: config.maxSteps,
  });
});

/** Runs from this process plus finished runs persisted on disk by earlier processes. */
function listRuns() {
  const live = [...runs.values()].map((r) => ({ id: r.id, task: r.task, status: r.status, outcome: r.result?.outcome }));
  const onDisk = fs.existsSync(config.runsDir)
    ? fs
        .readdirSync(config.runsDir)
        .filter((id) => !runs.has(id) && fs.existsSync(path.join(config.runsDir, id, "task.json")))
        .map((id) => {
          const meta = JSON.parse(fs.readFileSync(path.join(config.runsDir, id, "task.json"), "utf8"));
          const resultFile = path.join(config.runsDir, id, "result.json");
          const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : undefined;
          return { id, task: meta.task as string, status: "done", outcome: result?.outcome ?? "interrupted" };
        })
    : [];
  return [...live, ...onDisk].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 30);
}

app.get("/api/tasks", (_req, res) => res.json(listRuns()));

app.post("/api/tasks", requirePassword, (req, res) => {
  const task = String(req.body?.task ?? "").trim();
  if (!task) return void res.status(400).json({ error: "task is required" });
  if (task.length > 2000) return void res.status(400).json({ error: "task is too long (max 2000 characters)" });
  const active = [...runs.values()].filter((r) => r.status !== "done").length;
  if (config.maxConcurrentRuns && active >= config.maxConcurrentRuns)
    return void res.status(409).json({ error: "Another run is in progress. Watch it in the Runs list, or wait for it to finish." });
  const mode = (["risky", "always", "never"].includes(req.body?.approvalMode) ? req.body.approvalMode : config.approvalMode) as ApprovalMode;
  const run = new Run(task, mode);
  runs.set(run.id, run);
  runTask(run).catch((e) => console.error("run crashed", e));
  res.status(201).json({ id: run.id });
});

function readEventsFromDisk(id: string): RunEvent[] {
  const file = path.join(config.runsDir, path.basename(id), "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

app.get("/api/tasks/:id/stream", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (ev: RunEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const run = runs.get(req.params.id);
  const metaFile = path.join(config.runsDir, path.basename(req.params.id), "task.json");
  const task = run?.task ?? (fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")).task : "(unknown run)");
  res.write(`event: meta\ndata: ${JSON.stringify({ task })}\n\n`);
  if (!run) {
    readEventsFromDisk(req.params.id).forEach(send);
    res.write("event: end\ndata: {}\n\n");
    return void res.end();
  }
  run.events.forEach(send);
  const onEvent = (ev: RunEvent) => send(ev);
  run.on("event", onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    run.off("event", onEvent);
  });
});

app.post("/api/tasks/:id/respond", requirePassword, (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return void res.status(404).json({ error: "run not found or already finished" });
  const { requestId, approved, comment, answer } = req.body ?? {};
  run.respond(String(requestId), { approved, comment, answer }) ? res.json({ ok: true }) : res.status(409).json({ error: "no such pending request" });
});

app.post("/api/tasks/:id/cancel", requirePassword, (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return void res.status(404).json({ error: "run not found" });
  run.cancel();
  res.json({ ok: true });
});

app.post("/api/environment/reset", requirePassword, (_req, res) => {
  mockco.reset();
  const out = path.join(config.workspaceDir, "output");
  for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f !== ".gitkeep") fs.rmSync(path.join(out, f), { recursive: true, force: true });
  res.json({ ok: true });
});

app.listen(config.agentPort, () => {
  if (config.demoPassword) console.log("Demo mode: password required for runs, approvals and reset.");
  console.log(`AI Task Worker UI → http://localhost:${config.agentPort}`);
  console.log(`LLM: ${config.llm.model} @ ${config.llm.baseUrl}${config.llm.apiKeys.length ? ` (${config.llm.apiKeys.length} key${config.llm.apiKeys.length > 1 ? "s, round-robin" : ""})` : "  (no LLM_API_KEY set!)"}`);
});
