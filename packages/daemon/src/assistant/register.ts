/** The task register the assistant reads every turn (assistant-v0 §1.1): what runs or waits and what ended lately,
 *  each with its short id, thread title, state, executor, age, last step and the question it waits on. Built from the
 *  task store on each call; nothing is stored twice. */

import type { Store } from "../engine/store.js";
import { TERMINAL, type Task, type TaskEvent } from "../engine/types.js";
import { LEGEND_HEADER } from "../secrets/sealer.js";
import { ago } from "../util/ago.js";

export const REGISTER_ACTIVE = 10;
export const REGISTER_RECENT = 10;
const EXCERPT = 240;

export type Register = { readonly text: string; readonly activeIds: ReadonlySet<string>; readonly allIds: ReadonlySet<string> };

/** The apps' fixed status words (docs/ui-v0.md §4), so the assistant says a task's state the way the screens do. */
const STATUS: Record<string, string> = { queued: "排队", routing: "进行中", running: "进行中", waiting_approval: "等你处理", done: "已完成", partial: "未完成", blocked: "未完成", failed: "失败", cancelled: "已取消" };

/** The user's text without the sealer's executor legend (it is for executors, not for talking about the task). */
export function withoutLegend(text: string): string {
  const at = text.indexOf(`\n\n${LEGEND_HEADER}`);
  return at >= 0 ? text.slice(0, at) : text;
}

const clip = (text: string, n = EXCERPT) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

export { ago };

/** The latest line worth telling: a step, a dispatch, the executor's own words. */
function lastStep(events: readonly TaskEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const p = e.payload as Record<string, unknown>;
    if (e.type === "dispatched") return `dispatched to ${p.harness}/${p.model}`;
    if (e.type === "step" && p.action === "dispatch") return `step ${p.n}: ${String(p.purpose ?? "do")}${p.reason ? ` — ${clip(String(p.reason), 120)}` : ""}`;
    if (e.type === "text" && typeof p.text === "string" && p.text.trim()) return `executor said: ${clip(p.text, 160)}`;
    if (e.type === "waiting") return `waiting for ${String(p.for)}`;
  }
  return null;
}

function line(store: Store, task: Task, now: number, watchMs: number | undefined): string {
  const thread = task.threadId ? store.getThread(task.threadId) : undefined;
  const parts = [`id ${task.id}`, thread?.title ? `thread "${thread.title}"` : null, STATUS[task.status] ?? task.status,
    task.harness ? `${task.harness}/${task.model}` : null, `${TERMINAL.has(task.status) ? "ended" : "started"} ${ago(now - (TERMINAL.has(task.status) ? task.updatedAt : task.createdAt))}`,
    watchMs ? `watched every ${Math.round(watchMs / 60_000)} min` : null];
  const out = [`- ${parts.filter(Boolean).join(" · ")}`, `  asked: ${clip(withoutLegend(task.task), 160)}`];
  if (!TERMINAL.has(task.status)) {
    const step = lastStep(store.eventsSince(task.id));
    if (step) out.push(`  last step: ${step}`);
    const waiting = store.pendingApprovals(task.id)[0];
    if (waiting) out.push(`  waiting for the user: ${clip(waiting.action, 160)}`);
  } else {
    const outcome = task.speech ?? task.spoken ?? task.result ?? task.error;
    if (outcome) out.push(`  outcome: ${clip(outcome)}`);
  }
  return out.join("\n");
}

export const REGISTER_FOLDERS = 8;
const FOLDER_SCAN = 100;

/** Folders earlier tasks worked in, newest first, each once with the task that last used it — not the throw-away
 *  ones (ephemeral, or under the data directory's work root). "修一下 AgentSwitch 的 bug" after a task in the repo then
 *  goes to the repo with no list kept by hand (this replaced the registered project folders, 2026-09-25). */
export function recentFolders(store: Store, now: number, workRoot?: string): string {
  const seen = new Map<string, Task>();
  for (const t of store.listTasks(FOLDER_SCAN)) {
    if (t.ephemeral || seen.has(t.cwd) || (workRoot && (t.cwd === workRoot || t.cwd.startsWith(`${workRoot}/`)))) continue;
    seen.set(t.cwd, t);
    if (seen.size >= REGISTER_FOLDERS) break;
  }
  if (!seen.size) return "(none)";
  return [...seen.values()].map((t) => `- ${t.cwd} — ${ago(now - t.updatedAt)}: ${clip(withoutLegend(t.task), 80)}`).join("\n");
}

/** `watches`: task id → interval of the watches set (shown so the assistant can change or stop them). */
export function buildRegister(store: Store, now: number, watches: ReadonlyMap<string, number> = new Map()): Register {
  const tasks = store.listTasks(REGISTER_ACTIVE * 4);
  const active = tasks.filter((t) => !TERMINAL.has(t.status)).slice(0, REGISTER_ACTIVE);
  const recent = tasks.filter((t) => TERMINAL.has(t.status)).slice(0, REGISTER_RECENT);
  const text = [
    "Running or waiting:", ...(active.length ? active.map((t) => line(store, t, now, watches.get(t.id))) : ["(none)"]),
    "", "Recently ended:", ...(recent.length ? recent.map((t) => line(store, t, now, undefined)) : ["(none)"]),
  ].join("\n");
  return { text, activeIds: new Set(active.map((t) => t.id)), allIds: new Set([...active, ...recent].map((t) => t.id)) };
}
