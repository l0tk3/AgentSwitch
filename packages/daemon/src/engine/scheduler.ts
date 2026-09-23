/** The four gates of background-v0 §1: a global cap, the parent task, one task per thread and per cwd, and one
 *  slot per harness `max_concurrent`. Waiting is announced with a `waiting` event; cancelling a waiter works. */

import type { Targets } from "../router/targets.js";
import type { EngineContext } from "./context.js";
import { KeyedLock, Semaphore, type Release } from "./locks.js";
import { TERMINAL, type Task } from "./types.js";

export const DEFAULT_MAX_TASKS = 4;

export class ExecutionStillRunningError extends Error {}

export class Scheduler {
  private readonly global: Semaphore;
  private readonly threadLock = new KeyedLock();
  private readonly cwdLock = new KeyedLock();
  private readonly slots = new Map<string, Semaphore>();
  private readonly running: Record<string, number> = {};
  private readonly unsettled = new Map<string, Task>();

  constructor(private readonly ctx: EngineContext, private readonly targets: Targets, maxTasks: number = DEFAULT_MAX_TASKS) {
    this.global = new Semaphore(maxTasks);
  }

  /** Tasks currently executing per harness (what the router's concurrency check sees). */
  runningByHarness(): Record<string, number> { return { ...this.running }; }

  acquireGlobal(task: Task, signal: AbortSignal): Promise<Release> {
    return this.gate("global", () => this.global.acquire(signal), task, this.global.full);
  }

  async acquireThread(task: Task, signal: AbortSignal): Promise<Release> {
    const key = task.threadId ?? task.id;
    const release = await this.gate("thread", () => this.threadLock.acquire(key, signal), task, this.threadLock.isHeld(key));
    return this.guardExecution(task, release);
  }

  async acquireCwd(task: Task, signal: AbortSignal): Promise<Release> {
    const release = await this.gate("cwd", () => this.cwdLock.acquire(task.cwd, signal), task, this.cwdLock.isHeld(task.cwd));
    return this.guardExecution(task, release);
  }

  /** Bounded task cleanup must not permit a new writer while its old adapter still runs. */
  quarantineExecution(task: Task, execution: Promise<unknown>): void {
    this.unsettled.set(task.id, task);
    const settled = () => this.unsettled.delete(task.id);
    void execution.then(settled, settled);
  }

  pendingExecution(task: Task): Task | undefined {
    return [...this.unsettled.values()].find((other) => other.cwd === task.cwd || !!task.threadId && other.threadId === task.threadId);
  }

  private guardExecution(task: Task, release: Release): Release {
    const pending = this.pendingExecution(task);
    if (!pending) return release;
    release();
    throw new ExecutionStillRunningError(`任务 ${pending.id} 的执行器尚未退出，已停止本次执行以避免重复操作；退出后请核对现场再继续。`);
  }

  /** A harness slot; counts the harness as running until released. */
  async acquireHarness(task: Task, harness: string, signal: AbortSignal): Promise<Release> {
    const slot = this.slot(harness);
    const release = await this.gate(`harness:${harness}`, () => slot.acquire(signal), task, slot.full);
    this.running[harness] = (this.running[harness] ?? 0) + 1;
    return () => { this.running[harness] = Math.max(0, (this.running[harness] ?? 1) - 1); release(); };
  }

  /** A follow-up must see its parent's result: wait until the parent has ended. */
  awaitParent(task: Task, signal: AbortSignal): Promise<void> {
    const parent = task.parentId ? this.ctx.store.getTask(task.parentId) : undefined;
    if (!parent || TERMINAL.has(parent.status)) return Promise.resolve();
    this.ctx.emit(task.id, "waiting", { for: "parent", taskId: parent.id });
    return new Promise((resolve, reject) => {
      const stop = this.ctx.bus.subscribe(parent.id, (ev) => {
        if (TERMINAL.has(ev.type as Task["status"])) { stop(); resolve(); }
      });
      signal.addEventListener("abort", () => { stop(); reject(signal.reason ?? new Error("cancelled")); }, { once: true });
      const latest = this.ctx.store.getTask(parent.id);
      if (latest && TERMINAL.has(latest.status)) { stop(); resolve(); }   // ended between the check and the subscription
    });
  }

  private async gate(what: string, take: () => Promise<Release>, task: Task, busy: boolean): Promise<Release> {
    if (busy) this.ctx.emit(task.id, "waiting", { for: what });
    return take();
  }

  private slot(harness: string): Semaphore {
    const existing = this.slots.get(harness);
    if (existing) return existing;
    const s = new Semaphore(this.targets.harnesses[harness]?.max_concurrent ?? 1);
    this.slots.set(harness, s);
    return s;
  }
}
