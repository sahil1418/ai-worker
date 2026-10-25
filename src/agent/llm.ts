import { config } from "../config.js";

/**
 * Minimal client for any OpenAI-compatible /chat/completions endpoint with tool calling
 * (Groq, Ollama, OpenRouter, vLLM, ...). No SDK: one fetch, explicit retry policy.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface ChatOptions {
  onWait?: (msg: string) => void;
  /** Force the model to call this tool (OpenAI-style tool_choice); providers that don't support it ignore it. */
  forceTool?: string;
}

export interface LLM {
  chat(messages: ChatMessage[], tools: ToolSpec[], opts?: ChatOptions): Promise<ChatResponse>;
}

/** The model produced a malformed tool call (Groq returns 400 "tool_use_failed"). Recoverable by re-prompting. */
export class ToolFormatError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(res: Response, body: string, attempt: number): number {
  const header = Number(res.headers.get("retry-after"));
  if (header > 0) return header * 1000 + 250;
  // Groq: "Please try again in 7.66s" / "in 1m3.5s"
  const m = body.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (m) return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 + 250;
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/**
 * Pool of (API key × model) routes. Models are in priority order: the first model is used, rotating
 * round-robin across all keys; only when every key is rate-limited for it does the next model take over.
 * A rate-limited route is parked for the time the provider asks for; a key rejected with 401 is dropped
 * everywhere; a model the provider doesn't know (404) is dropped for all keys.
 * Extra keys only help when they have separate quotas (limits are usually per organisation); Groq's
 * limits are also per model, so a fallback model is a legitimate source of extra quota.
 * Keys are identified as "key #n" in messages, never printed.
 */
export class LLMPool {
  private routes: { keyIndex: number; key: string; model: string; coolUntil: number; dead: boolean }[] = [];
  private cursor = new Map<string, number>();

  constructor(
    keys: string[],
    readonly models: string[],
  ) {
    const ks = keys.length ? keys : [""];
    for (const model of models) ks.forEach((key, keyIndex) => this.routes.push({ keyIndex, key, model, coolUntil: 0, dead: false }));
  }

  get keyCount() {
    return new Set(this.routes.map((r) => r.keyIndex)).size;
  }

  get size() {
    return this.routes.length;
  }

  /** Highest-priority model with a free route (round-robin across its keys), else the route that frees up soonest. */
  acquire(now = Date.now()): { route: number; key: string; keyIndex: number; model: string; waitMs: number } {
    const live = this.routes.map((r, i) => ({ r, i })).filter(({ r }) => !r.dead);
    if (!live.length) throw new Error("No usable LLM key/model left (all rejected). Check LLM_API_KEY and LLM_MODEL in .env.");
    for (const model of this.models) {
      const free = live.filter(({ r }) => r.model === model && r.coolUntil <= now);
      if (!free.length) continue;
      const c = this.cursor.get(model) ?? 0;
      const pick = free.find(({ r }) => r.keyIndex >= c) ?? free[0];
      this.cursor.set(model, pick.r.keyIndex + 1);
      return { route: pick.i, key: pick.r.key, keyIndex: pick.r.keyIndex, model, waitMs: 0 };
    }
    const soonest = live.reduce((a, b) => (b.r.coolUntil < a.r.coolUntil ? b : a));
    return { route: soonest.i, key: soonest.r.key, keyIndex: soonest.r.keyIndex, model: soonest.r.model, waitMs: soonest.r.coolUntil - now };
  }

  cooldown(route: number, ms: number, now = Date.now()) {
    this.routes[route].coolUntil = Math.max(this.routes[route].coolUntil, now + ms);
  }

  /** Drop a key (401) or a model (404) everywhere. Returns true if usable routes remain. */
  kill(what: { keyIndex: number } | { model: string }): boolean {
    for (const r of this.routes) if ("keyIndex" in what ? r.keyIndex === what.keyIndex : r.model === what.model) r.dead = true;
    return this.routes.some((r) => !r.dead);
  }
}

export class OpenAICompatibleLLM implements LLM {
  private pool: LLMPool;

