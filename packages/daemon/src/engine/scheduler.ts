/** The four gates of background-v0 §1: a global cap, the parent task, one task per thread and per cwd, and one
 *  slot per harness `max_concurrent`. Waiting is announced with a `waiting` event; cancelling a waiter works. */

import type { Targets } from "../router/targets.js";
import type { EngineContext } from "./context.js";
import { KeyedLock, Semaphore, type Release } from "./locks.js";
import { TERMINAL, type Task } from "./types.js";

export const DEFAULT_MAX_TASKS = 4;

export class Scheduler {
  private readonly global: Semaphore;
  private readonly threadLock = new KeyedLock();
  private readonly cwdLock = new KeyedLock();
  private readonly slots = new Map<string, Semaphore>();
  private readonly running: Record<string, number> = {};

  constructor(private readonly ctx: EngineContext, private readonly targets: Targets, maxTasks: number = DEFAULT_MAX_TASKS) {
    this.global = new Semaphore(maxTasks);
  }

  /** Tasks currently executing per harness (what the router's concurrency check sees). */
  runningByHarness(): Record<string, number> { return { ...this.running }; }

  acquireGlobal(task: Task, signal: AbortSignal): Promise<Release> {
    return this.gate("global", () => this.global.acquire(signal), task, this.global.full);
  }

  acquireThread(task: Task, signal: AbortSignal): Promise<Release> {
    const key = task.threadId ?? task.id;
    return this.gate("thread", () => this.threadLock.acquire(key, signal), task, this.threadLock.isHeld(key));
  }

  acquireCwd(task: Task, signal: AbortSignal): Promise<Release> {
    return this.gate("cwd", () => this.cwdLock.acquire(task.cwd, signal), task, this.cwdLock.isHeld(task.cwd));
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
        if (ev.type === "done" || ev.type === "failed" || ev.type === "cancelled") { stop(); resolve(); }
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
