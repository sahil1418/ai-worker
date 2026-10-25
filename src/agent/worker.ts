import { config } from "../config.js";
import { OpenAICompatibleLLM, type ChatMessage, type LLM } from "./llm.js";
import { Run } from "./run.js";
import { dispatch, parseArgs } from "./dispatch.js";
import { environmentManifest } from "./environment.js";
import { compactHistory, LoopGuard, nextMove } from "./loop.js";
import { workerSystemPrompt } from "./prompts.js";
import { browserTools, closeRunBrowsers } from "./tools/browser.js";
import { fileTools } from "./tools/files.js";
import { httpTool } from "./tools/http.js";
import type { FinalResult, Outcome, Plan, Tool, VerificationResult } from "./types.js";
import { verify } from "./verifier.js";

const MAX_VERIFICATION_ROUNDS = 2;
const MAX_NUDGES = 3;

interface FinishArgs {
  outcome: "completed" | "failed" | "needs_user";
  summary: string;
  evidence?: string[];
}

/** Recognise `{"outcome": ..., "summary": ...}` written as text (optionally in a code fence). */
export function textualFinish(content: string): FinishArgs | undefined {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const obj = JSON.parse(m[0]);
    if (["completed", "failed", "needs_user"].includes(obj?.outcome) && typeof obj.summary === "string") return obj;
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** Tools that operate on the agent's own state rather than the outside world. */
function controlTools(run: Run, onFinish: (a: FinishArgs) => void): Tool[] {
  return [
    {
      name: "update_plan",
      description: "Set or revise your plan: the user's end goal, checkable success criteria, and steps with status.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string" },
          success_criteria: { type: "array", items: { type: "string" } },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "done", "failed", "skipped"] } },
              required: ["text", "status"],
            },
          },
        },
        required: ["goal", "success_criteria", "steps"],
      },
      async execute(args: Plan) {
        const plan: Plan = {
          goal: String(args.goal ?? run.plan?.goal ?? ""),
          success_criteria: Array.isArray(args.success_criteria) ? args.success_criteria.map(String) : (run.plan?.success_criteria ?? []),
          steps: Array.isArray(args.steps) ? args.steps.map((s) => ({ text: String(s.text ?? s), status: s.status ?? "pending" })) : (run.plan?.steps ?? []),
        };
        run.plan = plan;
        run.emitEvent({ type: "plan", plan });
        return { ok: true, output: "Plan saved." };
      },
    },
    {
      name: "remember",
      description: "Save a fact discovered during the task to working memory (e.g. key 'invoice_amount', value '12480.50').",
      parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
      async execute({ key, value }: { key: string; value: string }) {
        run.memory.set(String(key), String(value));
        run.emitEvent({ type: "memory", key: String(key), value: String(value) });
        return { ok: true, output: `Remembered ${key}.` };
      },
    },
    {
      name: "ask_user",
      description: "Ask the user a question and wait for the answer. Use when the request is ambiguous or you need information/permission you cannot obtain otherwise.",
      parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
      async execute({ question }: { question: string }) {
        const answer = await run.askUser(String(question));
        return { ok: true, output: `User answered: ${answer}` };
      },
    },
    {
      name: "finish",
      description: "End the task. outcome: completed | failed | needs_user. summary: concise report for the user. evidence: concrete proof (IDs, values, URLs).",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["completed", "failed", "needs_user"] },
          summary: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["outcome", "summary"],
      },
      async execute(args: FinishArgs) {
        onFinish(args);
        return { ok: true, output: "Finish requested." };
      },
    },
  ];
}

/**
 * The worker loop: plan → act → observe → remember → (recover) → finish → independent verification.
 * Returns when the task is verified, abandoned, cancelled or the step budget runs out.
 */
