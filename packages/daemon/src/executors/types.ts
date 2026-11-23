/** What every harness adapter implements. The engine owns approvals, events and re-dispatch. */

import type { Writing } from "../core/writing.js";
import type { UserAnswers, UserQuestion } from "../core/questions.js";
import type { Attachment } from "../files/uploads.js";
import type { ExecutionOutcome } from "../core/outcome.js";
import type { TransferGrant } from "../core/transfer.js";

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
  /** Related, scoped observations only; this is deliberately separate from user-maintained context. */
  readonly platformMemory?: string | null;
  /** Source-attributed question/answer history; corrections survive a change of executor. */
  readonly feedback?: string | null;
  /** Genuine enc:v1: tokens for this task; executors that can rewrite tool inputs repair damaged copies against it. */
  readonly knownTokens: ReadonlySet<string>;
  /** This execution's enc:ref: scope (gate-next-v0 §1), set by the refs wrapper. A capability: only the gate processes
   *  (SECRET_GATE_SCOPE) and the shell tools' proxy URL carry it; never argv, prompts, events or logs. */
  readonly gateScope?: string | null;
  /** §5.2 authorized field transfer, validated from the router's decision; the engine sets it only with the browser attached. */
  readonly transfer?: TransferGrant | null;
  /** The thread's private home (threads-v0 §1): harness state lives under <home>/<harness>, never in the user's own dirs. */
  readonly threadHome: string | null;
  /** This harness's last session in the thread (from a `session` thread event); the executor resumes it natively. */
  readonly resume: string | null;
  /** Where this task's files for the user go (absolute; `$AGENTSWITCH_HOME/artifacts/<task>/out`, files/names.ts).
   *  Outside the working directory: an executor whose sandbox stops at the cwd opens this folder too. */
  readonly outDir?: string | null;
  /** Files the user uploaded (absolute paths under the task's `in/`). Images may be passed natively where the harness supports it. */
  readonly attachments: readonly Attachment[];
  /** Task or router asked for a browser: attach the gated Playwright MCP. */
  readonly browser: boolean;
  /** A kept browser session slot's profile (browserSlots.ts); absent = a throw-away profile for this run only. */
  readonly browserProfile?: string;
  readonly signal: AbortSignal;
  /** Stream progress; the engine persists and fans out. `agent` = a sub-agent the harness spawned (background-v0 §2). */
  readonly emit: (type: "text" | "tool_call" | "tool_result" | "agent" | "transfer_grant", payload: Record<string, unknown>) => void;
  /** What it is writing at the moment (docs/simple-view-v0.md §5.14): the part of its answer being written, its whole
   *  text so far; null once that part is in the task's events (`text`) or nothing is being written. Shown while it is
   *  written, never stored. Absent: nobody watches. */
  readonly writing?: (writing: Writing | null) => void;
  /** Ask the user; resolves when they answer or the request expires (deny). */
  /** `signal`: this one request's own cancellation (the executor gave up on it); the engine withdraws the card. */
  readonly approve: (action: string, evidence: string, signal?: AbortSignal) => Promise<ApprovalDecision>;
  /** The harness's question/feedback tool: the router answers from evidence or forwards to the user.
   *  Resolves with the answers, or null when the user declined or nobody answered in time. */
  readonly ask: (questions: readonly UserQuestion[]) => Promise<UserAnswers | null>;
};

export interface Executor {
  readonly harness: string;
  run(input: ExecutionInput): Promise<ExecutionOutcome>;
}
