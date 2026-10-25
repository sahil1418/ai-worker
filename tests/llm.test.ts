import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LLMPool, OpenAICompatibleLLM } from "../src/agent/llm.js";

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "hi", tool_calls: [] } }] }), { status: 200 });

/** Fake fetch that records which key each request used and answers from a per-key script. */
function fakeFetch(reply: (key: string, n: number) => Response) {
  const used: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const key = String((init.headers as Record<string, string>).authorization).replace("Bearer ", "");
    used.push(key);
    return reply(key, used.length);
  }) as unknown as typeof fetch;
  return { impl, used };
}

test("keys are used round-robin", async () => {
  const f = fakeFetch(ok);
  const llm = new OpenAICompatibleLLM("http://llm", ["a", "b", "c"], ["m"], f.impl);
  for (let i = 0; i < 4; i++) await llm.chat([], []);
  assert.deepEqual(f.used, ["a", "b", "c", "a"]);
});

test("a rate-limited key is parked and the next key is used immediately, without waiting", async () => {
  const f = fakeFetch((key) => (key === "a" ? new Response("rate limit", { status: 429, headers: { "retry-after": "30" } }) : ok()));
  const llm = new OpenAICompatibleLLM("http://llm", ["a", "b"], ["m"], f.impl);
  const t0 = Date.now();
  await llm.chat([], []);
  await llm.chat([], []);
  assert.ok(Date.now() - t0 < 1000, "no 30s sleep");
  assert.deepEqual(f.used, ["a", "b", "b"], "key a stays parked during its cooldown");
});

test("a key rejected with 401 is dropped; the run continues on the others", async () => {
  const f = fakeFetch((key) => (key === "bad" ? new Response("invalid key", { status: 401 }) : ok()));
  const llm = new OpenAICompatibleLLM("http://llm", ["bad", "good"], ["m"], f.impl);
  await llm.chat([], []);
  await llm.chat([], []);
  await llm.chat([], []);
  assert.deepEqual(f.used, ["bad", "good", "good", "good"]);
});

test("a single rejected key still fails clearly", async () => {
  const f = fakeFetch(() => new Response("invalid key", { status: 401 }));
  const llm = new OpenAICompatibleLLM("http://llm", ["only"], ["m"], f.impl);
  await assert.rejects(llm.chat([], []), /401/);
});

test("when every route is cooling down, the pool waits for the one that frees up first", () => {
  const pool = new LLMPool(["a", "b"], ["m"]);
  pool.cooldown(0, 20_000, 1000);
  pool.cooldown(1, 5_000, 1000);
  const next = pool.acquire(1000);
  assert.equal(next.key, "b");
  assert.equal(next.waitMs, 5_000);
});

/** Fake fetch that also records the requested model. */
function fakeFetchModels(reply: (key: string, model: string) => Response) {
  const used: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const key = String((init.headers as Record<string, string>).authorization).replace("Bearer ", "");
    const model = JSON.parse(String(init.body)).model;
    used.push(`${key}:${model}`);
    return reply(key, model);
  }) as unknown as typeof fetch;
  return { impl, used };
}

test("fallback model is used only after every key is rate-limited on the primary model", async () => {
  const f = fakeFetchModels((_key, model) =>
    model === "big" ? new Response("Rate limit reached on tokens per day (TPD)", { status: 429, headers: { "retry-after": "600" } }) : ok(),
  );
  const llm = new OpenAICompatibleLLM("http://llm", ["a", "b"], ["big", "small"], f.impl);
  await llm.chat([], []);
  await llm.chat([], []);
  assert.deepEqual(f.used, ["a:big", "b:big", "a:small", "b:small"]);
});

test("primary model is preferred again when it has quota", async () => {
  const f = fakeFetchModels(ok);
  const llm = new OpenAICompatibleLLM("http://llm", ["a"], ["big", "small"], f.impl);
  await llm.chat([], []);
  await llm.chat([], []);
  assert.deepEqual(f.used, ["a:big", "a:big"]);
});

test("an unknown model (404) is dropped and the next model is used", async () => {
  const f = fakeFetchModels((_k, model) => (model === "gone" ? new Response('{"error":{"message":"The model `gone` does not exist"}}', { status: 404 }) : ok()));
  const llm = new OpenAICompatibleLLM("http://llm", ["a"], ["gone", "small"], f.impl);
  await llm.chat([], []);
  await llm.chat([], []);
  assert.deepEqual(f.used, ["a:gone", "a:small", "a:small"]);
});
