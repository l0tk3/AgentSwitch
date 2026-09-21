/** The task engine: queue → route → dispatch → (fail → reroute)* → done. One task at a time in v1. */

import { classifyFailure, excerpt, hasSideEffects, NO_SIDE_EFFECTS } from "../router/failure.js";
import type { Attempt } from "../router/reroute.js";
import { reroute, route, type RouteDeps } from "../router/route.js";
import type { RoutingLog } from "../router/log.js";
import { collectOut } from "../files/artifacts.js";
import { attachmentsNote } from "../files/notes.js";
import { join } from "node:path";
import type { TargetRef } from "../router/targets.js";
import type { Verdict } from "../router/validate.js";
import type { ApprovalDecision, Executor } from "../executors/types.js";
import { NO_PROTECTED, restoreProtected, snapshotProtected, type ProtectedPaths } from "../executors/protected.js";
import { foldThread } from "../threads/fold.js";
import { buildHandoff, gitDiffSummary, renderHandoff } from "../threads/handoff.js";
import type { Summarizer } from "../threads/summary.js";
import type { HandoffReason, ThreadState } from "../threads/types.js";
import type { Bus } from "./bus.js";
import { cleanupEphemeral, defaultCleanupPaths, type CleanupPaths } from "./cleanup.js";
import type { Store } from "./store.js";
import type { HandoffFrom, NewTask, Task, TaskEventType } from "./types.js";

export type EngineDeps = Omit<RouteDeps, "quota" | "running"> & {
  readonly store: Store;
  readonly bus: Bus;
  readonly executors: readonly Executor[];
  readonly quota: () => RouteDeps["quota"];
  readonly approvalTimeoutMs?: number;
  readonly retryBackoffMs?: number;
  readonly cleanupPaths?: CleanupPaths;
  readonly routingLog?: RoutingLog;
  /** Where <cwd>/out is copied before an ephemeral working directory is deleted. */
  readonly artifactsDir?: string;
  /** Rewrites the thread summary after every execution (threads-v0 §3); absent in tests. */
  readonly summarizer?: Summarizer;
  /** Paths no executor may change; the engine restores them after a run as the last line of defense. */
  readonly protected?: ProtectedPaths;
};

export type HandoffRequest = { readonly to?: TargetRef; readonly cwd?: string; readonly ephemeral?: boolean };

type Waiter = { resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout };

export class Engine {
  private readonly deps: EngineDeps;
  private readonly waiters = new Map<string, Waiter>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running: Record<string, number> = {};
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  /** Persist and enqueue; resolves with the queued task immediately. Every task lives in a thread:
   *  the one given, the parent's, or a new one for this cwd. */
  submit(input: NewTask): Task {
    const parent = input.parentId ? this.deps.store.getTask(input.parentId) : undefined;
    const threadId = input.threadId ?? parent?.threadId ?? this.deps.store.createThread(input.cwd).id;
    const task = this.deps.store.createTask({ ...input, threadId });
    this.emit(task.id, "queued", { task: task.task, cwd: task.cwd, threadId });
    this.chain = this.chain.then(() => this.process(task.id)).catch(() => undefined);
    return task;
  }

  /** "Hand this to someone else" (threads-v0 §4): stop the current execution if it is running, then queue a
   *  follow-up in the same thread that excludes the current executor (or pins the one the user chose).
   *  The summary is refreshed when the current task ends, before the follow-up is dispatched. */
  handoff(taskId: string, req: HandoffRequest = {}): Task | undefined {
    const task = this.deps.store.getTask(taskId);
    if (!task) return undefined;
    if (!TERMINAL_STATUS.has(task.status)) this.cancel(taskId);
    const from: HandoffFrom | null = task.harness && task.model ? { harness: task.harness, model: task.model, taskId: task.id, reason: "user" } : null;
    const next = this.submit({
      task: task.task, cwd: req.cwd ?? task.cwd, ephemeral: req.ephemeral ?? task.ephemeral, needsBrowser: task.needsBrowser, parentId: task.id,
      ...(task.threadId ? { threadId: task.threadId } : {}), ...(req.to ? { pin: req.to } : {}),
      ...(from ? { handoffFrom: from, exclude: req.to ? [] : [{ harness: from.harness, model: from.model }] } : {}),
    });
    if (task.threadId && from) {
      const state = this.threadState(task.threadId);
      this.deps.store.appendThreadEvent(task.threadId, "handoff", { from: { harness: from.harness, model: from.model, taskId: task.id, ...(state.sessions[from.harness] ? { sessionId: state.sessions[from.harness]!.sessionId } : {}) }, to: { ...(req.to ?? {}), taskId: next.id }, reason: "user", summaryRef: state.summarySeq });
    }
    this.emit(task.id, "handoff", { to: req.to ?? null, taskId: next.id, reason: "user" });
    return next;
  }