export async function runTask(run: Run, llm: LLM = new OpenAICompatibleLLM()): Promise<FinalResult> {
  const started = Date.now();
  const env = environmentManifest();
  let finishReq: FinishArgs | undefined;
  const tools: Tool[] = [
    ...controlTools(run, (a) => (finishReq = a)),
    ...browserTools("worker"),
    httpTool(),
    ...fileTools(),
  ];
  const messages: ChatMessage[] = [
    { role: "system", content: "" },
    { role: "user", content: `Task from the user:\n"""${run.task}"""\n\nStart by calling update_plan.` },
  ];
  const guard = new LoopGuard();
  let nudges = 0;
  let verificationRounds = 0;
  let lastVerification: VerificationResult | undefined;
  let step = 0;

  const done = (outcome: Outcome, summary: string, evidence: string[] = []) => {
    const result: FinalResult = { outcome, summary, evidence, verification: lastVerification, steps: Math.min(step, config.maxSteps), durationMs: Date.now() - started };
    run.finish(result);
    return result;
  };

  run.emitEvent({ type: "status", status: "started", detail: `model=${config.llm.model} approval=${run.approvalMode}` }, "system");
  try {
    for (step = 1; step <= config.maxSteps; step++) {
      if (run.cancelled) return done("cancelled", "Run cancelled by the user.");

      messages[0] = { role: "system", content: workerSystemPrompt(env, run.plan, run.memory) };
      compactHistory(messages);
      // Planning first is a rule: the task message asks for it, and if the model skipped it on turn 1 we
      // force it on turn 2 (forcing on turn 1 makes some models emit malformed calls).
      const res = await nextMove(llm, run, messages, tools, "worker", !run.plan && step === 2 ? "update_plan" : undefined);
      if (!res.toolCalls.length && res.content) {
        // Weaker models sometimes write the finish call as plain JSON text instead of calling the tool.
        const finish = textualFinish(res.content);
        if (finish) res.toolCalls = [{ id: `text_finish_${step}`, type: "function", function: { name: "finish", arguments: JSON.stringify(finish) } }];
      }
      if (res.content?.trim() && !res.toolCalls.some((c) => c.id.startsWith("text_finish"))) run.emitEvent({ type: "thought", text: res.content.trim() });

      if (!res.toolCalls.length) {
        messages.push({ role: "assistant", content: res.content ?? "" });
        if (++nudges > MAX_NUDGES) return done("failed", `The model stopped calling tools. Last message: ${res.content ?? "(empty)"}`);
        messages.push({ role: "user", content: "Continue by calling a tool. If the task is finished (or cannot be finished), call finish." });
        continue;
      }
      nudges = 0;
      messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });

      const notes: string[] = [];
      for (const call of res.toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = parseArgs(call.function.arguments);
        } catch {
          messages.push({ role: "tool", tool_call_id: call.id, content: "Error: arguments were not valid JSON. Call the tool again." });
          continue;
        }
        const result = await dispatch(run, tools, call.id, call.function.name, args, "worker");
        messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
        const note = guard.record(call.function.name, args, result.ok);
        if (note) notes.push(note);
      }
      for (const n of notes) {
        run.emitEvent({ type: "recovery", text: n }, "system");
        messages.push({ role: "user", content: n });
      }

      if (!finishReq) continue;
      const claim = { summary: String(finishReq.summary ?? ""), evidence: (finishReq.evidence ?? []).map(String) };
      const outcome = finishReq.outcome;
      finishReq = undefined;
      if (outcome !== "completed") return done(outcome === "needs_user" ? "needs_user" : "failed", claim.summary, claim.evidence);

      // The worker says it's done. Check independently before believing it.
      verificationRounds++;
      lastVerification = await verify(llm, run, env, claim, verificationRounds);
      run.emitEvent({ type: "verification", round: verificationRounds, result: lastVerification }, "verifier");
      if (lastVerification.passed) return done("completed", claim.summary, claim.evidence);
      if (verificationRounds >= MAX_VERIFICATION_ROUNDS) return done("unverified", `${claim.summary}\n\nIndependent verification did not confirm the outcome: ${lastVerification.summary}`, claim.evidence);

      const failed = lastVerification.checks.filter((c) => !c.passed).map((c) => `- ${c.criterion}: ${c.evidence}`).join("\n");
      const feedback = `An independent verifier checked the systems and the task is NOT complete:\n${lastVerification.summary}\n${failed}\nFix the problems (without creating duplicates), then call finish again.`;
      run.emitEvent({ type: "recovery", text: "Verification failed — sending findings back to the worker." }, "system");
      messages.push({ role: "user", content: feedback });
    }
    return done("failed", `Stopped after reaching the step budget (${config.maxSteps}). Progress so far:\n${[...run.memory].map(([k, v]) => `${k}: ${v}`).join("\n")}`);
  } catch (e) {
    run.emitEvent({ type: "error", message: (e as Error).message }, "system");
    return done("failed", `The run stopped because of an error: ${(e as Error).message}`);
  } finally {
    await closeRunBrowsers(run);
  }
}

export { Run };
