/** What every harness adapter implements. The engine owns approvals, events and re-dispatch. */

import type { UserAnswers, UserQuestion } from "../core/questions.js";
import type { Attachment } from "../files/uploads.js";
import type { ExecutionOutcome } from "../core/outcome.js";
import type { TransferGrant } from "../core/transfer.js";

export type ApprovalDecision = "allow" | "deny";
/** Per-execution loopback capability. Only the gate MCP process receives this credential. */
export type CredentialRepair = { readonly url: string; readonly key: string };

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
  readonly credentialRepair?: CredentialRepair;
  /** This execution's enc:ref: scope (gate-next-v0 §1), set by the refs wrapper. A capability: only the gate processes
   *  (SECRET_GATE_SCOPE) and the shell tools' proxy URL carry it; never argv, prompts, events or logs. */
  readonly gateScope?: string | null;
  /** §5.2 authorized field transfer, validated from the router's decision; the engine sets it only with the browser attached. */
  readonly transfer?: TransferGrant | null;
  /** The thread's private home (threads-v0 §1): harness state lives under <home>/<harness>, never in the user's own dirs. */
  readonly threadHome: string | null;
  /** This harness's last session in the thread (from a `session` thread event); the executor resumes it natively. */
  readonly resume: string | null;
  /** Files the user uploaded, already under <cwd>/in/. Images may be passed natively where the harness supports it. */
  readonly attachments: readonly Attachment[];
  /** Task or router asked for a browser: attach the gated Playwright MCP. */
  readonly browser: boolean;
  /** A kept browser session slot's profile (browserSlots.ts); absent = a throw-away profile for this run only. */
  readonly browserProfile?: string;
  readonly signal: AbortSignal;
  /** Stream progress; the engine persists and fans out. `agent` = a sub-agent the harness spawned (background-v0 §2). */
  readonly emit: (type: "text" | "tool_call" | "tool_result" | "agent" | "credential_repair" | "transfer_grant", payload: Record<string, unknown>) => void;
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
