/** The task engine: queue → route → dispatch → (fail → reroute)* → done. One task at a time in v1. */

import { classifyFailure, excerpt, hasSideEffects, NO_SIDE_EFFECTS } from "../router/failure.js";
import type { Attempt } from "../router/reroute.js";
import { reroute, route, type RouteDeps } from "../router/route.js";
import type { RoutingLog } from "../router/log.js";
import type { TargetRef } from "../router/targets.js";
import type { Verdict } from "../router/validate.js";
import type { ApprovalDecision, Executor } from "../executors/types.js";
import type { Bus } from "./bus.js";
import { cleanupEphemeral, defaultCleanupPaths, type CleanupPaths } from "./cleanup.js";
import type { Store } from "./store.js";
import type { NewTask, Task, TaskEventType } from "./types.js";

export type EngineDeps = Omit<RouteDeps, "quota" | "running"> & {
  readonly store: Store;
  readonly bus: Bus;
  readonly executors: readonly Executor[];
  readonly quota: () => RouteDeps["quota"];
  readonly approvalTimeoutMs?: number;
  readonly retryBackoffMs?: number;
  readonly cleanupPaths?: CleanupPaths;
  readonly routingLog?: RoutingLog;
};

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

  /** Persist and enqueue; resolves with the queued task immediately. */
  submit(input: NewTask): Task {
    const task = this.deps.store.createTask(input);
    this.emit(task.id, "queued", { task: task.task, cwd: task.cwd });
    this.chain = this.chain.then(() => this.process(task.id)).catch(() => undefined);
    return task;
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
    const { store: _s, bus: _b, executors: _e, quota, approvalTimeoutMs: _a, retryBackoffMs: _r, cleanupPaths: _c, routingLog: _l, ...rest } = this.deps;
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
      if (task.ephemeral) this.cleanup(task);
    }
  }

  private cleanup(task: Task): void {
    const report = cleanupEphemeral(task.cwd, this.deps.cleanupPaths ?? defaultCleanupPaths());
    this.emit(task.id, "cleaned", { ...report });
  }

  /** Follow-ups carry the conversation: parent chain (oldest first) as context, then the new message. */
  composeTask(task: Task): string {
    const chain: Task[] = [];
    let cur = task.parentId ? this.deps.store.getTask(task.parentId) : undefined;
    while (cur && chain.length < 5) { chain.unshift(cur); cur = cur.parentId ? this.deps.store.getTask(cur.parentId) : undefined; }
    if (!chain.length) return task.task;
    const history = chain.map((t) => `User: ${t.task}\nAssistant (${t.harness ?? "?"}/${t.model ?? "?"}, ${t.status}): ${(t.result ?? t.error ?? "(no result)").slice(0, 2000)}`).join("\n\n");
    return `This is a follow-up in an ongoing conversation. Earlier turns:\n\n${history}\n\nUser now says:\n${task.task}`;
  }

  private async runTask(task: Task, signal: AbortSignal): Promise<void> {
    this.deps.store.updateTask(task.id, { status: "routing" });
    const composed = this.composeTask(task);
    const routed = await route({ task: composed, cwd: task.cwd, ...(task.pin ? { pin: task.pin } : {}), needsBrowser: task.needsBrowser }, this.routeDeps());
    this.deps.routingLog?.record(task.task, task.cwd, routed);
    this.emit(task.id, "routed", { source: routed.source, verdict: routed.verdict, decision: routed.decision, routerMs: routed.routerMs, routerError: routed.routerError });
    if (!routed.verdict.ok) return this.fail(task.id, `no target: ${routed.verdict.notes.join("; ")}`);
    let current = this.deps.store.updateTask(task.id, { decision: routed.decision, brief: routed.decision?.brief ?? composed });
    let verdict: Verdict = routed.verdict;
    let attempts: Attempt[] = [];

    for (;;) {
      if (signal.aborted) return;
      if (!verdict.ok) return this.fail(task.id, `no target: ${verdict.notes.join("; ")}`);
      const outcome = await this.dispatch(current, verdict, signal);
      if (outcome.kind === "cancelled") return;
      if (outcome.kind === "done") return;
      attempts = [...attempts, outcome.attempt];
      current = this.deps.store.updateTask(task.id, { attempts, status: "routing" });
      const next = await reroute({ task: composed, cwd: current.cwd, needsBrowser: current.needsBrowser, decision: current.decision, attempts, routerAsks: current.routerAsks }, this.routeDeps());
      const step = next.step;
      if (step.kind === "retry") {
        this.emit(task.id, "redispatch", { kind: "retry", target: step.target, backoffMs: step.backoffMs });
        await sleep(this.deps.retryBackoffMs ?? step.backoffMs, signal);
        verdict = { ok: true, harness: step.target.harness, model: step.target.model, effort: null, chosen: "router", queue: false, notes: [] };
        continue;
      }
      if (step.kind === "switch") {
        this.emit(task.id, "redispatch", { kind: "switch", target: step.target, notes: step.notes });
        verdict = { ok: true, harness: step.target.harness, model: step.target.model, effort: null, chosen: "fallback", queue: false, notes: step.notes };
        continue;
      }
      if (step.kind === "redispatch") {
        current = this.deps.store.updateTask(task.id, { routerAsks: current.routerAsks + 1, decision: next.decision ?? current.decision, brief: next.decision?.brief ?? current.brief });
        this.deps.routingLog?.record(task.task, task.cwd, { verdict: step.verdict, decision: next.decision, source: step.source, routerError: next.routerError, routerMs: next.routerMs, attempts: attempts.length });
        this.emit(task.id, "redispatch", { kind: "router", source: step.source, verdict: step.verdict, decision: next.decision, routerError: next.routerError });
        verdict = step.verdict;
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

  private async dispatch(task: Task, verdict: Extract<Verdict, { ok: true }>, signal: AbortSignal): Promise<{ kind: "done" } | { kind: "cancelled" } | { kind: "failed"; attempt: Attempt }> {
    const executor = this.deps.executors.find((e) => e.harness === verdict.harness);
    const target: TargetRef = { harness: verdict.harness, model: verdict.model };
    if (!executor) {
      return { kind: "failed", attempt: { ...target, kind: "transport", excerpt: `no executor for harness ${verdict.harness}`, sideEffects: NO_SIDE_EFFECTS } };
    }
    this.deps.store.updateTask(task.id, { status: "running", harness: verdict.harness, model: verdict.model, effort: verdict.effort });
    this.emit(task.id, "dispatched", { harness: verdict.harness, model: verdict.model, effort: verdict.effort, chosen: verdict.chosen, brief: task.brief });
    this.running[verdict.harness] = (this.running[verdict.harness] ?? 0) + 1;
    try {
      const outcome = await executor.run({
        taskId: task.id, task: task.task, brief: task.brief ?? task.task, cwd: task.cwd, model: verdict.model, effort: verdict.effort,
        handoffNote: task.decision?.handoff_note ?? null, browser: task.needsBrowser || (task.decision?.needs_browser ?? false), signal,
        emit: (type, payload) => this.emit(task.id, type, payload),
        approve: (action, evidence) => this.requestApproval(task.id, action, evidence),
      });
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
