/** The approval desk: every question the daemon puts to a human (or, on the user's behalf, to the supervisor).
 *  Two kinds — allow/deny approvals and free-text questions — with one timeout policy and one resolution path,
 *  so a late answer can never revive a finished task and nothing is left pending when a task ends. */

import type { ApprovalDecision } from "../executors/types.js";
import type { EngineContext } from "./context.js";
import { TERMINAL, type ApprovalStatus } from "./types.js";

export type ResolvedBy = "user" | "router" | "timeout";
export type RequestOptions = { readonly humanOnly?: boolean };

type Pending = { readonly kind: "approval"; readonly resolve: (d: ApprovalDecision) => void; readonly timer: NodeJS.Timeout }
  | { readonly kind: "question"; readonly resolve: (text: string | null) => void; readonly timer: NodeJS.Timeout };

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

export class ApprovalDesk {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly ctx: EngineContext,
    private readonly timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
    /** Called for every new allow/deny request that is not human-only (the supervisor hook). */
    private readonly onRequested: (taskId: string, approvalId: string, action: string, evidence: string) => void = () => undefined,
  ) {}

  isPending(approvalId: string): boolean { return this.pending.has(approvalId); }

  /** Allow/deny. Resolves with the decision; expires to "deny" after the timeout. */
  request(taskId: string, action: string, evidence: string, opts: RequestOptions = {}): Promise<ApprovalDecision> {
    const approval = this.ctx.store.createApproval(taskId, action, evidence, "approval");
    this.ctx.store.updateTask(taskId, { status: "waiting_approval" });
    this.ctx.emit(taskId, "approval_request", { approvalId: approval.id, kind: "approval", action, evidence, humanOnly: opts.humanOnly ?? false });
    const promise = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(approval.id, { kind: "approval", resolve, timer: this.expiry(approval.id) });
    });
    if (!opts.humanOnly) this.onRequested(taskId, approval.id, action, evidence);
    return promise;
  }

  /** Free text from the user. Resolves with the text, or null when denied or expired. */
  ask(taskId: string, question: string, evidence: string): Promise<string | null> {
    const approval = this.ctx.store.createApproval(taskId, question, evidence, "question");
    this.ctx.store.updateTask(taskId, { status: "waiting_approval" });
    this.ctx.emit(taskId, "approval_request", { approvalId: approval.id, kind: "question", action: question, evidence, humanOnly: true });
    return new Promise((resolve) => {
      this.pending.set(approval.id, { kind: "question", resolve, timer: this.expiry(approval.id) });
    });
  }

  /** Allow or deny (a question resolves to null). Returns false when nothing was pending under that id. */
  resolve(approvalId: string, decision: ApprovalDecision, status: Exclude<ApprovalStatus, "pending"> = decision === "allow" ? "allowed" : "denied", by: ResolvedBy = status === "expired" ? "timeout" : "user"): boolean {
    const p = this.take(approvalId);
    const approval = this.ctx.store.resolveApproval(approvalId, status);
    if (!p || !approval) return false;
    this.ctx.emit(approval.taskId, "approval_resolved", { approvalId, decision, status, by, kind: approval.kind });
    this.resume(approval.taskId, "running");
    if (p.kind === "question") p.resolve(null); else p.resolve(decision);
    return true;
  }

  /** Text answer to a question; the caller re-routes the task. */
  answer(approvalId: string, text: string): boolean {
    const current = this.ctx.store.getApproval(approvalId);
    const p = current?.kind === "question" && current.status === "pending" ? this.take(approvalId) : undefined;
    if (!p || p.kind !== "question") return false;
    const approval = this.ctx.store.answerApproval(approvalId, text);
    if (!approval) return false;
    this.ctx.emit(approval.taskId, "approval_resolved", { approvalId, decision: "answer", status: "allowed", by: "user", kind: "question", text });
    this.resume(approval.taskId, "routing");
    p.resolve(text);
    return true;
  }

  /** When a task ends or is cancelled, nothing may stay pending for it. */
  expireAll(taskId: string): void {
    for (const a of this.ctx.store.pendingApprovals(taskId)) this.resolve(a.id, "deny", "expired");
  }

  private expiry(approvalId: string): NodeJS.Timeout {
    const t = setTimeout(() => this.resolve(approvalId, "deny", "expired"), this.timeoutMs);
    t.unref?.();
    return t;
  }

  private take(approvalId: string): Pending | undefined {
    const p = this.pending.get(approvalId);
    if (!p) return undefined;
    clearTimeout(p.timer);
    this.pending.delete(approvalId);
    return p;
  }

  /** A late resolution must not revive a task that already ended. */
  private resume(taskId: string, status: "running" | "routing"): void {
    const task = this.ctx.store.getTask(taskId);
    if (task && !TERMINAL.has(task.status)) this.ctx.store.updateTask(taskId, { status });
  }
}
