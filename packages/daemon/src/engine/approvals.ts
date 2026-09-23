/** The approval desk: every question the daemon puts to a human (or, on the user's behalf, to the supervisor).
 *  Two kinds — allow/deny approvals and free-text questions — with one timeout policy and one resolution path,
 *  so a late answer can never revive a finished task and nothing is left pending when a task ends. */

import type { ApprovalDecision } from "../executors/types.js";
import type { EngineContext } from "./context.js";
import { answersFromText, describeAnswers, encodeEvidence, parseEvidence, validateAnswers, type QuestionSource, type UserAnswers, type UserQuestion } from "./questions.js";
import { TERMINAL, type ApprovalStatus } from "./types.js";

export type ResolvedBy = "user" | "router" | "timeout";
export type RequestOptions = { readonly humanOnly?: boolean };
/** What the user sent back: plain text answers the first question; `answers` covers several. */
export type GivenAnswer = { readonly text?: string; readonly answers?: unknown; /** Internal API flag after raw length validation and sealing; never accepted from an HTTP body. */ readonly sealed?: boolean };
export type AnswerResult = { readonly ok: true } | { readonly ok: false; readonly code: "not_found" | "bad_answer"; readonly error: string };

type Pending = { readonly kind: "approval"; readonly resolve: (d: ApprovalDecision) => void; readonly timer: NodeJS.Timeout }
  | { readonly kind: "question"; readonly resolve: (answers: UserAnswers | null) => void; readonly timer: NodeJS.Timeout };

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

  /** Questions for the user, from the router or passed straight through from an executor (supervisor-v0 §1c).
   *  Resolves with the answers, or null when denied or expired. Never goes to the supervisor. */
  ask(taskId: string, questions: readonly UserQuestion[], source: QuestionSource): Promise<UserAnswers | null> {
    if (!questions.length) throw new Error("ask: no questions");
    const evidence = encodeEvidence({ source, questions });
    const approval = this.ctx.store.createApproval(taskId, questions[0]!.text, evidence, "question");
    this.ctx.store.updateTask(taskId, { status: "waiting_approval" });
    this.ctx.emit(taskId, "approval_request", { approvalId: approval.id, kind: "question", action: questions[0]!.text, evidence, humanOnly: true, source, questions });
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
    const evidence = p.kind === "question" ? parseEvidence(approval.evidence) : null;
    const task = this.ctx.store.getTask(approval.taskId);
    if (evidence && task && !TERMINAL.has(task.status)) this.ctx.emit(approval.taskId, "feedback", {
      version: 1, approvalId, source: "user", status: "unanswered", questions: evidence.questions, answers: null,
      reason: status === "expired" ? "问题已超时，尚未得到答复" : "问题未得到答复",
    });
    this.resume(approval.taskId, "running");
    if (p.kind === "question") p.resolve(null); else p.resolve(decision);
    return true;
  }

  /** The user's answers. A router question sends the task back to routing; an executor question resumes the run. */
  answer(approvalId: string, given: GivenAnswer): AnswerResult {
    const current = this.ctx.store.getApproval(approvalId);
    const task = current ? this.ctx.store.getTask(current.taskId) : undefined;
    if (!task || TERMINAL.has(task.status)) return { ok: false, code: "not_found", error: "no active task with that question" };
    const ev = current?.kind === "question" && current.status === "pending" && this.pending.has(approvalId) ? parseEvidence(current.evidence) : null;
    if (!current || !ev) return { ok: false, code: "not_found", error: "no pending question with that id" };
    const checked = given.answers !== undefined ? validateAnswers(ev.questions, given.answers, given.sealed)
      : given.text?.trim() ? validateAnswers(ev.questions, answersFromText(ev.questions, given.text.trim()), given.sealed)
      : { ok: false as const, error: "text or answers required" };
    if (!checked.ok) return { ok: false, code: "bad_answer", error: checked.error };
    const p = this.take(approvalId);
    const approval = this.ctx.store.answerApproval(approvalId, JSON.stringify(checked.answers));
    if (!p || p.kind !== "question" || !approval) return { ok: false, code: "not_found", error: "no pending question with that id" };
    const text = describeAnswers(ev.questions, checked.answers);
    this.ctx.emit(approval.taskId, "approval_resolved", { approvalId, decision: "answer", status: "allowed", by: "user", kind: "question", source: ev.source, text, answers: checked.answers });
    this.ctx.emit(approval.taskId, "feedback", { version: 1, approvalId, source: "user", status: "answered", questions: ev.questions, answers: checked.answers });
    this.resume(approval.taskId, ev.source === "router" ? "routing" : "running");
    p.resolve(checked.answers);
    return { ok: true };
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
