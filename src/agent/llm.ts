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
 * Pool of API keys used round-robin. A key that hits a rate limit is put on cooldown for the time the
 * provider asks for, and the next available key is used immediately; a key rejected with 401 is dropped.
 * Only helps when keys have separate quotas (provider limits are usually per organisation, not per key).
 * Keys are identified as "key #n" in messages, never printed.
 */
export class KeyPool {
  private coolUntil: number[];
  private dead: boolean[];
  private cursor = 0;

  constructor(private keys: string[]) {
    if (!keys.length) this.keys = [""];
    this.coolUntil = this.keys.map(() => 0);
    this.dead = this.keys.map(() => false);
  }

  get size() {
    return this.keys.length;
  }

  /** Next live key in round-robin order that is not cooling down, else the one that frees up soonest. */
  acquire(now = Date.now()): { index: number; key: string; waitMs: number } {
    const live = this.keys.map((_, i) => i).filter((i) => !this.dead[i]);
    if (!live.length) throw new Error("All LLM API keys were rejected (401). Check LLM_API_KEY in .env.");
    for (let n = 0; n < this.keys.length; n++) {
      const i = (this.cursor + n) % this.keys.length;
      if (!this.dead[i] && this.coolUntil[i] <= now) {
        this.cursor = (i + 1) % this.keys.length;
        return { index: i, key: this.keys[i], waitMs: 0 };
      }
    }
    const i = live.reduce((a, b) => (this.coolUntil[b] < this.coolUntil[a] ? b : a));
    this.cursor = (i + 1) % this.keys.length;
    return { index: i, key: this.keys[i], waitMs: this.coolUntil[i] - now };
  }

  cooldown(index: number, ms: number, now = Date.now()) {
    this.coolUntil[index] = Math.max(this.coolUntil[index], now + ms);
  }

  /** Returns true if other live keys remain. */
  kill(index: number): boolean {
    this.dead[index] = true;
    return this.dead.some((d) => !d);
  }
}

export class OpenAICompatibleLLM implements LLM {
  private pool: KeyPool;

  constructor(
    private baseUrl = config.llm.baseUrl,
    apiKeys: string[] = config.llm.apiKeys,
    private model = config.llm.model,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.pool = new KeyPool(apiKeys);
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], { onWait, forceTool }: ChatOptions = {}): Promise<ChatResponse> {
    // Each key gets a fair number of rate-limit retries before we give up.
    const maxAttempts = 6 * this.pool.size;
    const tool_choice = forceTool ? { type: "function", function: { name: forceTool } } : "auto";
    const label = (i: number) => (this.pool.size > 1 ? ` (key #${i + 1})` : "");
    let networkErrors = 0;
    for (let attempt = 0; ; attempt++) {
      const { index, key, waitMs } = this.pool.acquire();
      if (waitMs > 0) {
        onWait?.(`Rate limited${this.pool.size > 1 ? " on all keys" : " by LLM provider"}; waiting ${(waitMs / 1000).toFixed(1)}s`);
        await sleep(waitMs);
      }
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key || "none"}` },
          body: JSON.stringify({ model: this.model, messages, tools, tool_choice, temperature: 0.2 }),
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
        if (this.pool.kill(index)) {
          onWait?.(`LLM key #${index + 1} was rejected (401); dropping it and using the next key`);
          continue;
        }
        throw new Error(`LLM auth failed (401). Set LLM_API_KEY in .env. ${body.slice(0, 200)}`);
      }
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt >= maxAttempts - 1) throw new Error(`LLM request failed: HTTP ${res.status} ${body.slice(0, 400)}`);
      const delay = retryDelayMs(res, body, attempt % 6);
      if (res.status === 429) {
        // Park this key; the next acquire() moves on to another key right away if one is free.
        this.pool.cooldown(index, delay);
        if (this.pool.size > 1) onWait?.(`Rate limited${label(index)}; switching key`);
      } else {
        onWait?.(`LLM provider error ${res.status}${label(index)}; waiting ${(delay / 1000).toFixed(1)}s`);
        await sleep(delay);
      }
    }
  }
}