  threadState(threadId: string): ThreadState {
    return foldThread(this.deps.store.threadEvents(threadId));
  }

  /** Wait until the queue has drained (tests, graceful shutdown). */
  idle(): Promise<void> {
    return this.chain;
  }

  cancel(id: string): Task | undefined {
    const task = this.deps.store.getTask(id);
    if (!task) return undefined;
    if (task.status === "done" || task.status === "failed" || task.status === "cancelled") return task;
    this.controllers.get(id)?.abort(new Error("cancelled"));
    for (const a of this.deps.store.pendingApprovals(id)) this.resolveApproval(a.id, "deny", "expired");
    const updated = this.deps.store.updateTask(id, { status: "cancelled", error: "cancelled by user" });
    this.emit(id, "cancelled", {});
    return updated;
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision, status: "allowed" | "denied" | "expired" = decision === "allow" ? "allowed" : "denied"): boolean {
    const approval = this.deps.store.resolveApproval(approvalId, status);
    const waiter = this.waiters.get(approvalId);
    if (!approval || !waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(approvalId);
    this.emit(approval.taskId, "approval_resolved", { approvalId, decision, status });
    this.deps.store.updateTask(approval.taskId, { status: "running" });
    waiter.resolve(decision);
    return true;
  }

  private emit(taskId: string, type: TaskEventType, payload: Record<string, unknown>): void {
    this.deps.bus.publish(this.deps.store.appendEvent(taskId, type, payload));
  }

  private routeDeps(): RouteDeps {
    const { store: _s, bus: _b, executors: _e, quota, approvalTimeoutMs: _a, retryBackoffMs: _r, cleanupPaths: _c, routingLog: _l, artifactsDir: _d, summarizer: _m, protected: _p, ...rest } = this.deps;
    return { ...rest, quota: quota(), running: { ...this.running } };
  }

  private async process(id: string): Promise<void> {
    const task = this.deps.store.getTask(id);
    if (!task || task.status !== "queued") return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      await this.runTask(task, controller.signal);
    } catch (err) {
      if (this.deps.store.getTask(id)?.status !== "cancelled") this.fail(id, (err as Error).message);
    } finally {
      this.controllers.delete(id);
      await this.finishThread(id);          // before cleanup: the diff needs the work dir
      if (task.ephemeral) this.cleanup(task);
    }
  }

  /** Thread bookkeeping at the end of every execution: the task record, then the summary (never blocking on failure). */
  private async finishThread(id: string): Promise<void> {
    const task = this.deps.store.getTask(id);
    if (!task?.threadId) return;
    const failed = task.attempts.at(-1);
    this.deps.store.appendThreadEvent(task.threadId, "task", { taskId: task.id, harness: task.harness, model: task.model, status: task.status, kind: task.status === "failed" ? failed?.kind ?? "unknown" : null, tokens: this.tokensOf(task.id) });
    if (!this.deps.summarizer) return;
    const previous = this.threadState(task.threadId).summary;
    const r = await this.deps.summarizer({ previous, task: task.task, brief: task.brief, target: `${task.harness ?? "?"}/${task.model ?? "?"}`, status: task.status, result: task.result ?? task.error ?? "", diff: gitDiffSummary(task.cwd), cwd: task.cwd });
    if (!r.summary) { this.emit(task.id, "summary", { ok: false, error: r.error, ms: r.ms }); return; }
    const ev = this.deps.store.appendThreadEvent(task.threadId, "summary", { ...r.summary });
    if (!previous) this.deps.store.updateThread(task.threadId, { title: r.summary.title });
    this.emit(task.id, "summary", { ok: true, seq: ev.seq, title: r.summary.title, ms: r.ms });
  }

