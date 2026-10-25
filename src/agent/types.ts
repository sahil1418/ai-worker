import type { Run } from "./run.js";

/** JSON-schema subset used for tool parameters (OpenAI function-calling format). */
export type JsonSchema = Record<string, unknown>;

/**
 * none  — read-only, never needs approval
 * write — changes local/sandboxed state (e.g. writes a report file)
 * risky — irreversible or outward-facing (submits a form, POSTs to an API, sends a message)
 */
export type RiskLevel = "none" | "write" | "risky";

export interface RiskAssessment {
  level: RiskLevel;
  reason: string;
}

export interface ToolResult {
  ok: boolean;
  /** What the model sees as the observation. */
  output: string;
  /** Path (relative to the run dir) of a screenshot taken after the action, if any. */
  screenshot?: string;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Decide how dangerous this specific call is. Defaults to "none". */
  assessRisk?(args: A, run: Run): Promise<RiskAssessment> | RiskAssessment;
  execute(args: A, run: Run): Promise<ToolResult>;
}

export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "done" | "failed" | "skipped";
}

export interface Plan {
  goal: string;
  success_criteria: string[];
  steps: PlanStep[];
}

export interface VerificationCheck {
  criterion: string;
  passed: boolean;
  evidence: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  summary: string;
}

export type Outcome = "completed" | "failed" | "needs_user" | "unverified" | "cancelled";

export interface FinalResult {
  outcome: Outcome;
  summary: string;
  evidence: string[];
  verification?: VerificationResult;
  steps: number;
  durationMs: number;
}

export type RunEventBody =
  | { type: "status"; status: string; detail?: string }
  | { type: "plan"; plan: Plan }
  | { type: "thought"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; name: string; ok: boolean; output: string; screenshot?: string }
  | { type: "approval_request"; requestId: string; callId?: string; name: string; args: unknown; reason: string }
  | { type: "approval_response"; requestId: string; approved: boolean; comment?: string }
  | { type: "question"; requestId: string; question: string }
  | { type: "answer"; requestId: string; answer: string }
  | { type: "memory"; key: string; value: string }
  | { type: "recovery"; text: string }
  | { type: "verification"; round: number; result: VerificationResult }
  | { type: "final"; result: FinalResult }
  | { type: "error"; message: string };

export type RunEvent = RunEventBody & { seq: number; at: string; actor: "worker" | "verifier" | "system" };
