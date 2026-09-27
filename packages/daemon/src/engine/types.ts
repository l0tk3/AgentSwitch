/** Task engine domain types. Everything is immutable data; the store owns persistence. */

import type { Decision } from "../router/decision.js";
import type { Attempt } from "../router/reroute.js";
import type { Attachment } from "../files/uploads.js";
import type { TargetRef } from "../core/target.js";
import type { ApprovalPolicy } from "./approvalPolicy.js";
import type { SealedEntry } from "../secrets/sealer.js";

/** Who handed this task over (threads-v0 §4); the engine builds the handoff package from it at dispatch. */
export type HandoffFrom = TargetRef & { readonly taskId: string; readonly reason: "user" | `failure:${string}` | "quota" };

/** question: waiting for the user's answer; planner_timeout / planner_error: the loop model gave no usable next action. */
export type BlockCause = "question" | "planner_timeout" | "planner_error" | "interrupted";

export type TaskStatus = "queued" | "routing" | "running" | "waiting_approval" | "done" | "partial" | "blocked" | "failed" | "cancelled";

export type NewTask = {
  readonly task: string;
  readonly cwd: string;
  readonly pin?: TargetRef;
  readonly needsBrowser?: boolean;
  /** Not a persistent project: delete the work dir and every harness record of it when the task ends. */
  readonly ephemeral?: boolean;
  /** Follow-up: the router and executor see the parent task's text and result as context. */
  readonly parentId?: string;
  /** Uploaded files already moved into <cwd>/in/. */
  readonly attachments?: readonly Attachment[];
  /** Thread to run in; default: the parent's thread, else a new one. */
  readonly threadId?: string;
  /** Credentials the sealer replaced with tokens before the task was stored (router-v0 §9): labels and hosts, never values. */
  readonly sealed?: readonly SealedEntry[];
  /** Targets the router must not pick (a handoff excludes the executor being handed off from). */
  readonly exclude?: readonly TargetRef[];
  readonly handoffFrom?: HandoffFrom;
  /** Per-task approval policy; default: $AGENTSWITCH_HOME/approvals.json. */
  readonly approval?: ApprovalPolicy;
};

export type Task = {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: TaskStatus;
  readonly task: string;
  readonly cwd: string;
  readonly pin: TargetRef | null;
  readonly needsBrowser: boolean;
  readonly ephemeral: boolean;
  readonly parentId: string | null;
  readonly attachments: readonly Attachment[];
  readonly threadId: string | null;
  readonly exclude: readonly TargetRef[];
  readonly handoffFrom: HandoffFrom | null;
  readonly approvalPolicy: ApprovalPolicy | null;
  readonly harness: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly brief: string | null;
  readonly decision: Decision | null;
  readonly attempts: readonly Attempt[];
  readonly routerAsks: number;
  readonly result: string | null;
  readonly error: string | null;
  /** routing_log row of the latest (re)dispatch decision, for the outcome write-back and the rating. */
  readonly routeLogId: number | null;
  /** The user's verdict on the outcome: 1 (👍), -1 (👎) or null. */
  readonly rating: number | null;
  /** The summarizer's one-sentence account of the outcome (feedback line on the page, push text later). */
  readonly spoken: string | null;
  /** The summarizer's spoken script for this run (threads-v0 §3), read aloud by the phone. */
  readonly speech: string | null;
  /** Why a blocked task stopped, for display without parsing `error` (null: not blocked, or no specific cause). */
  readonly blockCause: BlockCause | null;
  /** When the user last opened the task (docs/control-v0.md §4): an ended task updated after that is unread. */
  readonly acknowledgedAt: number | null;
};

export type TaskEventType =
  | "queued"
  | "routed"
  | "browser_session"   // threads-v0 §4b: which kept browser profile a run got {slot, reused, reason}, or none when all are busy
  | "dispatched"
  | "text"
  | "tool_call"
  | "tool_result"   // {id, ok, output}: what a tool call (same id) gave back, clipped (executors/toolEvents.ts)
  | "approval_request"
  | "approval_resolved"
  | "attempt_failed"
  | "refusal"
  | "credential_repair"
  | "checkpoint"
  | "redispatch"
  | "done"
  | "partial"
  | "blocked"
  | "failed"
  | "cancelled"
  | "cleaned"
  | "summary"
  | "handoff"
  | "thread"
  | "waiting"
  | "agent"
  | "supervisor"
  | "feedback"
  | "rated"
  | "sealed"
  | "transfer_grant"
  | "step";

export type TaskEvent = {
  readonly taskId: string;
  readonly seq: number;
  readonly ts: number;
  readonly type: TaskEventType;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "withdrawn";

/** approval = allow/deny; question = the router needs text from the user (docs/supervisor-v0.md §1b). */
export type ApprovalKind = "approval" | "question";

export type Approval = {
  readonly id: string;
  readonly taskId: string;
  readonly createdAt: number;
  readonly kind: ApprovalKind;
  readonly action: string;
  readonly evidence: string;
  readonly status: ApprovalStatus;
  readonly resolvedAt: number | null;
  readonly answer: string | null;
};

/** A paired phone (app-v0 §2 设备令牌). The store keeps only the SHA-256 of its token, and never hands it out here. */
export type Device = {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  readonly revokedAt: number | null;
};

export const TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "partial", "blocked", "failed", "cancelled"]);
