import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import type { Tool } from "../types.js";

/** Resolve a user/model-supplied path inside the workspace sandbox, rejecting escapes. */
export function resolveInWorkspace(p: string): string {
  const rel = String(p ?? "").replace(/^[/\\]+/, "").replace(/^workspace[/\\]/, "");
  const abs = path.resolve(config.workspaceDir, rel);
  if (abs !== config.workspaceDir && !abs.startsWith(config.workspaceDir + path.sep)) throw new Error(`Path "${p}" is outside the workspace.`);
  return abs;
}

const READ_LIMIT = 6000;

export function fileTools(opts: { readOnly?: boolean } = {}): Tool[] {
  const tools: Tool[] = [
    {
      name: "list_files",
      description: "List files in a workspace directory (the shared drive). Path is relative to the workspace root, e.g. 'shared/finance'.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      async execute({ path: p = "" }: { path?: string }) {
        try {
          const dir = resolveInWorkspace(p);
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const lines = await Promise.all(
            entries.map(async (e) => (e.isDirectory() ? `${e.name}/` : `${e.name}  (${(await fs.stat(path.join(dir, e.name))).size} bytes)`)),
          );
          return { ok: true, output: lines.length ? lines.join("\n") : "(empty)" };
        } catch (e) {
          return { ok: false, output: `Error: ${(e as Error).message}` };
        }
      },
    },
    {
      name: "read_file",
      description: "Read a text file (txt, md, csv, json) from the workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute({ path: p }: { path: string }) {
        try {
          let text = await fs.readFile(resolveInWorkspace(p), "utf8");
          if (text.length > READ_LIMIT) text = text.slice(0, READ_LIMIT) + "\n…(truncated)";
          return { ok: true, output: text };
        } catch (e) {
          return { ok: false, output: `Error: ${(e as Error).message}` };
        }
      },
    },
  ];
  if (!opts.readOnly) {
    tools.push({
      name: "write_file",
      description: "Create or overwrite a text file in the workspace (e.g. a report under 'output/').",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      assessRisk: ({ path: p }: { path: string }) => ({ level: "write", reason: `Writes workspace file ${p}` }),
      async execute({ path: p, content }: { path: string; content: string }) {
        try {
          const abs = resolveInWorkspace(p);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, String(content ?? ""), "utf8");
          return { ok: true, output: `Wrote ${Buffer.byteLength(String(content ?? ""))} bytes to ${path.relative(config.workspaceDir, abs).replace(/\\/g, "/")}` };
        } catch (e) {
          return { ok: false, output: `Error: ${(e as Error).message}` };
        }
      },
    });
  }
  return tools;
}
