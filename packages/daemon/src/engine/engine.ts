/** The task engine: submit → gates → route (→ ask the user) → thread → dispatch → (fail → reroute)* → done.
 *  Orchestration only; the pieces live next to it: Scheduler (gates), ApprovalDesk (questions to humans),
 *  ThreadBook (threads, handoffs, records, summary), Composer (prompts and route deps), supervise (the router
 *  as supervisor). */

import type { Executor } from "../executors/types.js";
import { NO_PROTECTED, restoreProtected, snapshotProtected, type ProtectedPaths } from "../executors/protected.js";
import { classifyFailure, excerpt, hasSideEffects, NO_AGENTS, NO_SIDE_EFFECTS } from "../router/failure.js";
import type { RoutingLog } from "../router/log.js";
import type { Attempt } from "../router/reroute.js";
import { reroute, route, type RouteDeps, type RouteRequest } from "../router/route.js";
import type { Supervisor } from "../router/supervisor.js";
import type { TargetRef } from "../router/targets.js";
import type { Verdict } from "../router/validate.js";
import { gitDiffSummary } from "../threads/handoff.js";
import type { HandoffReason, ThreadBrief, ThreadState } from "../threads/types.js";
import type { Summarizer } from "../threads/summary.js";
import { collectOut } from "../files/artifacts.js";
import { join } from "node:path";
import { sleep } from "../util/sleep.js";
import { DEFAULT_POLICY, loadPolicy, type ApprovalPolicy } from "./approvalPolicy.js";
import { ApprovalDesk, type ResolvedBy } from "./approvals.js";
import type { Bus } from "./bus.js";
import { cleanupEphemeral, defaultCleanupPaths, type CleanupPaths } from "./cleanup.js";
import { Composer, type ComposeDeps } from "./compose.js";
import { engineContext, type EngineContext } from "./context.js";
import type { Release } from "./locks.js";
import { DEFAULT_MAX_TASKS, Scheduler } from "./scheduler.js";
import type { Store } from "./store.js";
import { acceptance, superviseApproval, watchdog } from "./supervise.js";
import { ThreadBook } from "./threadBook.js";
import { TERMINAL, type ApprovalStatus, type HandoffFrom, type NewTask, type Task } from "./types.js";

export { DEFAULT_MAX_TASKS } from "./scheduler.js";

export type EngineDeps = ComposeDeps & {
  readonly store: Store;
  readonly bus: Bus;
  readonly executors: readonly Executor[];
  readonly approvalTimeoutMs?: number;
  readonly retryBackoffMs?: number;
  readonly cleanupPaths?: CleanupPaths;
  readonly routingLog?: RoutingLog;
  /** Where <cwd>/out is copied before an ephemeral working directory is deleted. */
  readonly artifactsDir?: string;
  /** Rewrites the thread summary after every execution (threads-v0 §3); absent in tests. */
  readonly summarizer?: Summarizer;
  /** Paths no executor may change; restored after every run as the last line of defense. */
  readonly protected?: ProtectedPaths;
  readonly now?: () => number;
  /** Tasks in flight at once (routing or running); the rest queue FIFO (background-v0 §1). */
  readonly maxConcurrentTasks?: number;
  /** docs/supervisor-v0.md: approvals on the user's behalf, watchdog during execution, acceptance on done. */
  readonly supervisor?: Supervisor;
  /** $AGENTSWITCH_HOME/approvals.json: who answers which approvals (manual / auto / scoped). */
  readonly policyPath?: string;
};

export const MAX_CLARIFICATIONS = 2;

export type HandoffRequest = { readonly to?: TargetRef; readonly cwd?: string; readonly ephemeral?: boolean };

type DispatchOutcome = { kind: "done" } | { kind: "cancelled" } | { kind: "failed"; attempt: Attempt } | { kind: "protected"; paths: string[] };

