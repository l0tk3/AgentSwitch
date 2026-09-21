/** What every harness adapter implements. The engine owns approvals, events and re-dispatch. */

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
  /** Files the user uploaded, already under <cwd>/in/. Images may be passed natively where the harness supports it. */
  readonly attachments: readonly Attachment[];
  /** Task or router asked for a browser: attach the gated Playwright MCP. */
  readonly browser: boolean;
  readonly signal: AbortSignal;
  /** Stream progress; the engine persists and fans out. */
  readonly emit: (type: "text" | "tool_call", payload: Record<string, unknown>) => void;
  /** Ask the user; resolves when they answer or the request expires (deny). */
  readonly approve: (action: string, evidence: string) => Promise<ApprovalDecision>;
};

export interface Executor {
  readonly harness: string;
  run(input: ExecutionInput): Promise<ExecutionOutcome>;
}
