import type { ToolSpec } from "./llm.js";
import type { Actor, Run } from "./run.js";
import type { RiskAssessment, Tool, ToolResult } from "./types.js";

export const toSpecs = (tools: Tool[]): ToolSpec[] =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

function needsApproval(run: Run, risk: RiskAssessment): boolean {
  if (run.approvalMode === "never") return false;
  if (run.approvalMode === "always") return risk.level !== "none";
  return risk.level === "risky";
}

/** A failed write whose effect is unknown: server error or timeout (validation errors are unambiguous). */
const AMBIGUOUS_FAILURE = /HTTP (status: )?5\d\d|timeout|timed out|ECONNRESET|socket hang up/i;
const RECOVERY_HINT =
  "[RECOVERY HINT] This change failed in a way that does not prove it was not applied. Before retrying, check the target system (e.g. GET or search for the record) to confirm whether it took effect, so you don't create a duplicate.";

/**
 * Executes one tool call with the safety gate in front of it:
 * assess risk → (maybe) ask a human → run → emit events. Exceptions become failed observations
 * so the model can react to them instead of crashing the run.
 */
export async function dispatch(run: Run, tools: Tool[], callId: string, name: string, args: Record<string, unknown>, actor: Actor): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  run.emitEvent({ type: "tool_call", callId, name, args }, actor);
  let result: ToolResult;
  if (!tool) {
    result = { ok: false, output: `Unknown tool "${name}". Available: ${tools.map((t) => t.name).join(", ")}` };
  } else {
    try {
      const risk = tool.assessRisk ? await tool.assessRisk(args, run) : { level: "none" as const, reason: "" };
      let note = "";
      const decision: { approved: boolean; comment?: string } = needsApproval(run, risk) ? await run.requestApproval(callId, name, args, risk.reason, actor) : { approved: true };
      if (!decision.approved) {
        result = {
          ok: false,
          output: `The user REJECTED this action${decision.comment ? ` with comment: "${decision.comment}"` : ""}. It was not performed. Respect this decision: adjust your approach, ask the user, or finish.`,
        };
      } else {
        if (decision.comment) note = `\n(User approved with comment: "${decision.comment}")`;
        result = await tool.execute(args, run);
        if (risk.level === "risky" && !result.ok && AMBIGUOUS_FAILURE.test(result.output)) note += `\n${RECOVERY_HINT}`;
        result = { ...result, output: result.output + note };
        if (risk.level !== "none") {
          // Audit log of attempted state changes: handed to the verifier so it knows what to inspect.
          run.mutations.push({ tool: name, args, reason: risk.reason, ok: result.ok, outcome: result.output.split("\n").slice(0, 2).join(" ").slice(0, 300) });
        }
      }
    } catch (e) {
      result = { ok: false, output: `Tool crashed: ${(e as Error).message}` };
    }
  }
  run.emitEvent({ type: "tool_result", callId, name, ok: result.ok, output: result.output, screenshot: result.screenshot }, actor);
  return result;
}

/** Parse model-produced JSON arguments leniently (models sometimes wrap them in code fences). */
export function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const parsed = JSON.parse(cleaned);
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}