  constructor(
    private baseUrl = config.llm.baseUrl,
    apiKeys: string[] = config.llm.apiKeys,
    models: string[] = config.llm.models,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.pool = new LLMPool(apiKeys, models);
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], { onWait, forceTool }: ChatOptions = {}): Promise<ChatResponse> {
    // Each route gets a fair number of rate-limit retries before we give up.
    const maxAttempts = 6 * this.pool.size;
    const tool_choice = forceTool ? { type: "function", function: { name: forceTool } } : "auto";
    const multi = this.pool.size > 1;
    const label = (keyIndex: number, model: string) =>
      multi ? ` (${this.pool.keyCount > 1 ? `key #${keyIndex + 1}, ` : ""}${model})` : "";
    let networkErrors = 0;
    let lastModel: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const { route, key, keyIndex, model, waitMs } = this.pool.acquire();
      if (waitMs > 0) {
        onWait?.(`Rate limited${multi ? " on every key/model" : " by LLM provider"}; waiting ${(waitMs / 1000).toFixed(1)}s`);
        await sleep(waitMs);
      }
      if (lastModel && model !== lastModel) onWait?.(`Switching to fallback model ${model}`);
      lastModel = model;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key || "none"}` },
          body: JSON.stringify({ model, messages, tools, tool_choice, temperature: 0.2 }),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (err) {
        if (++networkErrors >= 3) throw new Error(`LLM endpoint unreachable at ${this.baseUrl}: ${(err as Error).message}`);
        onWait?.(`LLM network error (${(err as Error).message}); retrying`);
        await sleep(1000 * 2 ** networkErrors);
        continue;
      }

      const body = await res.text();
      if (res.ok) {
        const json = JSON.parse(body);
        const msg = json.choices?.[0]?.message ?? {};
        return { content: msg.content ?? null, toolCalls: msg.tool_calls ?? [], usage: json.usage };
      }
      if (res.status === 400 && /tool_use_failed|failed to call a function|parse.*tool/i.test(body)) {
        throw new ToolFormatError(body.slice(0, 500));
      }
      if (res.status === 401) {
        if (this.pool.kill({ keyIndex })) {
          onWait?.(`LLM key #${keyIndex + 1} was rejected (401); dropping it`);
          continue;
        }
        throw new Error(`LLM auth failed (401). Set LLM_API_KEY in .env. ${body.slice(0, 200)}`);
      }
      if (res.status === 404 && /model/i.test(body)) {
        if (this.pool.kill({ model })) {
          onWait?.(`Model ${model} is not available at this provider; dropping it`);
          continue;
        }
        throw new Error(`LLM model not found: ${model}. Check LLM_MODEL. ${body.slice(0, 200)}`);
      }
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt >= maxAttempts - 1) throw new Error(`LLM request failed: HTTP ${res.status} ${body.slice(0, 400)}`);
      const delay = retryDelayMs(res, body, attempt % 6);
      if (res.status === 429) {
        // Park this route; the next acquire() moves on to another key or fallback model right away if one is free.
        this.pool.cooldown(route, delay);
        if (/per day|TPD|RPD/i.test(body))
          onWait?.(`Daily LLM quota${label(keyIndex, model)} nearly used up; the provider asks to wait ${(delay / 60000).toFixed(1)} min${multi ? "" : ". Add another key or a fallback LLM_MODEL to continue sooner"}.`);
        else if (multi) onWait?.(`Rate limited${label(keyIndex, model)}; trying the next key/model`);
      } else {
        onWait?.(`LLM provider error ${res.status}${label(keyIndex, model)}; waiting ${(delay / 1000).toFixed(1)}s`);
        await sleep(delay);
      }
    }
  }
}
