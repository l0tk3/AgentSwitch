/** Task engine domain types. Everything is immutable data; the store owns persistence. */

import type { Decision } from "../router/decision.js";
import type { Attempt } from "../router/reroute.js";
import type { Attachment } from "../files/uploads.js";
import type { TargetRef } from "../router/targets.js";

/** Who handed this task over (threads-v0 §4); the engine builds the handoff package from it at dispatch. */
export type HandoffFrom = TargetRef & { readonly taskId: string; readonly reason: "user" | `failure:${string}` | "quota" };

export type TaskStatus = "queued" | "routing" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";

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
  /** Targets the router must not pick (a handoff excludes the executor being handed off from). */
  readonly exclude?: readonly TargetRef[];
  readonly handoffFrom?: HandoffFrom;
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
  readonly harness: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly brief: string | null;
  readonly decision: Decision | null;
  readonly attempts: readonly Attempt[];
  readonly routerAsks: number;
  readonly result: string | null;
  readonly error: string | null;
  /** The summarizer's one-sentence account of the outcome (feedback line on the page, push text later). */
  readonly spoken: string | null;
};

export type TaskEventType =
  | "queued"
  | "routed"
  | "dispatched"
  | "text"
  | "tool_call"
  | "approval_request"
  | "approval_resolved"
  | "attempt_failed"
  | "redispatch"
  | "done"
  | "failed"
  | "cancelled"
  | "cleaned"
  | "summary"
  | "handoff"
  | "thread"
  | "waiting"
  | "agent"
  | "supervisor";

export type TaskEvent = {
  readonly taskId: string;
  readonly seq: number;
  readonly ts: number;
  readonly type: TaskEventType;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";

export type Approval = {
  readonly id: string;
  readonly taskId: string;
  readonly createdAt: number;
  readonly action: string;
  readonly evidence: string;
  readonly status: ApprovalStatus;
  readonly resolvedAt: number | null;
};

export const TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "failed", "cancelled"]);
