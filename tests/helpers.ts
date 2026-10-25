import os from "node:os";
import path from "node:path";
import type { ChatMessage, ChatResponse, LLM } from "../src/agent/llm.js";

// Isolate tests from a dev server and from real run history. Must run before src/config is imported.
process.env.MOCKCO_PORT = "4555";
process.env.RUNS_DIR = path.join(os.tmpdir(), "ai-task-worker-test-runs");
process.env.MOCKCO_CHAOS = "true";
process.env.HEADLESS = "true";

export const BASE = "http://localhost:4555";

type Call = [name: string, args: Record<string, unknown>];
type Step = { say?: string; calls: Call[] } | ((messages: ChatMessage[]) => { say?: string; calls: Call[] });

/**
 * Deterministic stand-in for the model: replays a script of tool calls for the worker and the
 * verifier. Everything else (loop, tools, approval gate, mock company) is the real code.
 */
export class ScriptedLLM implements LLM {
  private n = 0;
  constructor(
    private worker: Step[],
    private verifier: Step[] = [],
  ) {}

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const isVerifier = String(messages[0].content).startsWith("You are an independent verifier");
    const queue = isVerifier ? this.verifier : this.worker;
    const next = queue.shift();
    if (!next) throw new Error(`${isVerifier ? "verifier" : "worker"} script exhausted`);
    const step = typeof next === "function" ? next(messages) : next;
    return {
      content: step.say ?? null,
      toolCalls: step.calls.map(([name, args]) => ({ id: `call_${++this.n}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } })),
    };
  }
}

/** Last tool observation the model would see. */
export const lastObservation = (messages: ChatMessage[]) => {
  const t = [...messages].reverse().find((m) => m.role === "tool");
  return t && "content" in t ? String(t.content) : "";
};
