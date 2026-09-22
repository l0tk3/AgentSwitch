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
import { appendMemory, loadMemory } from "../threads/memory.js";
import { RECORD_WINDOW_MS } from "../threads/record.js";
import type { Summarizer } from "../threads/summary.js";
import { kindOf } from "../router/route.js";
import type { ExtensionsSummary } from "../router/prompt.js";
import { loadContext, type LoadedContext } from "../router/context.js";
import { knownTokens, repairTokens, shortToken } from "../executors/tokens.js";
import type { Supervisor } from "../router/supervisor.js";
import { listTree } from "../files/artifacts.js";
import { OUT_DIR } from "../files/names.js";
import type { HandoffReason, ThreadState } from "../threads/types.js";
import type { Bus } from "./bus.js";
import { cleanupEphemeral, defaultCleanupPaths, isDeletableWorkDir, type CleanupPaths } from "./cleanup.js";
import { KeyedLock, Semaphore, type Release } from "./locks.js";
import { NO_AGENTS } from "../router/failure.js";
import { existsSync, rmSync } from "node:fs";
import type { Decision } from "../router/decision.js";
import type { ThreadBrief } from "../threads/types.js";
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
  /** $AGENTSWITCH_HOME/MEMORY.md: read into the router prompt, appended with the summarizer's facts. */
  readonly memoryPath?: string;
  /** $AGENTSWITCH_HOME/CONTEXT.md: re-read on every dispatch (edits on the page take effect at once), given to router and executor. */
  readonly contextPath?: string;
  /** MCP servers and skills, names only, for the router prompt. */
  readonly extensionsSummary?: () => ExtensionsSummary;
  readonly now?: () => number;
  /** Tasks in flight at once (routing or running); the rest queue FIFO (background-v0 §1). */
  readonly maxConcurrentTasks?: number;
  /** docs/supervisor-v0.md: approvals on the user's behalf, watchdog during execution, acceptance on done. */
  readonly supervisor?: Supervisor;
};

export const DEFAULT_MAX_TASKS = 4;

export type HandoffRequest = { readonly to?: TargetRef; readonly cwd?: string; readonly ephemeral?: boolean };

type Waiter = { resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout };

