import { ToolFormatError, type ChatMessage, type ChatResponse, type LLM } from "./llm.js";
import type { Actor, Run } from "./run.js";
import { toSpecs } from "./dispatch.js";
import type { Tool } from "./types.js";

/** Ask the model for its next move, recovering from malformed tool calls by re-prompting. */
export async function nextMove(llm: LLM, run: Run, messages: ChatMessage[], tools: Tool[], actor: Actor, forceTool?: string): Promise<ChatResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const onWait = (msg: string) => run.emitEvent({ type: "status", status: "waiting_llm", detail: msg }, actor);
      return await llm.chat(messages, toSpecs(tools), { onWait, forceTool });
    } catch (e) {
      if (!(e instanceof ToolFormatError) || attempt >= 2) throw e;
      // Some models (e.g. gpt-oss on Groq) garble output when a specific tool is forced; retry unforced.
      forceTool = undefined;
      run.emitEvent({ type: "recovery", text: "Model produced a malformed tool call; asking it to retry." }, actor);
      messages.push({
        role: "user",
        content: "Your last tool call was malformed and could not be parsed. Call one of the available tools again with valid JSON arguments.",
      });
    }
  }
}

/**
 * Keep the context small: old observations (page snapshots, API bodies) are trimmed once newer ones
 * exist. Facts that matter are expected to be in working memory, which is re-rendered each turn.
 */
export function compactHistory(messages: ChatMessage[], keepFull = 3, trimTo = 400) {
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  for (const i of toolIdx.slice(0, -keepFull)) {
    const m = messages[i] as Extract<ChatMessage, { role: "tool" }>;
    if (m.content.length > trimTo + 80) m.content = m.content.slice(0, trimTo) + "\n…[older observation trimmed]";
  }
}

/** Detects the agent going round in circles (same call repeated) or failing repeatedly. */
export class LoopGuard {
  private recent: string[] = [];
  private consecutiveFailures = 0;

  record(name: string, args: unknown, ok: boolean): string | null {
    const sig = `${name}:${JSON.stringify(args)}`;
    this.recent = [...this.recent, sig].slice(-8);
    this.consecutiveFailures = ok ? 0 : this.consecutiveFailures + 1;
    if (this.recent.filter((s) => s === sig).length >= 3)
      return `You have made the same call (${name}) 3 times recently. It is not making progress. Step back: re-read the current state, try a different approach (e.g. the API instead of the UI, or vice versa), or ask the user.`;
    if (this.consecutiveFailures >= 3) {
      this.consecutiveFailures = 0;
      return "The last 3 actions failed. Stop and reconsider: re-check the current state, read the error messages carefully, try an alternative route, or ask the user if you are blocked.";
    }
    return null;
  }
}
