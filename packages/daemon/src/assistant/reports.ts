/** Proactive reports (assistant-v0 §1, step 3): the assistant speaks up in the conversation when a task ends, when one
 *  waits for the user, and when a watched task is due for a progress line. Task events and a timer in the daemon drive
 *  it, never the model's memory, and every line is built from the task store without a model call: a report cannot
 *  fail on the model or invent progress. The phone sounds and, in voice mode, reads each one. */

import type { Bus } from "../engine/bus.js";
import type { Store } from "../engine/store.js";
import { TERMINAL, type Approval, type Task, type TaskEvent } from "../engine/types.js";
import { takeUnannounced, type UpdateResult } from "../files/appUpdate.js";
import { localTime } from "../util/localTime.js";
import { modelName } from "../util/modelName.js";
import type { AssistantLog } from "./log.js";
import { withoutLegend } from "./register.js";

/** The spoken script comes with the summary, seconds after the end; past this the report goes without it. */
export const SUMMARY_WAIT_MS = 45_000;
/** An approval the supervisor settles at once is not the user's business: only one still open after this is. */
export const NEEDS_YOU_GRACE_MS = 5_000;
export const WATCH_TICK_MS = 30_000;
const TITLE_CHARS = 24;
/** A credential in the words of a title: a lock, not half a ciphertext cut off at the title's length. */
const TOKEN = /enc:(?:v1|ref):[A-Za-z0-9_=-]{8,}/g;
const LINE_CHARS = 160;

/** The fixed status words (docs/ui-v0.md §4). */
const ENDED: Readonly<Record<string, string>> = { done: "已完成", partial: "未完成", blocked: "未完成", failed: "失败" };
const ended = (status: string): boolean => Object.hasOwn(ENDED, status);

export type ReporterOptions = {
  readonly log: AssistantLog;
  readonly store: Store;
  readonly bus: Bus;
  readonly now?: () => number;
  readonly summaryWaitMs?: number;
  readonly needsYouGraceMs?: number;
  readonly tickMs?: number;
  /** `$AGENTSWITCH_HOME`: an app update's outcome written there while this daemon runs (one that never started:
   *  the Mac lacked a permission) is told on the next tick; one after a switch at start-up. */
  readonly home?: string;
};

export class Reporter {
  /** Tasks that ended and wait for their summary before the report goes out. */
  private readonly pendingEnds = new Map<string, NodeJS.Timeout>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private unsubscribe: (() => void) | null = null;
  private ticker: NodeJS.Timeout | null = null;

  constructor(private readonly o: ReporterOptions) {}

  start(): void {
    this.unsubscribe = this.o.bus.subscribe("*", (e) => this.onEvent(e));
    this.ticker = setInterval(() => this.tick(), this.o.tickMs ?? WATCH_TICK_MS);
    this.ticker.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.ticker) clearInterval(this.ticker);
    for (const t of [...this.pendingEnds.values(), ...this.timers]) clearTimeout(t);
    this.pendingEnds.clear();
    this.timers.clear();
  }

  private onEvent(e: TaskEvent): void {
    if (ended(e.type)) { this.awaitSummary(e.taskId); return; }
    if (e.type === "cancelled") { this.forget(e.taskId); return; }
    if (e.type === "summary" && this.pendingEnds.has(e.taskId)) { this.reportEnd(e.taskId); return; }
    if (e.type === "approval_request" && typeof e.payload.approvalId === "string") this.later(this.o.needsYouGraceMs ?? NEEDS_YOU_GRACE_MS, () => this.reportNeedsYou(String(e.payload.approvalId)));
  }

  private awaitSummary(taskId: string): void {
    const old = this.pendingEnds.get(taskId);
    if (old) clearTimeout(old);
    const t = setTimeout(() => this.reportEnd(taskId), this.o.summaryWaitMs ?? SUMMARY_WAIT_MS);
    t.unref();
    this.pendingEnds.set(taskId, t);
  }

  private later(ms: number, run: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); run(); }, ms);
    t.unref();
    this.timers.add(t);
  }

  private forget(taskId: string): void {
    const t = this.pendingEnds.get(taskId);
    if (t) clearTimeout(t);
    this.pendingEnds.delete(taskId);
    this.o.log.removeWatch(taskId);
  }

  private reportEnd(taskId: string): void {
    this.forget(taskId);
    const task = this.o.store.getTask(taskId);
    if (!task || !ended(task.status)) return;
    this.say("notice", taskId, endLine(task, titleOf(this.o.store, task)));
  }

  private reportNeedsYou(approvalId: string): void {
    const approval = this.o.store.getApproval(approvalId);
    if (!approval || approval.status !== "pending") return;
    const task = this.o.store.getTask(approval.taskId);
    if (!task || TERMINAL.has(task.status)) return;
    this.say("waiting", task.id, needsYouLine(approval, titleOf(this.o.store, task)));
  }

  /** Due watches: a progress line each; a watch on a task that is gone or ended is dropped. */
  tick(): void {
    if (this.o.home) announceUpdate(this.o.home, this.o.log);
    const now = (this.o.now ?? Date.now)();
    for (const w of this.o.log.takeDue(now)) {
      const task = this.o.store.getTask(w.taskId);
      if (!task || TERMINAL.has(task.status)) { this.o.log.removeWatch(w.taskId); continue; }
      this.say("progress", task.id, progressLine(this.o.store, task, titleOf(this.o.store, task), now));
    }
  }

  private say(kind: "notice" | "waiting" | "progress", taskId: string, text: string): void {
    this.o.log.append({ role: "assistant", text, kind, taskIds: [taskId], clientId: null, replyTo: null });
  }
}