export class Engine {
  private readonly deps: EngineDeps;
  private readonly waiters = new Map<string, Waiter>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running: Record<string, number> = {};
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly global: Semaphore;
  private readonly threadLock = new KeyedLock();
  private readonly cwdLock = new KeyedLock();
  private readonly slots = new Map<string, Semaphore>();
  private readonly rejections = new Map<string, number>();   // acceptance rejections per task (at most one)

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.global = new Semaphore(deps.maxConcurrentTasks ?? DEFAULT_MAX_TASKS);
  }

  /** Persist and enqueue; resolves with the queued task immediately. Every task ends up in a thread: the one
   *  given, the parent's, or (decided at routing time, threads-v0 §6) an open thread the router recognises or
   *  a new one. */
  submit(input: NewTask): Task {
    const parent = input.parentId ? this.deps.store.getTask(input.parentId) : undefined;
    const threadId = input.threadId ?? parent?.threadId ?? null;
    const task = this.deps.store.createTask({ ...input, ...(threadId ? { threadId } : {}) });
    this.emit(task.id, "queued", { task: task.task, cwd: task.cwd, threadId });
    const run = this.process(task.id).catch(() => undefined).finally(() => this.inFlight.delete(task.id));
    this.inFlight.set(task.id, run);
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
    this.deps.store.markUserHandoff(task.id);
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

  /** Wait until every submitted task has ended (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()]);
  }

  /** Tasks in flight per harness (what the router's concurrency check sees). */
  runningByHarness(): Record<string, number> {
    return { ...this.running };
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

  resolveApproval(approvalId: string, decision: ApprovalDecision, status: "allowed" | "denied" | "expired" = decision === "allow" ? "allowed" : "denied", by: "user" | "router" | "timeout" = status === "expired" ? "timeout" : "user"): boolean {
    const approval = this.deps.store.resolveApproval(approvalId, status);
    const waiter = this.waiters.get(approvalId);
    if (!approval || !waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(approvalId);
    this.emit(approval.taskId, "approval_resolved", { approvalId, decision, status, by });
    // A late answer (or expiry) must not revive a task that already ended.
    const current = this.deps.store.getTask(approval.taskId);
    if (current && !TERMINAL_STATUS.has(current.status)) this.deps.store.updateTask(approval.taskId, { status: "running" });
    waiter.resolve(decision);
    return true;
  }

  private emit(taskId: string, type: TaskEventType, payload: Record<string, unknown>): void {
    this.deps.bus.publish(this.deps.store.appendEvent(taskId, type, payload));
  }

  private routeDeps(): RouteDeps {
    const { store, bus: _b, executors: _e, quota, approvalTimeoutMs: _a, retryBackoffMs: _r, cleanupPaths: _c, routingLog: _l, artifactsDir: _d, summarizer: _m, protected: _p, memoryPath, contextPath, extensionsSummary, now: _n, maxConcurrentTasks: _x, ...rest } = this.deps;
    const memory: LoadedContext | undefined = memoryPath ? loadMemory(memoryPath) : undefined;
    const context = this.context();
    return { ...rest, quota: quota(), running: { ...this.running }, records: store.recordsSince(this.now() - RECORD_WINDOW_MS), threads: this.threadBriefs(), ...(context ? { context } : {}), ...(memory ? { memory } : {}), ...(extensionsSummary ? { extensions: extensionsSummary() } : {}) };
  }

  /** Genuine enc:v1: tokens this task may legitimately use: context, memory and the user's own words. */
  private tokensFor(task: Task): ReadonlySet<string> {
    return knownTokens(this.context()?.text, this.deps.memoryPath ? loadMemory(this.deps.memoryPath).text : null, task.task);
  }

  /** A model that retypes a 200-character token drops a character now and then; put the genuine one back. */
  private repairBrief(task: Task, brief: string): string {
    const r = repairTokens(brief, this.tokensFor(task));
    if (r.repairs.length) this.emit(task.id, "text", { text: `(repaired ${r.repairs.length} damaged secret-gate token(s) in the brief: ${r.repairs.map((x) => `${shortToken(x.from)} → ${shortToken(x.to)}`).join(", ")})` });
    return r.text;
  }

  /** CONTEXT.md as of now: the file when a path is configured, else whatever static context the deps carry (tests). */
  private context(): LoadedContext | undefined {
    return this.deps.contextPath ? loadContext(this.deps.contextPath) : this.deps.context;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async process(id: string): Promise<void> {
    const task = this.deps.store.getTask(id);
    if (!task || task.status !== "queued") return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const held: Release[] = [];
    try {
      held.push(await this.gate("global", () => this.global.acquire(controller.signal), task, this.global.full));
      if (task.parentId) await this.awaitParent(task, controller.signal);
      if (controller.signal.aborted) return;
      await this.runTask(task, controller.signal, held);
    } catch (err) {
      if (this.deps.store.getTask(id)?.status !== "cancelled") this.fail(id, (err as Error).message);
    } finally {
      this.controllers.delete(id);
      for (const a of this.deps.store.pendingApprovals(id)) this.resolveApproval(a.id, "deny", "expired");   // the executor moved on without an answer
      for (const release of held.reverse()) release();
      await this.finishThread(id);          // before cleanup: the diff needs the work dir
      const final = this.deps.store.getTask(id) ?? task;   // joining a thread may have moved the task out of its temp dir
      if (final.ephemeral) this.cleanup(final);
    }
  }

  /** Take a lock, announcing the wait (a `waiting` event) only when it is not immediately free. */
  private async gate(what: string, take: () => Promise<Release>, task: Task, busy: boolean): Promise<Release> {
    if (busy) this.emit(task.id, "waiting", { for: what });
    return take();
  }

  /** A follow-up must see its parent's result: wait until the parent has ended. */
  private awaitParent(task: Task, signal: AbortSignal): Promise<void> {
    const parent = this.deps.store.getTask(task.parentId!);
    if (!parent || TERMINAL_STATUS.has(parent.status)) return Promise.resolve();
    this.emit(task.id, "waiting", { for: "parent", taskId: parent.id });
    return new Promise((resolve, reject) => {
      const stop = this.deps.bus.subscribe(parent.id, (ev) => {
        if (ev.type === "done" || ev.type === "failed" || ev.type === "cancelled") { stop(); resolve(); }
      });
      signal.addEventListener("abort", () => { stop(); reject(signal.reason ?? new Error("cancelled")); }, { once: true });
      if (TERMINAL_STATUS.has(this.deps.store.getTask(parent.id)?.status ?? "")) { stop(); resolve(); }   // ended between the check and the subscription
    });
  }

  private slot(harness: string): Semaphore {
    const max = this.deps.targets.harnesses[harness]?.max_concurrent ?? 1;
    const s = this.slots.get(harness) ?? new Semaphore(max);
    this.slots.set(harness, s);
    return s;
  }

  /** Open threads as the router sees them: newest 20, title + one line of summary + last target. */
  threadBriefs(limit = 20): ThreadBrief[] {
    return this.deps.store.listThreads({ status: "open", limit }).map((t) => {
      const st = this.threadState(t.id);
      return { id: t.id, title: t.title ?? st.title, cwd: t.cwd, goal: st.summary?.goal ?? "", progress: st.summary?.progress ?? "", lastTarget: st.lastTarget, lastActivity: st.lastActivity ?? t.updatedAt };
    });
  }

  /** threads-v0 §6: trust the router's thread above the threshold, ask the user below it, else open a new thread.
   *  An ephemeral task that joins a thread moves into the thread's cwd (its empty temp dir is dropped). */
  private async assignThread(task: Task, decision: Decision | null): Promise<Task> {
    if (task.threadId) return task;
    const parent = task.parentId ? this.deps.store.getTask(task.parentId) : undefined;
    if (parent?.threadId) {
      const updated = this.deps.store.updateTask(task.id, { threadId: parent.threadId, status: "routing" });
      this.emit(task.id, "thread", { threadId: parent.threadId, source: "parent", confidence: null, cwd: updated.cwd });
      return updated;
    }
    const wanted = decision?.thread && decision.thread !== "new" ? this.deps.store.getThread(decision.thread) : undefined;
    const confidence = decision?.thread_confidence ?? 0;
    let source: "router" | "user" | "new" = "new";
    let thread = wanted && wanted.status === "open" ? wanted : undefined;
    if (thread && confidence >= this.deps.targets.router.thread_confidence) source = "router";
    else if (thread) {
      const answer = await this.requestApproval(task.id, `归到线程「${thread.title ?? thread.id}」？允许 = 归入并接着做，拒绝 = 新开线程`, `路由器置信度 ${confidence}；线程目录 ${thread.cwd}`, { humanOnly: true });
      if (answer === "allow") source = "user"; else thread = undefined;
    }
    const target = thread ?? this.deps.store.createThread(task.cwd);
    let patch: Partial<Task> = { threadId: target.id, status: "routing" };
    if (thread && task.ephemeral && !task.attachments.length && existsSync(thread.cwd) && thread.cwd !== task.cwd) {
      if (isDeletableWorkDir(task.cwd, this.deps.cleanupPaths ?? defaultCleanupPaths())) rmSync(task.cwd, { recursive: true, force: true });
      patch = { ...patch, cwd: thread.cwd, ephemeral: false };
    }
    const updated = this.deps.store.updateTask(task.id, patch);
    this.emit(task.id, "thread", { threadId: target.id, source, confidence: decision?.thread_confidence ?? null, cwd: updated.cwd });
    return updated;
  }

  /** Thread bookkeeping at the end of every execution: the task record, then the summary (never blocking on failure). */
  private async finishThread(id: string): Promise<void> {
    const task = this.deps.store.getTask(id);
    if (!task?.threadId) return;
    const failed = task.attempts.at(-1);
    const tokens = this.tokensOf(task.id);
    this.deps.store.appendThreadEvent(task.threadId, "task", { taskId: task.id, harness: task.harness, model: task.model, status: task.status, kind: task.status === "failed" ? failed?.kind ?? "unknown" : null, tokens });
    if (task.harness && task.model) {
      const events = this.deps.store.eventsSince(task.id);
      this.deps.store.saveRecord({
        taskId: task.id, ts: this.now(), kind: kindOf(task.task, task.decision), harness: task.harness, model: task.model, status: task.status,
        failureKind: task.status === "failed" ? failed?.kind ?? "unknown" : null, ms: Math.max(0, this.now() - task.createdAt), tokens,
        approvals: events.filter((e) => e.type === "approval_resolved" && e.payload.decision === "allow").length,
        handedOff: events.some((e) => e.type === "handoff"), pinned: task.pin !== null, userHandoff: false,
      });
    }
    if (!this.deps.summarizer) return;
    const previous = this.threadState(task.threadId).summary;
    const r = await this.deps.summarizer({ previous, task: task.task, brief: task.brief, target: `${task.harness ?? "?"}/${task.model ?? "?"}`, status: task.status, result: task.result ?? task.error ?? "", diff: gitDiffSummary(task.cwd), cwd: task.cwd });
    if (!r.summary) { this.emit(task.id, "summary", { ok: false, error: r.error, ms: r.ms }); return; }
    const ev = this.deps.store.appendThreadEvent(task.threadId, "summary", { ...r.summary });
    if (!previous) this.deps.store.updateThread(task.threadId, { title: r.summary.title });
    if (r.summary.spoken) this.deps.store.updateTask(task.id, { spoken: r.summary.spoken });
    // Memory is about the user's environment: a throwaway chat in a temp dir has nothing worth keeping.
    const worthRemembering = !task.ephemeral || kindOf(task.task, task.decision) === "browser";
    const memory = this.deps.memoryPath && worthRemembering && r.summary.facts.length ? appendMemory(this.deps.memoryPath, r.summary.facts, { taskId: task.id, ts: this.now() }) : null;
    this.emit(task.id, "summary", { ok: true, seq: ev.seq, title: r.summary.title, spoken: r.summary.spoken, ms: r.ms, ...(memory ? { remembered: memory.added } : {}) });
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

  private async runTask(initial: Task, signal: AbortSignal, held: Release[]): Promise<void> {
    let task = initial;
    this.deps.store.updateTask(task.id, { status: "routing" });
    const composed = this.composeTask(task);
    const routed = await route({ task: composed, cwd: task.cwd, ...(task.pin ? { pin: task.pin } : {}), needsBrowser: task.needsBrowser, exclude: task.exclude }, this.routeDeps());
    this.deps.routingLog?.record(task.task, task.cwd, routed);
    this.emit(task.id, "routed", { source: routed.source, verdict: routed.verdict, decision: routed.decision, routerMs: routed.routerMs, routerError: routed.routerError });
    if (!routed.verdict.ok) return this.fail(task.id, `no target: ${routed.verdict.notes.join("; ")}`);
    task = await this.assignThread(task, routed.decision);
    if (signal.aborted) return;
    // Locks in a fixed order (background-v0 §1): thread, then cwd; the harness slot is taken per dispatch.
    held.push(await this.gate("thread", () => this.threadLock.acquire(task.threadId!, signal), task, this.threadLock.isHeld(task.threadId!)));
    held.push(await this.gate("cwd", () => this.cwdLock.acquire(task.cwd, signal), task, this.cwdLock.isHeld(task.cwd)));
    if (signal.aborted) return;
    let current = this.deps.store.updateTask(task.id, { decision: routed.decision, brief: this.repairBrief(task, routed.decision?.brief ?? composed) });
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
        current = this.deps.store.updateTask(task.id, { routerAsks: current.routerAsks + 1, decision: next.decision ?? current.decision, brief: next.decision?.brief ? this.repairBrief(task, next.decision.brief) : current.brief });
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
    const slot = this.slot(verdict.harness);
    let release: Release;
    try {
      release = await this.gate(`harness:${verdict.harness}`, () => slot.acquire(signal), task, slot.full);
    } catch { return { kind: "cancelled" }; }
    this.deps.store.updateTask(task.id, { status: "running", harness: verdict.harness, model: verdict.model, effort: verdict.effort });
    this.emit(task.id, "dispatched", { harness: verdict.harness, model: verdict.model, effort: verdict.effort, chosen: verdict.chosen, brief: task.brief });
    this.running[verdict.harness] = (this.running[verdict.harness] ?? 0) + 1;
    const prot = this.deps.protected ?? NO_PROTECTED;
    const snapshot = snapshotProtected(task.cwd, prot);
    const { threadHome, resume } = this.continuation(task, verdict.harness);
    // One attempt = one abort scope: the supervisor's watchdog can end this attempt without cancelling the task.
    const attemptCtl = new AbortController();
    const onTaskAbort = () => attemptCtl.abort(signal.reason);
    signal.addEventListener("abort", onTaskAbort, { once: true });
    const watchdog = this.watchdog(task, attemptCtl);
    try {
      const outcome = await executor.run({
        taskId: task.id, task: task.task, brief: briefFor(task), cwd: task.cwd, model: verdict.model, effort: verdict.effort, attachments: task.attachments,
        handoffNote: handoff, context: this.context()?.text ?? null, knownTokens: this.tokensFor(task), threadHome, resume, browser: task.needsBrowser || (task.decision?.needs_browser ?? false), signal: attemptCtl.signal,
        emit: (type, payload) => { this.emit(task.id, type, payload); watchdog.touch(); },
        approve: async (action, evidence) => { watchdog.pause(); try { return await this.requestApproval(task.id, action, evidence); } finally { watchdog.touch(); } },
      });
      watchdog.stop();
      const touched = restoreProtected(task.cwd, prot, snapshot);
      if (touched.length) { this.emit(task.id, "attempt_failed", { ...target, kind: "protected", excerpt: touched.join(", "), sideEffects: outcome.sideEffects ?? NO_SIDE_EFFECTS, hadSideEffects: true, security: true }); return { kind: "protected", paths: touched }; }
      if (outcome.sessionId && task.threadId) this.deps.store.appendThreadEvent(task.threadId, "session", { harness: verdict.harness, sessionId: outcome.sessionId, taskId: task.id });
      if (signal.aborted) return { kind: "cancelled" };
      if (watchdog.cancelledWith !== null) {
        const attempt: Attempt = { ...target, kind: "rejected", excerpt: `supervisor cancelled a silent run: ${watchdog.cancelledWith}`.slice(0, 240), sideEffects: outcome.sideEffects ?? NO_SIDE_EFFECTS };
        this.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: hasSideEffects(attempt.sideEffects) });
        return { kind: "failed", attempt };
      }
      if (outcome.ok) {
        const verdictOnResult = await this.acceptance(task, outcome.lastText ?? "", signal);
        if (verdictOnResult) {
          const attempt: Attempt = { ...target, kind: "rejected", excerpt: verdictOnResult.slice(0, 240), sideEffects: outcome.sideEffects ?? NO_SIDE_EFFECTS };
          this.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: hasSideEffects(attempt.sideEffects) });
          return { kind: "failed", attempt };
        }
        this.deps.store.updateTask(task.id, { status: "done", result: outcome.lastText ?? "" });
        this.emit(task.id, "done", { result: outcome.lastText ?? "", tokens: outcome.tokens ?? 0, sideEffects: outcome.sideEffects ?? NO_SIDE_EFFECTS, agents: outcome.agents ?? NO_AGENTS });
        return { kind: "done" };
      }
      const kind = classifyFailure(outcome) ?? "unknown";
      const attempt: Attempt = { ...target, kind, excerpt: excerpt(outcome), sideEffects: outcome.sideEffects ?? NO_SIDE_EFFECTS };
      this.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: hasSideEffects(attempt.sideEffects) });
      return { kind: "failed", attempt };
    } catch (err) {
      watchdog.stop();
      if (signal.aborted) return { kind: "cancelled" };
      if (watchdog.cancelledWith !== null) {
        const attempt: Attempt = { ...target, kind: "rejected", excerpt: `supervisor cancelled a silent run: ${watchdog.cancelledWith}`.slice(0, 240), sideEffects: NO_SIDE_EFFECTS };
        this.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: false });
        return { kind: "failed", attempt };
      }
      const attempt: Attempt = { ...target, kind: "transport", excerpt: (err as Error).message.slice(0, 240), sideEffects: NO_SIDE_EFFECTS };
      this.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: false });
      return { kind: "failed", attempt };
    } finally {
      signal.removeEventListener("abort", onTaskAbort);
      this.running[verdict.harness] = Math.max(0, (this.running[verdict.harness] ?? 1) - 1);
      release();
    }
  }

  // ---- supervisor (docs/supervisor-v0.md) ----

  /** Short lines of the task's latest events for the supervisor's prompts. */
  private recentEventLines(taskId: string, n = 20): string[] {
    return this.deps.store.eventsSince(taskId).slice(-n).map((e) => {
      const p = e.payload;
      const t = new Date(e.ts).toISOString().slice(11, 19);
      switch (e.type) {
        case "text": return `${t} text: ${String(p.text ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
        case "tool_call": return `${t} tool ${p.tool ?? "?"}${p.command ? `: ${String(p.command).slice(0, 120)}` : p.denied ? ` denied: ${String(p.denied).slice(0, 80)}` : ""}`;
        case "agent": return `${t} sub-agent ${p.status}: ${String(p.description ?? "").slice(0, 80)}`;
        case "approval_request": return `${t} approval requested: ${String(p.action ?? "").slice(0, 120)}`;
        case "approval_resolved": return `${t} approval ${p.decision} (${p.by ?? p.status})`;
        default: return `${t} ${e.type}`;
      }
    });
  }

  private sideEffectsLine(taskId: string): string {
    const ev = this.deps.store.eventsSince(taskId);
    return `${ev.filter((e) => e.type === "tool_call").length} tool calls, ${ev.filter((e) => e.type === "approval_resolved" && e.payload.decision === "allow").length} approvals granted`;
  }

  /** Ask the supervisor to answer an approval on the user's behalf; the user can still answer first. */
  private superviseApproval(taskId: string, approvalId: string, action: string, evidence: string): void {
    const sup = this.deps.supervisor;
    const task = this.deps.store.getTask(taskId);
    if (!sup || !sup.config.approvals || !task) return;
    void sup.approve({ brief: task.brief ?? task.task, action, evidence, recentEvents: this.recentEventLines(taskId), sideEffects: this.sideEffectsLine(taskId), cwd: task.cwd }).then((v) => {
      if (!this.waiters.has(approvalId)) return;   // the user got there first
      this.emit(taskId, "supervisor", { kind: "approval", approvalId, decision: v.decision, reason: v.reason, source: v.source, ms: v.ms });
      if (v.decision === "allow") this.resolveApproval(approvalId, "allow", "allowed", "router");
      else if (v.decision === "deny") this.resolveApproval(approvalId, "deny", "denied", "router");
    });
  }

  /** No events for `watchdog_ms` → the supervisor looks: continue (reset), cancel (abort this attempt), or ask the user. */
  private watchdog(task: Task, attempt: AbortController): { touch: () => void; pause: () => void; stop: () => void; readonly cancelledWith: string | null } {
    const sup = this.deps.supervisor;
    const ms = sup?.config.watchdog_ms ?? 0;
    const state = { timer: null as NodeJS.Timeout | null, last: this.now(), continues: 0, stopped: false, cancelledWith: null as string | null, started: this.now() };
    const fire = async () => {
      if (state.stopped || !sup) return;
      const silentMs = this.now() - state.last;
      const events = this.deps.store.eventsSince(task.id);
      const agentsRunning = events.filter((e) => e.type === "agent" && e.payload.status === "started").length - events.filter((e) => e.type === "agent" && ["completed", "failed", "stopped"].includes(String(e.payload.status))).length;
      const v = await sup.checkIn({ brief: this.deps.store.getTask(task.id)?.brief ?? task.task, elapsedMs: this.now() - state.started, silentMs, recentEvents: this.recentEventLines(task.id), agentsRunning: Math.max(0, agentsRunning), continues: state.continues, cwd: task.cwd }, attempt.signal);
      if (state.stopped) return;
      this.emit(task.id, "supervisor", { kind: "checkin", action: v.action, note: v.note, source: v.source, silentMs, ms: v.ms });
      if (v.action === "continue") { state.continues++; arm(); return; }
      if (v.action === "cancel") { state.cancelledWith = v.note || "no progress"; attempt.abort(new Error("cancelled by the supervisor")); return; }
      const answer = await this.requestApproval(task.id, `执行已 ${Math.round(silentMs / 1000)} 秒没有动静，继续等吗？允许 = 继续，拒绝 = 取消这次执行并换人`, v.note, { humanOnly: true });
      if (state.stopped) return;
      if (answer === "allow") { state.continues = 0; arm(); return; }
      state.cancelledWith = `the user stopped waiting (${v.note || "no progress"})`;
      attempt.abort(new Error("cancelled by the user via the supervisor"));
    };
    const arm = () => { if (state.timer) clearTimeout(state.timer); if (ms > 0 && sup && !state.stopped) { state.timer = setTimeout(() => void fire(), ms); state.timer.unref?.(); } };
    arm();
    return {
      touch: () => { state.last = this.now(); arm(); },
      pause: () => { if (state.timer) clearTimeout(state.timer); state.timer = null; },
      stop: () => { state.stopped = true; if (state.timer) clearTimeout(state.timer); },
      get cancelledWith() { return state.cancelledWith; },
    };
  }

  /** On done: the supervisor checks the result against the brief. One rejection sends the task back; a second one is
   *  recorded but overruled, so a task cannot loop on acceptance. Returns the rejection text or null. */
  private async acceptance(task: Task, result: string, signal: AbortSignal): Promise<string | null> {
    const sup = this.deps.supervisor;
    if (!sup || !sup.config.acceptance) return null;
    const current = this.deps.store.getTask(task.id) ?? task;
    let outFiles: string[] = [];
    try { outFiles = listTree(join(task.cwd, OUT_DIR)).map((f) => f.path); } catch { /* no out dir */ }
    const v = await sup.accept({ brief: current.brief ?? task.task, result, diff: gitDiffSummary(task.cwd), outFiles, cwd: task.cwd }, signal);
    const overruled = !v.accepted && (this.rejections.get(task.id) ?? 0) >= 1;
    this.emit(task.id, "supervisor", { kind: "acceptance", accepted: v.accepted, missing: v.missing, note: v.note, source: v.source, ms: v.ms, ...(overruled ? { overruled: true } : {}) });
    if (v.accepted || overruled) return null;
    this.rejections.set(task.id, (this.rejections.get(task.id) ?? 0) + 1);
    return `not accepted: ${v.missing.join("; ") || v.note}`;
  }

  /** Same harness in the same thread and the same cwd → resume its last session (threads-v0 §4: no handoff needed). */
  private continuation(task: Task, harness: string): { threadHome: string | null; resume: string | null } {
    const thread = task.threadId ? this.deps.store.getThread(task.threadId) : undefined;
    if (!thread) return { threadHome: null, resume: null };
    const session = this.threadState(thread.id).sessions[harness];
    return { threadHome: thread.home, resume: session && thread.cwd === task.cwd ? session.sessionId : null };
  }

  private requestApproval(taskId: string, action: string, evidence: string, opts: { humanOnly?: boolean } = {}): Promise<ApprovalDecision> {
    const approval = this.deps.store.createApproval(taskId, action, evidence);
    this.deps.store.updateTask(taskId, { status: "waiting_approval" });
    this.emit(taskId, "approval_request", { approvalId: approval.id, action, evidence, humanOnly: opts.humanOnly ?? false });
    const pending = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => this.resolveApproval(approval.id, "deny", "expired"), this.deps.approvalTimeoutMs ?? 10 * 60_000);
      this.waiters.set(approval.id, { resolve, timer });
    });
    if (!opts.humanOnly) this.superviseApproval(taskId, approval.id, action, evidence);
    return pending;
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