  private tokensOf(taskId: string): number {
    return this.deps.store.eventsSince(taskId).filter((e) => e.type === "done").reduce((n, e) => n + Number(e.payload.tokens ?? 0), 0);
  }

  /** The handoff text the next executor reads: thread summary + files + diff, plus the router's or user's note. */
  private handoffFor(task: Task, from: HandoffFrom, note: string | null): string {
    const summary = task.threadId ? this.threadState(task.threadId).summary : null;
    return renderHandoff(buildHandoff({ from, reason: from.reason, summary, note, cwd: task.cwd }));
  }

  private cleanup(task: Task): void {
    const artifacts = this.deps.artifactsDir ? collectOut(task.cwd, join(this.deps.artifactsDir, task.id)) : 0;
    const report = cleanupEphemeral(task.cwd, this.deps.cleanupPaths ?? defaultCleanupPaths());
    this.emit(task.id, "cleaned", { ...report, artifacts });
  }

  /** Follow-ups carry the conversation: parent chain (oldest first) as context, then the new message. */
  composeTask(task: Task): string {
    const chain: Task[] = [];
    let cur = task.parentId ? this.deps.store.getTask(task.parentId) : undefined;
    while (cur && chain.length < 5) { chain.unshift(cur); cur = cur.parentId ? this.deps.store.getTask(cur.parentId) : undefined; }
    if (!chain.length) return task.task + attachmentsNote(task.attachments);
    const history = chain.map((t) => `User: ${t.task}\nAssistant (${t.harness ?? "?"}/${t.model ?? "?"}, ${t.status}): ${(t.result ?? t.error ?? "(no result)").slice(0, 2000)}`).join("\n\n");
    return `This is a follow-up in an ongoing conversation. Earlier turns:\n\n${history}\n\nUser now says:\n${task.task}${attachmentsNote(task.attachments)}`;
  }

