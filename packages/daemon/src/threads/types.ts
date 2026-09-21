/** Threads: one piece of work from first message to done, across models and follow-ups (threads-v0 §1).
 *  Conversation history stays with each harness; a thread only holds handles, an append-only event
 *  log with per-type fold policies, and a last-wins summary that carries across harnesses. */

import type { TargetRef } from "../router/targets.js";

export type ThreadStatus = "open" | "archived";

export type Thread = {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly title: string | null;
  readonly cwd: string;
  /** Private home for harness state ($AGENTSWITCH_HOME/threads/<id>); deleted with the thread. */
  readonly home: string;
  readonly status: ThreadStatus;
  /** Archived threads are deleted (with their home) once this passes. */
  readonly expiresAt: number | null;
};

export type ThreadEventType = "task" | "session" | "summary" | "title" | "handoff" | "cost" | "progress";

export type Fold = "accumulate" | "last-wins" | "boundary-cleared";

/** Every event type declares how it folds into the current state (borrowed from Claude Code's log design). */
export const FOLD: Readonly<Record<ThreadEventType, Fold>> = {
  task: "accumulate",
  session: "last-wins",        // grouped by harness: one live handle per harness
  summary: "last-wins",
  title: "last-wins",
  handoff: "accumulate",
  cost: "last-wins",
  progress: "boundary-cleared", // transient; a summary clears it
};

export type ThreadEvent = {
  readonly threadId: string;
  readonly seq: number;
  readonly ts: number;
  readonly type: ThreadEventType;
  readonly payload: Readonly<Record<string, unknown>>;
};

/** One execution inside the thread. */
export type TaskRecord = {
  readonly taskId: string;
  readonly harness: string | null;
  readonly model: string | null;
  readonly status: string;
  readonly kind: string | null;        // failure kind when failed
  readonly tokens: number;
  readonly ts: number;
};

export type SessionHandle = { readonly harness: string; readonly sessionId: string; readonly taskId: string; readonly ts: number };

/** What the summarizer produces (threads-v0 §3); fixed shape, ≤ ~500 tokens. */
export type Summary = {
  readonly title: string;
  readonly goal: string;
  readonly progress: string;
  readonly files: readonly string[];
  readonly unresolved: readonly string[];
  readonly decisions: readonly string[];
  /** Durable, routing-level facts worth keeping in MEMORY.md (may be empty). */
  readonly facts: readonly string[];
};

export type HandoffReason = "user" | `failure:${string}` | "quota";

export type HandoffRecord = {
  readonly from: TargetRef & { readonly taskId: string; readonly sessionId?: string };
  readonly to: (Partial<TargetRef> & { readonly taskId: string }) | null;
  readonly reason: HandoffReason;
  readonly summaryRef: number | null;   // seq of the summary event carried across
  readonly ts: number;
};

export type ThreadState = {
  readonly tasks: readonly TaskRecord[];
  readonly sessions: Readonly<Record<string, SessionHandle>>;
  readonly summary: Summary | null;
  readonly summarySeq: number | null;
  readonly title: string | null;
  readonly handoffs: readonly HandoffRecord[];
  readonly cost: Readonly<Record<string, number>>;   // tokens by "harness/model"
  readonly progress: readonly string[];
  readonly lastTarget: TargetRef | null;
  readonly lastActivity: number | null;
};

export const EMPTY_THREAD_STATE: ThreadState = {
  tasks: [], sessions: {}, summary: null, summarySeq: null, title: null, handoffs: [], cost: {}, progress: [], lastTarget: null, lastActivity: null,
};
