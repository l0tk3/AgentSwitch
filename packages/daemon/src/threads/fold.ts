/** One linear pass over a thread's event log gives its current state; no mutable state table (threads-v0 §2). */

import type { HandoffRecord, SessionHandle, Summary, TaskRecord, ThreadEvent, ThreadState } from "./types.js";
import { EMPTY_THREAD_STATE } from "./types.js";

function str(v: unknown): string | null { return typeof v === "string" ? v : null; }
function strs(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }

export function summaryFromPayload(p: Readonly<Record<string, unknown>>): Summary | null {
  const title = str(p.title);
  const goal = str(p.goal);
  if (title === null || goal === null) return null;
  return { title, goal, progress: str(p.progress) ?? "", files: strs(p.files), unresolved: strs(p.unresolved), decisions: strs(p.decisions), facts: strs(p.facts), spoken: str(p.spoken) ?? "" };
}

function applyOne(state: ThreadState, ev: ThreadEvent): ThreadState {
  const p = ev.payload;
  const lastActivity = Math.max(state.lastActivity ?? 0, ev.ts);
  switch (ev.type) {
    case "task": {
      const rec: TaskRecord = { taskId: String(p.taskId ?? ""), harness: str(p.harness), model: str(p.model), status: String(p.status ?? "unknown"), kind: str(p.kind), tokens: Number(p.tokens ?? 0), ts: ev.ts };
      const key = rec.harness && rec.model ? `${rec.harness}/${rec.model}` : null;
      const cost = key ? { ...state.cost, [key]: (state.cost[key] ?? 0) + rec.tokens } : state.cost;
      const lastTarget = rec.harness && rec.model ? { harness: rec.harness, model: rec.model } : state.lastTarget;
      return { ...state, tasks: [...state.tasks, rec], cost, lastTarget, lastActivity };
    }
    case "session": {
      const harness = str(p.harness);
      const sessionId = str(p.sessionId);
      if (!harness || !sessionId) return { ...state, lastActivity };
      const handle: SessionHandle = { harness, sessionId, taskId: String(p.taskId ?? ""), ts: ev.ts };
      return { ...state, sessions: { ...state.sessions, [harness]: handle }, lastActivity };
    }
    case "summary": {
      const summary = summaryFromPayload(p);
      // A summary is a boundary: transient progress lines are cleared whether or not it parsed.
      return summary ? { ...state, summary, summarySeq: ev.seq, title: state.title ?? summary.title, progress: [], lastActivity } : { ...state, progress: [], lastActivity };
    }
    case "title": {
      const title = str(p.title);
      return title ? { ...state, title, lastActivity } : { ...state, lastActivity };
    }
    case "handoff": {
      const from = p.from as HandoffRecord["from"] | undefined;
      if (!from || typeof from.harness !== "string") return { ...state, lastActivity };
      const rec: HandoffRecord = { from, to: (p.to as HandoffRecord["to"]) ?? null, reason: String(p.reason ?? "user") as HandoffRecord["reason"], summaryRef: typeof p.summaryRef === "number" ? p.summaryRef : null, ts: ev.ts };
      return { ...state, handoffs: [...state.handoffs, rec], lastActivity };
    }
    case "cost": {
      const cost = p.tokens && typeof p.tokens === "object" ? Object.fromEntries(Object.entries(p.tokens as Record<string, unknown>).map(([k, v]) => [k, Number(v ?? 0)])) : state.cost;
      return { ...state, cost, lastActivity };
    }
    case "progress": {
      const text = str(p.text);
      return text ? { ...state, progress: [...state.progress, text], lastActivity } : { ...state, lastActivity };
    }
    default:
      return state;
  }
}

/** Pure: events in seq order → state. Unknown types are ignored; malformed payloads never throw. */
export function foldThread(events: readonly ThreadEvent[]): ThreadState {
  return [...events].sort((a, b) => a.seq - b.seq).reduce(applyOne, EMPTY_THREAD_STATE);
}