  private async runTask(task: Task, signal: AbortSignal): Promise<void> {
    this.deps.store.updateTask(task.id, { status: "routing" });
    const composed = this.composeTask(task);
    const routed = await route({ task: composed, cwd: task.cwd, ...(task.pin ? { pin: task.pin } : {}), needsBrowser: task.needsBrowser, exclude: task.exclude }, this.routeDeps());
    this.deps.routingLog?.record(task.task, task.cwd, routed);
    this.emit(task.id, "routed", { source: routed.source, verdict: routed.verdict, decision: routed.decision, routerMs: routed.routerMs, routerError: routed.routerError });
    if (!routed.verdict.ok) return this.fail(task.id, `no target: ${routed.verdict.notes.join("; ")}`);
    let current = this.deps.store.updateTask(task.id, { decision: routed.decision, brief: routed.decision?.brief ?? composed });
    let verdict: Verdict = routed.verdict;
    let attempts: Attempt[] = [];
    // A task handed over by the user starts with a handoff package; re-dispatches build a fresh one.
    let handoff: string | null = task.handoffFrom ? this.handoffFor(task, task.handoffFrom, task.decision?.handoff_note ?? null) : null;

    for (;;) {
      if (signal.aborted) return;
      if (!verdict.ok) return this.fail(task.id, `no target: ${verdict.notes.join("; ")}`);
      const outcome = await this.dispatch(current, verdict, signal, handoff);
      if (outcome.kind === "cancelled") return;
      if (outcome.kind === "done") return;
      if (outcome.kind === "protected") return this.fail(task.id, `executor changed protected files (restored): ${outcome.paths.join(", ")}`, true);
      attempts = [...attempts, outcome.attempt];
      current = this.deps.store.updateTask(task.id, { attempts, status: "routing" });
      const next = await reroute({ task: composed, cwd: current.cwd, needsBrowser: current.needsBrowser, decision: current.decision, attempts, routerAsks: current.routerAsks, diffSummary: gitDiffSummary(current.cwd) }, this.routeDeps());
      const step = next.step;
      if (step.kind === "retry") {
        this.emit(task.id, "redispatch", { kind: "retry", target: step.target, backoffMs: step.backoffMs });
        await sleep(this.deps.retryBackoffMs ?? step.backoffMs, signal);
        verdict = { ok: true, harness: step.target.harness, model: step.target.model, effort: null, chosen: "router", queue: false, notes: [] };
        continue;
      }
      const failed = outcome.attempt;
      const reason: HandoffReason = failed.kind === "quota" ? "quota" : `failure:${failed.kind}`;
      if (step.kind === "switch") {
        this.emit(task.id, "redispatch", { kind: "switch", target: step.target, notes: step.notes });
        verdict = { ok: true, harness: step.target.harness, model: step.target.model, effort: null, chosen: "fallback", queue: false, notes: step.notes };
        handoff = this.recordHandoff(current, failed, reason, step.target, null);
        continue;
      }
      if (step.kind === "redispatch") {
        current = this.deps.store.updateTask(task.id, { routerAsks: current.routerAsks + 1, decision: next.decision ?? current.decision, brief: next.decision?.brief ?? current.brief });
        this.deps.routingLog?.record(task.task, task.cwd, { verdict: step.verdict, decision: next.decision, source: step.source, routerError: next.routerError, routerMs: next.routerMs, attempts: attempts.length });
        this.emit(task.id, "redispatch", { kind: "router", source: step.source, verdict: step.verdict, decision: next.decision, routerError: next.routerError });
        verdict = step.verdict;
        handoff = verdict.ok ? this.recordHandoff(current, failed, reason, { harness: verdict.harness, model: verdict.model }, next.decision?.handoff_note ?? null) : null;
        continue;
      }
      if (step.kind === "repair") {
        this.deps.store.updateTask(task.id, { routerAsks: current.routerAsks + 1 });
        return this.fail(task.id, `router requested repair tool ${step.tool}; repair tools are not wired yet`);
      }
      if (step.kind === "give_up") return this.fail(task.id, `router gave up: ${step.reason}`);
      return this.fail(task.id, step.reason, step.security);
    }
  }

  /** Mid-task handoff (re-dispatch to another target): thread event + the package text for the next executor. */
  private recordHandoff(task: Task, failed: Attempt, reason: HandoffReason, to: TargetRef, note: string | null): string {
    const from: HandoffFrom = { harness: failed.harness, model: failed.model, taskId: task.id, reason };
    if (task.threadId) {
      const state = this.threadState(task.threadId);
      this.deps.store.appendThreadEvent(task.threadId, "handoff", { from: { harness: from.harness, model: from.model, taskId: task.id }, to: { ...to, taskId: task.id }, reason, summaryRef: state.summarySeq });
    }
    this.emit(task.id, "handoff", { from: { harness: from.harness, model: from.model }, to, reason, taskId: task.id });
    return this.handoffFor(task, from, note);
  }

