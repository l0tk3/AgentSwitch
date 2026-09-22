/** What every harness adapter implements. The engine owns approvals, events and re-dispatch. */

import type { UserAnswers, UserQuestion } from "../engine/questions.js";
import type { Attachment } from "../files/uploads.js";
import type { ExecutionOutcome } from "../router/failure.js";

export type ApprovalDecision = "allow" | "deny";

export type ExecutionInput = {
  readonly taskId: string;
  readonly task: string;
  readonly brief: string;
  readonly cwd: string;
  readonly model: string;
  readonly effort: string | null;
  readonly handoffNote: string | null;
  /** The user's CONTEXT.md (linted: ciphertext only), so sites/accounts reach the executor even when the router's brief omits them. */
  readonly context: string | null;
  /** Genuine enc:v1: tokens for this task; executors that can rewrite tool inputs repair damaged copies against it. */
  readonly knownTokens: ReadonlySet<string>;
  /** The thread's private home (threads-v0 §1): harness state lives under <home>/<harness>, never in the user's own dirs. */
  readonly threadHome: string | null;
  /** This harness's last session in the thread (from a `session` thread event); the executor resumes it natively. */
  readonly resume: string | null;
  /** Files the user uploaded, already under <cwd>/in/. Images may be passed natively where the harness supports it. */
  readonly attachments: readonly Attachment[];
  /** Task or router asked for a browser: attach the gated Playwright MCP. */
  readonly browser: boolean;
  readonly signal: AbortSignal;
  /** Stream progress; the engine persists and fans out. `agent` = a sub-agent the harness spawned (background-v0 §2). */
  readonly emit: (type: "text" | "tool_call" | "agent", payload: Record<string, unknown>) => void;
  /** Ask the user; resolves when they answer or the request expires (deny). */
  readonly approve: (action: string, evidence: string) => Promise<ApprovalDecision>;
  /** The harness's own "ask the user" tool, passed straight to the user's card (supervisor-v0 §1c).
   *  Resolves with the answers, or null when the user declined or nobody answered in time. */
  readonly ask: (questions: readonly UserQuestion[]) => Promise<UserAnswers | null>;
};

export interface Executor {
  readonly harness: string;
  run(input: ExecutionInput): Promise<ExecutionOutcome>;
}
