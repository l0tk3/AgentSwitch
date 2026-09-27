/** The task engine: the public surface (submit, handoff, cancel, approvals, answers, ratings) and the gates
 *  around a task's life. What happens inside a task is TaskLoop (docs/loop-v0.md); the pieces live next to it:
 *  Scheduler (gates), ApprovalDesk (questions to humans), ThreadBook (threads, handoffs, records, summary),
 *  Composer (prompts and route deps), supervise (the router as supervisor). */

import type { BrowserSlots } from "../executors/browserSlots.js";
import type { Executor } from "../executors/types.js";
import type { ProtectedPaths } from "../executors/protected.js";
import type { RouteDeps } from "../router/route.js";
import type { Router } from "../core/modelCall.js";
import type { ThreadState } from "../threads/types.js";
import type { ThreadBrief } from "../router/prompt.js";
import type { RoutingLog } from "../router/log.js";
import type { Supervisor } from "../router/supervisor.js";
import type { TargetRef } from "../core/target.js";
import type { Summarizer } from "../threads/summary.js";
import { removeTaskMemories } from "../threads/memory.js";
import { removeTaskPlatformMemories } from "../threads/platformMemory.js";
import { collectOut } from "../files/artifacts.js";
import { join } from "node:path";
import { DEFAULT_POLICY, loadPolicy, type ApprovalPolicy } from "./approvalPolicy.js";
import { ApprovalDesk, type AnswerResult, type GivenAnswer, type ResolvedBy } from "./approvals.js";
import type { Bus } from "./bus.js";
import { cleanupEphemeral, defaultCleanupPaths, type CleanupPaths } from "./cleanup.js";
import { Composer, type ComposeDeps } from "./compose.js";
import { engineContext, type EngineContext } from "./context.js";
import type { Release } from "./locks.js";
import { DEFAULT_MAX_TASKS, ExecutionStillRunningError, Scheduler } from "./scheduler.js";
import type { Store } from "./store.js";
import { superviseApproval } from "./supervise.js";
import { TaskLoop } from "./taskLoop.js";
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
  /** The default work folder in force (docs/control-v0.md §2): a task folder of ours left empty there is removed. */
  readonly taskFolderRoot?: () => string;
  readonly routingLog?: RoutingLog;
  /** Where <cwd>/out is copied before an ephemeral working directory is deleted. */
  readonly artifactsDir?: string;
  /** Rewrites the thread summary after every execution (threads-v0 §3); absent in tests. */
  readonly summarizer?: Summarizer;
  /** Bound all summary work, including a custom summarizer that ignores cancellation. */
  readonly summaryTimeoutMs?: number;
  /** Paths no executor may change; restored after every run as the last line of defense. */
  readonly protected?: ProtectedPaths;
  /** Kept browser profiles so a login carries over (threads-v0 §4b); absent = a throw-away profile per run. */
  readonly browserSlots?: BrowserSlots;
  /** Called after every run that had the browser (the daemon sweeps Chrome's leftover code-sign clones). */
  readonly afterBrowserRun?: () => void;
  readonly now?: () => number;
  /** Tasks in flight at once (routing or running); the rest queue FIFO (background-v0 §1). */
  readonly maxConcurrentTasks?: number;
  /** docs/supervisor-v0.md: approvals on the user's behalf, watchdog during execution, acceptance on done. */
  readonly supervisor?: Supervisor;
  /** Text-only router for translating a question, with no task execution or workspace tools. */
  readonly questionRouter?: Router;
  /** $AGENTSWITCH_HOME/approvals.json: who answers which approvals (manual / auto / scoped). */
  readonly policyPath?: string;
  /** loop-v0 §6: the planner for a multi-step task, given the router's pick (validated by the factory); null = the router runs it. */
  readonly planner?: PlannerFactory;
};

export { MAX_CLARIFICATIONS } from "./taskLoop.js";
import { SUPPORT_CALL_TIMEOUT_MS } from "../core/limits.js";
import { removeIfEmptyTaskFolder, restoreTaskFolder } from "../files/workdir.js";

export type PlannerFactory = (pick: TargetRef | null) => { readonly router: Router; readonly target: TargetRef } | null;

export type HandoffRequest = { readonly to?: TargetRef; readonly cwd?: string; readonly ephemeral?: boolean };
export type DeleteResult = { readonly ok: true } | { readonly ok: false; readonly code: "not_found" | "busy"; readonly error: string };

