import { config } from "../../config.js";
import type { Tool } from "../types.js";

/** The agent may only reach the simulated company environment — never real third-party systems. */
export function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const extra = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return u.origin === `http://localhost:${config.mockcoPort}` || u.origin === `http://127.0.0.1:${config.mockcoPort}` || extra.includes(u.origin);
  } catch {
    return false;
  }
}

const BODY_LIMIT = 4000;

export function httpTool(opts: { readOnly?: boolean } = {}): Tool {
  return {
    name: "http_request",
    description: opts.readOnly
      ? "Make a GET request to an internal JSON API and return status + body."
      : "Call an internal JSON API. method GET/POST/PATCH/DELETE, optional JSON body. Returns status + response body.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", enum: opts.readOnly ? ["GET"] : ["GET", "POST", "PATCH", "DELETE"] },
        url: { type: "string" },
        body: { type: "object", description: "JSON body for POST/PATCH" },
      },
      required: ["method", "url"],
    },
    assessRisk: ({ method, url }: { method: string; url: string }) =>
      String(method).toUpperCase() === "GET"
        ? { level: "none", reason: "read-only request" }
        : { level: "risky", reason: `${String(method).toUpperCase()} ${url} changes data in a company system.` },
    async execute({ method, url, body }: { method: string; url: string; body?: unknown }) {
      method = String(method ?? "GET").toUpperCase();
      if (!isAllowedUrl(url)) return { ok: false, output: `Blocked: ${url} is outside the allowed environment.` };
      if (opts.readOnly && method !== "GET") return { ok: false, output: "Blocked: read-only mode allows GET only." };
      try {
        const res = await fetch(url, {
          method,
          headers: body !== undefined ? { "content-type": "application/json" } : {},
          body: body !== undefined && method !== "GET" ? JSON.stringify(typeof body === "string" ? JSON.parse(body) : body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        let text = await res.text();
        if (text.length > BODY_LIMIT) text = text.slice(0, BODY_LIMIT) + "…(truncated)";
        return { ok: res.ok, output: `HTTP ${res.status}\n${text}` };
      } catch (e) {
        return { ok: false, output: `Request failed: ${(e as Error).message}` };
      }
    },
  };
}