export class Engine {
  private readonly ctx: EngineContext;
  private readonly desk: ApprovalDesk;
  private readonly scheduler: Scheduler;
  private readonly threads: ThreadBook;
  private readonly composer: Composer;
  private readonly controllers = new Map<string, AbortController>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: EngineDeps) {
    this.ctx = engineContext(deps.store, deps.bus, deps.now ?? Date.now);
    this.desk = new ApprovalDesk(this.ctx, deps.approvalTimeoutMs, (taskId, approvalId, action, evidence) => {
      const task = this.ctx.store.getTask(taskId);
      if (task && deps.supervisor) superviseApproval(this.ctx, deps.supervisor, this.desk, task, this.policyFor(task), approvalId, action, evidence);
    });
    this.scheduler = new Scheduler(this.ctx, deps.targets, deps.maxConcurrentTasks ?? DEFAULT_MAX_TASKS);
    this.threads = new ThreadBook(this.ctx, { ...deps, ...(deps.routingLog ? { routingLog: deps.routingLog } : {}) });
    this.composer = new Composer(this.ctx, deps);
  }

  // ---- public surface (the API, the CLI and tests) ----

  /** Persist and start; every task ends up in a thread (given, the parent's, or decided at routing time). */
  submit(input: NewTask): Task {
    const parent = input.parentId ? this.ctx.store.getTask(input.parentId) : undefined;
    const threadId = input.threadId ?? parent?.threadId ?? null;
    const task = this.ctx.store.createTask({ ...input, ...(threadId ? { threadId } : {}) });
    this.ctx.emit(task.id, "queued", { task: task.task, cwd: task.cwd, threadId });
    const run = this.process(task.id).catch((err: unknown) => {
      console.error(`task ${task.id}: unhandled error after execution: ${(err as Error).message}`);
    }).finally(() => this.inFlight.delete(task.id));
    this.inFlight.set(task.id, run);
    return task;
  }

  /** "Hand this to someone else" (threads-v0 §4): stop it if running, queue a successor in the same thread that excludes
   *  the current executor (or pins the one the user chose). */
  handoff(taskId: string, req: HandoffRequest = {}): Task | undefined {
    const task = this.ctx.store.getTask(taskId);
    if (!task) return undefined;
    if (!TERMINAL.has(task.status)) this.cancel(taskId);
    const from: HandoffFrom | null = task.harness && task.model ? { harness: task.harness, model: task.model, taskId: task.id, reason: "user" } : null;
    const next = this.submit({
      task: task.task, cwd: req.cwd ?? task.cwd, ephemeral: req.ephemeral ?? task.ephemeral, needsBrowser: task.needsBrowser, parentId: task.id,
      ...(task.threadId ? { threadId: task.threadId } : {}), ...(req.to ? { pin: req.to } : {}),
      ...(from ? { handoffFrom: from, exclude: req.to ? [] : [{ harness: from.harness, model: from.model }] } : {}),
    });
    if (from) this.threads.recordUserHandoff(task, from, req.to, next.id);
    else this.ctx.emit(task.id, "handoff", { to: req.to ?? null, taskId: next.id, reason: "user" });
    return next;
  }

  cancel(id: string): Task | undefined {
    const task = this.ctx.store.getTask(id);
    if (!task) return undefined;
    if (TERMINAL.has(task.status)) return task;
    this.controllers.get(id)?.abort(new Error("cancelled"));
    this.desk.expireAll(id);
    const updated = this.ctx.store.updateTask(id, { status: "cancelled", error: "cancelled by user" });
    this.ctx.emit(id, "cancelled", {});
    return updated;
  }

  resolveApproval(approvalId: string, decision: "allow" | "deny", status?: Exclude<ApprovalStatus, "pending">, by?: ResolvedBy): boolean {
    return this.desk.resolve(approvalId, decision, status, by);
  }

  answer(approvalId: string, text: string): boolean { return this.desk.answer(approvalId, text); }

  /** 👍 / 👎 on a task: track record + routing_log (router-v0 §7). */
  rate(taskId: string, rating: 1 | -1 | null): boolean {
    const task = this.ctx.store.getTask(taskId);
    if (!task || !this.ctx.store.rateTask(taskId, rating)) return false;
    if (task.routeLogId !== null) this.deps.routingLog?.setRating(task.routeLogId, rating);
    this.ctx.emit(taskId, "rated", { rating });
    return true;
  }

  /** Wait until every submitted task has ended (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()]);
  }

  runningByHarness(): Record<string, number> { return this.scheduler.runningByHarness(); }
  threadState(threadId: string): ThreadState { return this.threads.state(threadId); }
  threadBriefs(limit?: number): ThreadBrief[] { return this.threads.briefs(limit); }
  composeTask(task: Task): string { return this.composer.task(task); }
  policyFor(task: Task): ApprovalPolicy { return task.approvalPolicy ?? (this.deps.policyPath ? loadPolicy(this.deps.policyPath) : DEFAULT_POLICY); }

  // ---- lifecycle ----

  private routeDeps(): RouteDeps { return this.composer.routeDeps(this.scheduler.runningByHarness(), this.threads.briefs()); }

  private async process(id: string): Promise<void> {
    const task = this.ctx.store.getTask(id);
    if (!task || task.status !== "queued") return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const held: Release[] = [];
    try {
      if (task.parentId) await this.scheduler.awaitParent(task, controller.signal);   // before taking a slot: waiting on a parent costs nothing
      held.push(await this.scheduler.acquireGlobal(task, controller.signal));
      if (controller.signal.aborted) return;
      await this.runTask(task, controller.signal, held);
    } catch (err) {
      if (this.ctx.store.getTask(id)?.status !== "cancelled") this.fail(id, (err as Error).message);
    } finally {
      this.controllers.delete(id);
      this.desk.expireAll(id);                       // the executor moved on without an answer
      for (const release of held.reverse()) release();
      await this.threads.finish(id);                 // before cleanup: the diff needs the work dir
      const final = this.ctx.store.getTask(id) ?? task;   // joining a thread may have moved the task out of its temp dir
      if (final.ephemeral) this.cleanup(final);
    }
  }

  /** Route, letting the router ask the user first (at most MAX_CLARIFICATIONS rounds). Returns null when the task failed. */
  private async routeWithQuestions(task: Task, composed: string, signal: AbortSignal): Promise<{ routed: Awaited<ReturnType<typeof route>>; composed: string } | null> {
    const request = (text: string): RouteRequest => ({ task: text, cwd: task.cwd, ...(task.pin ? { pin: task.pin } : {}), needsBrowser: task.needsBrowser, exclude: task.exclude });
    let text = composed;
    let routed = await route(request(text), this.routeDeps());
    for (let round = 0; routed.clarify && round < MAX_CLARIFICATIONS; round++) {
      this.ctx.emit(task.id, "routed", { source: routed.source, verdict: routed.verdict, decision: routed.decision, routerMs: routed.routerMs, routerError: routed.routerError, clarify: routed.clarify });
      const answer = await this.desk.ask(task.id, routed.clarify, "路由器需要你补充信息才能派发");
      if (signal.aborted) return null;
      if (answer === null) { this.fail(task.id, `waiting for your answer: ${routed.clarify}`); return null; }
      text = `${text}\n\nUser clarification (in reply to "${routed.clarify}"):\n${answer}`;
      this.ctx.store.updateTask(task.id, { status: "routing" });
      routed = await route(request(text), this.routeDeps());
    }
    if (routed.clarify) { this.fail(task.id, `the router kept asking questions: ${routed.clarify}`); return null; }
    return { routed, composed: text };
  }

  private async runTask(initial: Task, signal: AbortSignal, held: Release[]): Promise<void> {
    this.ctx.store.updateTask(initial.id, { status: "routing" });
    const first = await this.routeWithQuestions(initial, this.composer.task(initial), signal);
    if (!first) return;
    const { routed, composed } = first;
    const routeLogId = this.deps.routingLog?.record(initial.task, initial.cwd, routed) ?? null;
    if (routeLogId !== null) this.ctx.store.updateTask(initial.id, { routeLogId });
    this.ctx.emit(initial.id, "routed", { source: routed.source, verdict: routed.verdict, decision: routed.decision, routerMs: routed.routerMs, routerError: routed.routerError });
    if (!routed.verdict.ok) return this.fail(initial.id, `no target: ${routed.verdict.notes.join("; ")}`);
    const task = await this.threads.assign(initial, routed.decision, (q, e) => this.desk.request(initial.id, q, e, { humanOnly: true }));
    if (signal.aborted) return;
    // Locks in a fixed order (background-v0 §1): thread, then cwd; the harness slot is taken per dispatch.
    held.push(await this.scheduler.acquireThread(task, signal));
    held.push(await this.scheduler.acquireCwd(task, signal));
    if (signal.aborted) return;
    let current = this.ctx.store.updateTask(task.id, { decision: routed.decision, brief: this.composer.repairBrief(task, routed.decision?.brief ?? composed) });
    let verdict: Verdict = routed.verdict;
    let attempts: Attempt[] = [];
    let rejections = 0;
    let handoff: string | null = task.handoffFrom ? this.threads.handoffText(task, task.handoffFrom, task.decision?.handoff_note ?? null) : null;

    for (;;) {
      if (signal.aborted) return;
      if (!verdict.ok) return this.fail(task.id, `no target: ${verdict.notes.join("; ")}`);
      const outcome = await this.dispatch(current, verdict, signal, handoff, rejections);
      if (outcome.kind === "cancelled" || outcome.kind === "done") return;
      if (outcome.kind === "protected") return this.fail(task.id, `executor changed protected files (restored): ${outcome.paths.join(", ")}`, true);
      if (outcome.attempt.kind === "rejected" && outcome.attempt.excerpt.startsWith("not accepted")) rejections++;
      attempts = [...attempts, outcome.attempt];
      current = this.ctx.store.updateTask(task.id, { attempts, status: "routing" });
      const next = await reroute({ task: composed, cwd: current.cwd, needsBrowser: current.needsBrowser, decision: current.decision, attempts, routerAsks: current.routerAsks, diffSummary: gitDiffSummary(current.cwd) }, this.routeDeps());
      const step = next.step;
      const failed = outcome.attempt;
      const reason: HandoffReason = failed.kind === "quota" ? "quota" : `failure:${failed.kind}`;
      if (step.kind === "retry") {
        this.ctx.emit(task.id, "redispatch", { kind: "retry", target: step.target, backoffMs: step.backoffMs });
        try { await sleep(this.deps.retryBackoffMs ?? step.backoffMs, signal); } catch { return; }
        verdict = { ok: true, harness: step.target.harness, model: step.target.model, effort: null, chosen: "router", queue: false, notes: [] };
      } else if (step.kind === "switch") {
        this.ctx.emit(task.id, "redispatch", { kind: "switch", target: step.target, notes: step.notes });
        verdict = { ok: true, harness: step.target.harness, model: step.target.model, effort: null, chosen: "fallback", queue: false, notes: step.notes };
        handoff = this.threads.recordHandoff(current, failed, reason, step.target, null);
      } else if (step.kind === "redispatch") {
        current = this.ctx.store.updateTask(task.id, { routerAsks: current.routerAsks + 1, decision: next.decision ?? current.decision, brief: next.decision?.brief ? this.composer.repairBrief(task, next.decision.brief) : current.brief });
        const logId = this.deps.routingLog?.record(task.task, task.cwd, { verdict: step.verdict, decision: next.decision, source: step.source, routerError: next.routerError, routerMs: next.routerMs, attempts: attempts.length }) ?? null;
        if (logId !== null) this.ctx.store.updateTask(task.id, { routeLogId: logId });
        this.ctx.emit(task.id, "redispatch", { kind: "router", source: step.source, verdict: step.verdict, decision: next.decision, routerError: next.routerError });
        verdict = step.verdict;
        handoff = verdict.ok ? this.threads.recordHandoff(current, failed, reason, { harness: verdict.harness, model: verdict.model }, next.decision?.handoff_note ?? null) : null;
      } else if (step.kind === "repair") {
        this.ctx.store.updateTask(task.id, { routerAsks: current.routerAsks + 1 });
        return this.fail(task.id, `router requested repair tool ${step.tool}; repair tools are not wired yet`);
      } else if (step.kind === "give_up") {
        return this.fail(task.id, `router gave up: ${step.reason}`);
      } else {
        return this.fail(task.id, step.reason, step.security);
      }
    }
  }

  private async dispatch(task: Task, verdict: Extract<Verdict, { ok: true }>, signal: AbortSignal, handoff: string | null, rejections: number): Promise<DispatchOutcome> {
    const executor = this.deps.executors.find((e) => e.harness === verdict.harness);
    const target: TargetRef = { harness: verdict.harness, model: verdict.model };
    if (!executor) return this.failedAttempt(task, { ...target, kind: "transport", excerpt: `no executor for harness ${verdict.harness}`, sideEffects: NO_SIDE_EFFECTS });
    let release: Release;
    try { release = await this.scheduler.acquireHarness(task, verdict.harness, signal); } catch { return { kind: "cancelled" }; }
    this.ctx.store.updateTask(task.id, { status: "running", harness: verdict.harness, model: verdict.model, effort: verdict.effort });
    this.ctx.emit(task.id, "dispatched", { harness: verdict.harness, model: verdict.model, effort: verdict.effort, chosen: verdict.chosen, brief: task.brief });
    const prot = this.deps.protected ?? NO_PROTECTED;
    const snapshot = snapshotProtected(task.cwd, prot);
    const { threadHome, resume } = this.threads.continuation(task, verdict.harness);
    // One attempt = one abort scope: the supervisor's watchdog can end this attempt without cancelling the task.
    const attemptCtl = new AbortController();
    const onTaskAbort = () => attemptCtl.abort(signal.reason);
    signal.addEventListener("abort", onTaskAbort, { once: true });
    const dog = watchdog(this.ctx, this.deps.supervisor, this.desk, task, attemptCtl);
    try {
      const outcome = await executor.run({
        taskId: task.id, task: task.task, brief: this.composer.brief(task), cwd: task.cwd, model: verdict.model, effort: verdict.effort, attachments: task.attachments,
        handoffNote: handoff, context: this.composer.context()?.text ?? null, knownTokens: this.composer.tokens(task), threadHome, resume,
        browser: task.needsBrowser || (task.decision?.needs_browser ?? false), signal: attemptCtl.signal,
        emit: (type, payload) => { this.ctx.emit(task.id, type, payload); dog.touch(); },
        approve: async (action, evidence) => { dog.pause(); try { return await this.desk.request(task.id, action, evidence); } finally { dog.touch(); } },
      });
      dog.stop();
      const touched = restoreProtected(task.cwd, prot, snapshot);
      if (touched.length) {
        this.ctx.emit(task.id, "attempt_failed", { ...target, kind: "protected", excerpt: touched.join(", "), sideEffects: outcome.sideEffects ?? NO_SIDE_EFFECTS, hadSideEffects: true, security: true });
        return { kind: "protected", paths: touched };
      }
      if (outcome.sessionId && task.threadId) this.ctx.store.appendThreadEvent(task.threadId, "session", { harness: verdict.harness, sessionId: outcome.sessionId, taskId: task.id });
      if (signal.aborted) return { kind: "cancelled" };
      const sideEffects = outcome.sideEffects ?? NO_SIDE_EFFECTS;
      if (dog.cancelledWith !== null) return this.failedAttempt(task, { ...target, kind: "rejected", excerpt: `supervisor cancelled a silent run: ${dog.cancelledWith}`.slice(0, 240), sideEffects });
      if (!outcome.ok) return this.failedAttempt(task, { ...target, kind: classifyFailure(outcome) ?? "unknown", excerpt: excerpt(outcome), sideEffects });
      const check = await acceptance(this.ctx, this.deps.supervisor, task, outcome.lastText ?? "", rejections, signal);
      if (check.rejected) return this.failedAttempt(task, { ...target, kind: "rejected", excerpt: check.rejected.slice(0, 240), sideEffects });
      this.ctx.store.updateTask(task.id, { status: "done", result: outcome.lastText ?? "" });
      this.ctx.emit(task.id, "done", { result: outcome.lastText ?? "", tokens: outcome.tokens ?? 0, sideEffects, agents: outcome.agents ?? NO_AGENTS });
      return { kind: "done" };
    } catch (err) {
      dog.stop();
      if (signal.aborted) return { kind: "cancelled" };
      if (dog.cancelledWith !== null) return this.failedAttempt(task, { ...target, kind: "rejected", excerpt: `supervisor cancelled a silent run: ${dog.cancelledWith}`.slice(0, 240), sideEffects: NO_SIDE_EFFECTS });
      return this.failedAttempt(task, { ...target, kind: "transport", excerpt: (err as Error).message.slice(0, 240), sideEffects: NO_SIDE_EFFECTS });
    } finally {
      signal.removeEventListener("abort", onTaskAbort);
      release();
    }
  }

  private failedAttempt(task: Task, attempt: Attempt): DispatchOutcome {
    this.ctx.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: hasSideEffects(attempt.sideEffects) });
    return { kind: "failed", attempt };
  }

  private cleanup(task: Task): void {
    const artifacts = this.deps.artifactsDir ? collectOut(task.cwd, join(this.deps.artifactsDir, task.id)) : 0;
    const report = cleanupEphemeral(task.cwd, this.deps.cleanupPaths ?? defaultCleanupPaths());
    this.ctx.emit(task.id, "cleaned", { ...report, artifacts });
  }

  private fail(id: string, error: string, security = false): void {
    this.ctx.store.updateTask(id, { status: "failed", error });
    this.ctx.emit(id, "failed", { error, security });
  }
}