  private async dispatch(task: Task, verdict: Extract<Verdict, { ok: true }>, signal: AbortSignal, handoff: string | null): Promise<{ kind: "done" } | { kind: "cancelled" } | { kind: "failed"; attempt: Attempt } | { kind: "protected"; paths: string[] }> {
    const executor = this.deps.executors.find((e) => e.harness === verdict.harness);
    const target: TargetRef = { harness: verdict.harness, model: verdict.model };
    if (!executor) {
      return { kind: "failed", attempt: { ...target, kind: "transport", excerpt: `no executor for harness ${verdict.harness}`, sideEffects: NO_SIDE_EFFECTS } };
    }
    this.deps.store.updateTask(task.id, { status: "running", harness: verdict.harness, model: verdict.model, effort: verdict.effort });
    this.emit(task.id, "dispatched", { harness: verdict.harness, model: verdict.model, effort: verdict.effort, chosen: verdict.chosen, brief: task.brief });
    this.running[verdict.harness] = (this.running[verdict.harness] ?? 0) + 1;
    const prot = this.deps.protected ?? NO_PROTECTED;
    const snapshot = snapshotProtected(task.cwd, prot);
    const { threadHome, resume } = this.continuation(task, verdict.harness);
    try {
      const outcome = await executor.run({
        taskId: task.id, task: task.task, brief: briefFor(task), cwd: task.cwd, model: verdict.model, effort: verdict.effort, attachments: task.attachments,
        handoffNote: handoff, threadHome, resume, browser: task.needsBrowser || (task.decision?.needs_browser ?? false), signal,
        emit: (type, payload) => this.emit(task.id, type, payload),
        approve: (action, evidence) => this.requestApproval(task.id, action, evidence),
      });
      const touched = restoreProtected(task.cwd, prot, snapshot);
      if (touched.length) { this.emit(task.id, "attempt_failed", { ...target, kind: "protected", excerpt: touched.join(", "), sideEffects: outcome.sideEffects ?? NO_SIDE_EFFECTS, hadSideEffects: true, security: true }); return { kind: "protected", paths: touched }; }
      if (outcome.sessionId && task.threadId) this.deps.store.appendThreadEvent(task.threadId, "session", { harness: verdict.harness, sessionId: outcome.sessionId, taskId: task.id });
      if (signal.aborted) return { kind: "cancelled" };
      if (outcome.ok) {
        this.deps.store.updateTask(task.id, { status: "done", result: outcome.lastText ?? "" });
        this.emit(task.id, "done", { result: outcome.lastText ?? "", tokens: outcome.tokens ?? 0, sideEffects: outcome.sideEffects ?? NO_SIDE_EFFECTS });
        return { kind: "done" };
      }
      const kind = classifyFailure(outcome) ?? "unknown";
      const attempt: Attempt = { ...target, kind, excerpt: excerpt(outcome), sideEffects: outcome.sideEffects ?? NO_SIDE_EFFECTS };
      this.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: hasSideEffects(attempt.sideEffects) });
      return { kind: "failed", attempt };
    } catch (err) {
      if (signal.aborted) return { kind: "cancelled" };
      const attempt: Attempt = { ...target, kind: "transport", excerpt: (err as Error).message.slice(0, 240), sideEffects: NO_SIDE_EFFECTS };
      this.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: false });
      return { kind: "failed", attempt };
    } finally {
      this.running[verdict.harness] = Math.max(0, (this.running[verdict.harness] ?? 1) - 1);
    }
  }

  /** Same harness in the same thread and the same cwd → resume its last session (threads-v0 §4: no handoff needed). */
  private continuation(task: Task, harness: string): { threadHome: string | null; resume: string | null } {
    const thread = task.threadId ? this.deps.store.getThread(task.threadId) : undefined;
    if (!thread) return { threadHome: null, resume: null };
    const session = this.threadState(thread.id).sessions[harness];
    return { threadHome: thread.home, resume: session && thread.cwd === task.cwd ? session.sessionId : null };
  }

  private requestApproval(taskId: string, action: string, evidence: string): Promise<ApprovalDecision> {
    const approval = this.deps.store.createApproval(taskId, action, evidence);
    this.deps.store.updateTask(taskId, { status: "waiting_approval" });
    this.emit(taskId, "approval_request", { approvalId: approval.id, action, evidence });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolveApproval(approval.id, "deny", "expired"), this.deps.approvalTimeoutMs ?? 10 * 60_000);
      this.waiters.set(approval.id, { resolve, timer });
    });
  }

  private fail(id: string, error: string, security = false): void {
    this.deps.store.updateTask(id, { status: "failed", error });
    this.emit(id, "failed", { error, security });
  }
}

/** The executor reads the router's brief (or the raw task) plus the attachment list, which the router may have dropped. */
function briefFor(task: Task): string {
  const base = task.brief ?? task.task;
  const note = attachmentsNote(task.attachments);
  return note && !base.includes(task.attachments[0]!.path) ? base + note : base;
}

const TERMINAL_STATUS: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
