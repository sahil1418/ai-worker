import fs from "node:fs";
import path from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

export const ROOT = path.resolve(import.meta.dirname, "..");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Node's fetch ignores HTTP(S)_PROXY; honour it (and NO_PROXY) so the LLM is reachable behind corporate proxies.
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const env = (key: string, fallback: string) => process.env[key]?.trim() || fallback;

export type ApprovalMode = "risky" | "always" | "never";

export const config = {
  llm: {
    baseUrl: env("LLM_BASE_URL", "https://api.groq.com/openai/v1").replace(/\/$/, ""),
    /** One key, or several comma-separated keys used round-robin with rate-limit cooldowns. */
    apiKeys: env("LLM_API_KEY", "").split(",").map((k) => k.trim()).filter(Boolean),
    model: env("LLM_MODEL", "openai/gpt-oss-120b"),
  },
  approvalMode: env("APPROVAL_MODE", "risky") as ApprovalMode,
  maxSteps: Number(env("MAX_STEPS", "40")),
  headless: env("HEADLESS", "true") !== "false",
  agentPort: Number(env("AGENT_PORT", "3000")),
  mockcoPort: Number(env("MOCKCO_PORT", "4000")),
  chaos: env("MOCKCO_CHAOS", "true") !== "false",
  /** Sandbox root for the file tools. The agent cannot read or write outside it. */
  workspaceDir: path.join(ROOT, "workspace"),
  runsDir: env("RUNS_DIR", path.join(ROOT, "runs")),
};

export const mockcoUrl = () => `http://localhost:${config.mockcoPort}`;
