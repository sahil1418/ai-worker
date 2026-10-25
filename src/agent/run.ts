import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config, type ApprovalMode } from "../config.js";
import type { FinalResult, Plan, RunEvent, RunEventBody } from "./types.js";

export type Actor = RunEvent["actor"];

type Pending =
  | { kind: "approval"; resolve: (r: { approved: boolean; comment?: string }) => void }
  | { kind: "question"; resolve: (answer: string) => void };

/**
 * One execution of one task. Owns the event log (persisted as JSONL), working memory,
 * the current plan, and any pending human interactions (approvals / questions).
 * Front-ends (web UI, CLI) subscribe to events and call respond().
 */
export class Run extends EventEmitter {
  readonly id: string;
  readonly dir: string;
  readonly events: RunEvent[] = [];
  readonly memory = new Map<string, string>();
  /** Every attempted state-changing action (risk ≠ none) that actually executed. */
  readonly mutations: { tool: string; args: unknown; reason: string; ok: boolean; outcome: string }[] = [];
  plan?: Plan;
  result?: FinalResult;
  status: "running" | "waiting" | "done" = "running";
  cancelled = false;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private shotCounter = 0;

  constructor(
    readonly task: string,
    readonly approvalMode: ApprovalMode = config.approvalMode,
  ) {
    super();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.id = `${stamp}-${randomUUID().slice(0, 6)}`;
    this.dir = path.join(config.runsDir, this.id);
    fs.mkdirSync(path.join(this.dir, "screenshots"), { recursive: true });
    fs.writeFileSync(path.join(this.dir, "task.json"), JSON.stringify({ id: this.id, task, approvalMode, startedAt: new Date().toISOString() }, null, 2));
  }

  emitEvent(body: RunEventBody, actor: Actor = "worker"): RunEvent {
    const ev = { ...body, seq: ++this.seq, at: new Date().toISOString(), actor } as RunEvent;
    this.events.push(ev);
    fs.appendFileSync(path.join(this.dir, "events.jsonl"), JSON.stringify(ev) + "\n");
    this.emit("event", ev);
    return ev;
  }

  nextScreenshotPath(label: string): { abs: string; rel: string } {
    const name = `${String(++this.shotCounter).padStart(3, "0")}-${label.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}.png`;
    return { abs: path.join(this.dir, "screenshots", name), rel: `screenshots/${name}` };
  }

  requestApproval(callId: string, name: string, args: unknown, reason: string, actor: Actor = "worker"): Promise<{ approved: boolean; comment?: string }> {
    const requestId = randomUUID().slice(0, 8);
    return new Promise((resolve) => {
      this.pending.set(requestId, { kind: "approval", resolve });
      this.status = "waiting";
      this.emitEvent({ type: "approval_request", requestId, callId, name, args, reason }, actor);
    });
  }

  askUser(question: string): Promise<string> {
    const requestId = randomUUID().slice(0, 8);
    return new Promise((resolve) => {
      this.pending.set(requestId, { kind: "question", resolve });
      this.status = "waiting";
      this.emitEvent({ type: "question", requestId, question });
    });
  }

  /** Called by a front-end to answer a pending approval or question. */
  respond(requestId: string, payload: { approved?: boolean; comment?: string; answer?: string }): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.status = this.pending.size ? "waiting" : "running";
    if (p.kind === "approval") {
      const r = { approved: !!payload.approved, comment: payload.comment?.trim() || undefined };
      this.emitEvent({ type: "approval_response", requestId, ...r }, "system");
      p.resolve(r);
    } else {
      const answer = (payload.answer ?? "").trim() || "(no answer)";
      this.emitEvent({ type: "answer", requestId, answer }, "system");
      p.resolve(answer);
    }
    return true;
  }

  pendingRequests() {
    return [...this.pending.keys()];
  }

  cancel() {
    this.cancelled = true;
    // Unblock anything waiting on a human so the loop can exit.
    for (const [id, p] of this.pending) {
      if (p.kind === "approval") this.respond(id, { approved: false, comment: "Run cancelled by user." });
      else this.respond(id, { answer: "The user cancelled the run. Stop now." });
    }
  }

  finish(result: FinalResult) {
    this.result = result;
    this.status = "done";
    fs.writeFileSync(path.join(this.dir, "result.json"), JSON.stringify(result, null, 2));
    this.emitEvent({ type: "final", result }, "system");
  }
}
