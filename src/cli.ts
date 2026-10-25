import readline from "node:readline/promises";
import { config, mockcoUrl } from "./config.js";
import { createMockco } from "./mockco/app.js";
import { Run, runTask } from "./agent/worker.js";
import { closeSharedBrowser } from "./agent/tools/browser.js";
import type { RunEvent } from "./agent/types.js";

/** Terminal front-end: `npm run task -- "your task"`. Approvals and questions are answered inline. */
async function main() {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    console.error('Usage: npm run task -- "Find the latest invoice from Acme Corp and enter it into billing"');
    process.exit(1);
  }

  // Reuse a running mock company (e.g. from `npm start`) or start one in-process.
  let server: { close(): void } | undefined;
  const up = await fetch(`${mockcoUrl()}/api`).then((r) => r.ok, () => false);
  if (!up) server = createMockco({ chaos: config.chaos }).app.listen(config.mockcoPort);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const run = new Run(task);
  const c = { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", magenta: "\x1b[35m", bold: "\x1b[1m", reset: "\x1b[0m" };
  const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);

  run.on("event", async (ev: RunEvent) => {
    const who = ev.actor === "verifier" ? `${c.magenta}[verifier]${c.reset} ` : "";
    switch (ev.type) {
      case "status":
        console.log(`${c.dim}${ev.detail ?? ev.status}${c.reset}`);
        break;
      case "thought":
        console.log(`${who}${c.dim}💭 ${clip(ev.text)}${c.reset}`);
        break;
      case "plan":
        console.log(`${c.bold}📋 ${ev.plan.goal}${c.reset}\n${ev.plan.steps.map((s, i) => `   ${i + 1}. [${s.status}] ${s.text}`).join("\n")}`);
        break;
      case "tool_call":
        if (!["update_plan", "remember"].includes(ev.name)) console.log(`${who}→ ${ev.name} ${clip(JSON.stringify(ev.args), 200)}`);
        break;
      case "tool_result":
        if (!["update_plan", "remember", "finish"].includes(ev.name))
          console.log(`${ev.ok ? c.green + "  ✓" : c.red + "  ✗"} ${c.dim}${clip(ev.output.replace(/\s+/g, " "), 200)}${c.reset}`);
        break;
      case "memory":
        console.log(`${c.dim}  🧠 ${ev.key} = ${ev.value}${c.reset}`);
        break;
      case "recovery":
        console.log(`${c.yellow}↻ ${ev.text}${c.reset}`);
        break;
      case "approval_request": {
        console.log(`\n${c.yellow}${c.bold}Approval needed:${c.reset} ${ev.name} ${JSON.stringify(ev.args)}\n  ${ev.reason}`);
        const a = (await rl.question("Approve? [y/N, or type a comment to reject] ")).trim();
        run.respond(ev.requestId, /^y(es)?$/i.test(a) ? { approved: true } : { approved: false, comment: a && !/^n(o)?$/i.test(a) ? a : undefined });
        break;
      }
      case "question": {
        console.log(`\n${c.yellow}${c.bold}❓ ${ev.question}${c.reset}`);
        run.respond(ev.requestId, { answer: await rl.question("> ") });
        break;
      }
      case "verification":
        console.log(`${c.magenta}🔎 Verification round ${ev.round}: ${ev.result.passed ? "PASSED" : "FAILED"} — ${ev.result.summary}${c.reset}`);
        for (const ch of ev.result.checks) console.log(`   ${ch.passed ? "✅" : "❌"} ${ch.criterion} — ${c.dim}${ch.evidence}${c.reset}`);
        break;
      case "error":
        console.log(`${c.red}⚠ ${ev.message}${c.reset}`);
        break;
    }
  });

  const result = await runTask(run);
  console.log(`\n${c.bold}=== ${result.outcome.toUpperCase()} (${result.steps} steps, ${(result.durationMs / 1000).toFixed(0)}s) ===${c.reset}\n${result.summary}`);
  for (const e of result.evidence) console.log(`  • ${e}`);
  console.log(`${c.dim}Trace and screenshots: ${run.dir}${c.reset}`);
  rl.close();
  server?.close();
  await closeSharedBrowser();
  // Let the event loop drain instead of process.exit(), which races stdin teardown on Windows.
  process.exitCode = result.outcome === "completed" ? 0 : 1;
}

main();