export const INTERRUPTED_MESSAGE = "服务重启时任务仍在进行，执行进度无法确认。";

export class Engine {
  private readonly ctx: EngineContext;
  private readonly desk: ApprovalDesk;
  private readonly scheduler: Scheduler;
  private readonly threads: ThreadBook;
  private readonly composer: Composer;
  private readonly loop: TaskLoop;
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
    this.loop = new TaskLoop({ ctx: this.ctx, engine: deps, desk: this.desk, scheduler: this.scheduler, threads: this.threads, composer: this.composer, routeDeps: () => this.routeDeps(), policyFor: (t) => this.policyFor(t) });
  }

  // ---- public surface (the API, the CLI and tests) ----

  /** Persist and start; every task ends up in a thread (given, the parent's, or decided at routing time). */
  submit(input: NewTask): Task {
    const parent = input.parentId ? this.ctx.store.getTask(input.parentId) : undefined;
    const threadId = input.threadId ?? parent?.threadId ?? null;
    const { sealed, ...rest } = input;
    const task = this.ctx.store.createTask({ ...rest, ...(threadId ? { threadId } : {}) });
    this.ctx.emit(task.id, "queued", { task: task.task, cwd: task.cwd, threadId });
    if (sealed?.length) this.ctx.emit(task.id, "sealed", { entries: sealed });
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

  /** At start (docs/control-v0.md §4): a task that had not ended when the daemon stopped cannot be confirmed either
   *  way. It becomes blocked ("interrupted"), its open cards expire, and nothing re-runs by itself. */
  interruptLeftovers(): number {
    const left = this.ctx.store.unfinishedTasks();
    for (const task of left) {
      for (const a of this.ctx.store.pendingApprovals(task.id)) this.ctx.store.resolveApproval(a.id, "expired");
      const error = INTERRUPTED_MESSAGE;
      this.ctx.store.updateTask(task.id, { status: "blocked", blockCause: "interrupted", error });
      this.ctx.emit(task.id, "blocked", { cause: "interrupted", error });
    }
    return left.length;
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

  /** Terminal status is published before summaries and cleanup finish; deletion also waits for that work. */
  deleteTask(id: string): DeleteResult {
    const task = this.ctx.store.getTask(id);
    if (!task) return { ok: false, code: "not_found", error: "not found" };
    const related = task.threadId ? this.ctx.store.tasksInThread(task.threadId) : [task];
    const blocked = this.deletionBlocker(related);
    if (blocked) return blocked;
    this.ctx.store.deleteTask(id);
    this.forgetTasks([task]);
    return { ok: true };
  }

  deleteThread(id: string): DeleteResult {
    if (!this.ctx.store.getThread(id)) return { ok: false, code: "not_found", error: "not found" };
    const tasks = this.ctx.store.tasksInThread(id);
    const blocked = this.deletionBlocker(tasks);
    if (blocked) return blocked;
    this.ctx.store.deleteThread(id);
    this.forgetTasks(tasks);
    this.deps.browserSlots?.forgetThread(id);   // the thread's logins go with it
    return { ok: true };
  }

  private deletionBlocker(tasks: readonly Task[]): DeleteResult | null {
    const pending = tasks.map((task) => this.scheduler.pendingExecution(task)).find(Boolean);
    if (pending) return { ok: false, code: "busy", error: `任务 ${pending.id} 的执行器尚未退出，请稍后再删除` };
    const busy = tasks.find((task) => !TERMINAL.has(task.status) || this.inFlight.has(task.id));
    return busy ? { ok: false, code: "busy", error: this.inFlight.has(busy.id) && TERMINAL.has(busy.status)
      ? `task ${busy.id} is still finishing; retry shortly`
      : `task ${busy.id} is still ${busy.status}; cancel it first` } : null;
  }

  private forgetTasks(tasks: readonly Task[]): void {
    for (const task of tasks) this.deps.routingLog?.deleteTask(task.id, task.routeLogId);
    removeTaskMemories(this.deps.memoryPath, tasks.map((task) => task.id));
    if (this.deps.platformMemoryPath) removeTaskPlatformMemories(this.deps.platformMemoryPath, tasks.map((task) => task.id));
  }

  resolveApproval(approvalId: string, decision: "allow" | "deny", status?: Exclude<ApprovalStatus, "pending">, by?: ResolvedBy): boolean {
    return this.desk.resolve(approvalId, decision, status, by);
  }

  answer(approvalId: string, given: GivenAnswer): AnswerResult { return this.desk.answer(approvalId, given); }

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

  threadState(threadId: string): ThreadState { return this.threads.state(threadId); }
  threadBriefs(limit?: number): ThreadBrief[] { return this.threads.briefs(limit); }
  composeTask(task: Task): string { return this.composer.task(task); }
  policyFor(task: Task): ApprovalPolicy { return task.approvalPolicy ?? (this.deps.policyPath ? loadPolicy(this.deps.policyPath) : DEFAULT_POLICY); }

  // ---- lifecycle ----

  private routeDeps(): RouteDeps { return this.composer.routeDeps(this.threads.briefs()); }

  private async process(id: string): Promise<void> {
    const task = this.ctx.store.getTask(id);
    if (!task || task.status !== "queued") return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const held: Release[] = [];
    // Snapshot only older submissions, before our first await; this cannot form a wait cycle.
    const preceding = [...this.inFlight].filter(([otherId]) => {
      const other = this.ctx.store.getTask(otherId);
      return otherId !== id && (otherId === task.parentId || !!task.threadId && other?.threadId === task.threadId);
    }).map(([, promise]) => promise);
    try {
      if (preceding.length) {
        this.ctx.emit(id, "waiting", { for: task.parentId && this.inFlight.has(task.parentId) ? "parent" : "thread", ...(task.parentId ? { taskId: task.parentId } : {}) });
        await waitUnlessCancelled(Promise.all(preceding), controller.signal);
      }
      if (task.parentId) await this.scheduler.awaitParent(task, controller.signal);   // before taking a slot: waiting on a parent costs nothing
      held.push(await this.scheduler.acquireGlobal(task, controller.signal));
      if (controller.signal.aborted) return;
      if (!task.ephemeral && this.deps.taskFolderRoot) restoreTaskFolder(task.cwd, this.deps.taskFolderRoot());
      await this.loop.run(task, controller.signal, held);
    } catch (err) {
      if (!TERMINAL.has(this.ctx.store.getTask(id)?.status ?? "failed")) {
        if (err instanceof ExecutionStillRunningError) {
          this.ctx.store.updateTask(id, { status: "blocked", error: err.message });
          this.ctx.emit(id, "blocked", { error: err.message, remaining: [err.message], dispatches: 0 });
        } else this.fail(id, (err as Error).message);
      }
    } finally {
      this.controllers.delete(id);
      this.desk.expireAll(id);                       // the executor moved on without an answer
      const finishCtl = new AbortController();
      const timer = setTimeout(() => finishCtl.abort(new Error("摘要生成超时")), this.deps.summaryTimeoutMs ?? SUPPORT_CALL_TIMEOUT_MS);
      try {
        // Keep thread/cwd locked until its summary is committed, and bound an unresponsive model.
        await waitUnlessCancelled(this.threads.finish(id, finishCtl.signal), finishCtl.signal);
      } catch {
        this.ctx.emit(id, "summary", { ok: false, error: "摘要未能及时保存；已保留步骤检查点，下次继续前需核对现场" });
      } finally {
        clearTimeout(timer);
        finishCtl.abort();
        try {
          const final = this.ctx.store.getTask(id) ?? task;
          if (final.ephemeral && !this.scheduler.pendingExecution(final)) this.cleanup(final);
          else if (!final.ephemeral && this.deps.taskFolderRoot && TERMINAL.has(final.status)) removeIfEmptyTaskFolder(final.cwd, this.deps.taskFolderRoot());
        } finally { for (const release of held.reverse()) release(); }
      }
    }
  }

  private cleanup(task: Task): void {
    const artifacts = this.deps.artifactsDir ? collectOut(task.cwd, join(this.deps.artifactsDir, task.id)) : 0;
    const report = cleanupEphemeral(task.cwd, this.deps.cleanupPaths ?? defaultCleanupPaths());
    this.ctx.emit(task.id, "cleaned", { ...report, artifacts });
  }

  private fail(id: string, error: string): void {
    const task = this.ctx.store.getTask(id);
    if (!task || TERMINAL.has(task.status)) return;
    this.ctx.store.updateTask(id, { status: "failed", error });
    this.ctx.emit(id, "failed", { error, security: false });
  }
}

async function waitUnlessCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}
