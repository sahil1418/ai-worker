import type { ChatMessage, LLM } from "./llm.js";
import type { Run } from "./run.js";
import { dispatch, parseArgs } from "./dispatch.js";
import { compactHistory, nextMove } from "./loop.js";
import { verifierSystemPrompt } from "./prompts.js";
import { browserTools } from "./tools/browser.js";
import { fileTools } from "./tools/files.js";
import { httpTool } from "./tools/http.js";
import type { Tool, VerificationResult } from "./types.js";

const MAX_VERIFIER_STEPS = 15;

/**
 * Independent verification: a separate model conversation with read-only tools and a fresh
 * browser session checks the real system state against the success criteria. The worker's
 * own claims are treated as hypotheses, not facts.
 */
export async function verify(
  llm: LLM,
  run: Run,
  environment: string,
  claim: { summary: string; evidence: string[] },
  round: number,
): Promise<VerificationResult> {
  let report: VerificationResult | undefined;

  const reportTool: Tool = {
    name: "report_verification",
    description: "Submit the verification verdict. passed=true only if every check passed.",
    parameters: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        checks: {
          type: "array",
          items: {
            type: "object",
            properties: { criterion: { type: "string" }, passed: { type: "boolean" }, evidence: { type: "string" } },
            required: ["criterion", "passed", "evidence"],
          },
        },
        summary: { type: "string" },
      },
      required: ["passed", "checks", "summary"],
    },
    async execute(args: VerificationResult) {
      const checks = Array.isArray(args.checks) ? args.checks : [];
      // Never let the verdict contradict its own checks.
      report = { passed: !!args.passed && checks.length > 0 && checks.every((c) => c.passed), checks, summary: String(args.summary ?? "") };
      return { ok: true, output: "Verification recorded." };
    },
  };

  const tools = [...browserTools("verifier", { readOnly: true }), httpTool({ readOnly: true }), ...fileTools({ readOnly: true }), reportTool];
  // Deliberately NOT passed: the worker's plan/success criteria and memory. A worker that misread the task
  // (e.g. picked the wrong invoice) would write criteria that its wrong result satisfies; the verifier must
  // derive what "done" means from the user's words alone.
  const audit = run.mutations.length
    ? run.mutations.map((m) => `- ${m.ok ? "OK" : "FAILED"} ${m.tool} ${JSON.stringify(m.args)} → ${m.outcome}`).join("\n")
    : "(none recorded)";
  const messages: ChatMessage[] = [
    { role: "system", content: verifierSystemPrompt(environment) },
    {
      role: "user",
      content: `User's original request:\n"""${run.task}"""\n\nWorker's claimed result (unverified):\n${claim.summary}\nEvidence claimed:\n${claim.evidence.map((e) => `- ${e}`).join("\n") || "(none)"}\n\nAudit log of state-changing actions the worker executed (use it to know where to look; it does not prove the final state):\n${audit}\n\nVerify now.`,
    },
  ];

  run.emitEvent({ type: "status", status: "verifying", detail: `Verification round ${round}` }, "verifier");
  for (let step = 0; step < MAX_VERIFIER_STEPS && !report && !run.cancelled; step++) {
    compactHistory(messages);
    const res = await nextMove(llm, run, messages, tools, "verifier");
    if (res.content?.trim()) run.emitEvent({ type: "thought", text: res.content.trim() }, "verifier");
    if (!res.toolCalls.length) {
      messages.push({ role: "assistant", content: res.content ?? "" });
      messages.push({ role: "user", content: "Use the read-only tools to check, then call report_verification." });
      continue;
    }
    messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      let args: Record<string, unknown>;
      try {
        args = parseArgs(call.function.arguments);
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Error: arguments were not valid JSON." });
        continue;
      }
      const result = await dispatch(run, tools, call.id, call.function.name, args, "verifier");
      messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
    }
  }

  return report ?? { passed: false, checks: [], summary: "The verifier could not reach a verdict within its step budget." };
}