const clip = (text: string, n: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** The thread's title (set by the summary), else the start of what the user asked. */
export function titleOf(store: Store, task: Task): string {
  const thread = task.threadId ? store.getThread(task.threadId) : undefined;
  return thread?.title ?? clip(withoutLegend(task.task).replace(TOKEN, "🔒"), TITLE_CHARS);
}

/** The spoken script when the summary brought one, else its one sentence, else the start of the result or error. */
export function endLine(task: Task, title: string): string {
  const body = task.speech ?? task.spoken ?? (task.status === "done" ? task.result : task.error ?? task.result);
  return `「${title}」${ENDED[task.status] ?? task.status}${body ? `：${clip(body, LINE_CHARS * 2)}` : "。"}`;
}

export function needsYouLine(approval: Approval, title: string): string {
  return `「${title}」等你${approval.kind === "question" ? "回答" : "批准"}：${clip(approval.action, LINE_CHARS)}`;
}

/** How long it has run and the latest thing worth saying: what it waits for, the executor's own words, who has it. */
export function progressLine(store: Store, task: Task, title: string, now: number): string {
  const minutes = Math.max(1, Math.round((now - task.createdAt) / 60_000));
  const waiting = store.pendingApprovals(task.id)[0];
  const latest = waiting ? `等你处理：${clip(waiting.action, LINE_CHARS)}` : latestWords(store.eventsSince(task.id));
  return `「${title}」进行中，${minutes} 分钟${latest ? `：${latest}` : "。"}`;
}

function latestWords(events: readonly TaskEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const p = e.payload as Record<string, unknown>;
    if (e.type === "text" && typeof p.text === "string" && p.text.trim()) return clip(p.text, LINE_CHARS);
    if (e.type === "dispatched") return `交给 ${modelName(String(p.model))}`;
    if (e.type === "routed" || e.type === "queued") return "排队";
  }
  return null;
}

/** What the last install came to, once, in the conversation: the daemon that starts after it tells it. */
export function announceUpdate(home: string, log: AssistantLog): void {
  const result = takeUnannounced(home);
  if (result) log.append({ role: "assistant", text: updateLine(result), kind: "notice", taskIds: [], clientId: null, replyTo: null });
}

export function updateLine(r: UpdateResult): string {
  if (r.ok) return `新版本已安装（构建于 ${localTime(r.to)}），服务运行正常。`;
  if (r.reverted) return `新版本未能启动，已恢复为上一版本（构建于 ${localTime(r.from)}）。${r.reason ? `原因：${clip(r.reason, LINE_CHARS)}` : ""}`;
  return `新版本安装失败。${r.reason ? `原因：${clip(r.reason, LINE_CHARS)}` : ""}`;
}
