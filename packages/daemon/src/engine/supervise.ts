/** The supervisor's three hooks inside the engine (docs/supervisor-v0.md): answer an approval on the user's
 *  behalf within the approval policy, watch a silent run, and check a finished result against the brief. */

import { join } from "node:path";
import { listTree } from "../files/artifacts.js";
import { OUT_DIR } from "../files/names.js";
import type { Supervisor } from "../router/supervisor.js";
import { gitDiffSummary } from "../threads/handoff.js";
import { whoAnswers, type ApprovalPolicy } from "./approvalPolicy.js";
import type { ApprovalDesk } from "./approvals.js";
import type { EngineContext } from "./context.js";
import type { Task } from "./types.js";

const RECENT_EVENTS = 20;
const AGENT_ENDED = new Set(["completed", "failed", "stopped"]);

/** Short lines of the task's latest events for the supervisor's prompts. */
export function recentEventLines(ctx: EngineContext, taskId: string, n = RECENT_EVENTS): string[] {
  return ctx.store.eventsSince(taskId).slice(-n).map((e) => {
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

function sideEffectsLine(ctx: EngineContext, taskId: string): string {
  const ev = ctx.store.eventsSince(taskId);
  return `${ev.filter((e) => e.type === "tool_call").length} tool calls, ${ev.filter((e) => e.type === "approval_resolved" && e.payload.decision === "allow").length} approvals granted`;
}

function agentsRunning(ctx: EngineContext, taskId: string): number {
  const ev = ctx.store.eventsSince(taskId).filter((e) => e.type === "agent");
  return Math.max(0, ev.filter((e) => e.payload.status === "started").length - ev.filter((e) => AGENT_ENDED.has(String(e.payload.status))).length);
}

/** Put an approval to the supervisor when the policy allows; the user can still answer first. */
export function superviseApproval(ctx: EngineContext, sup: Supervisor, desk: ApprovalDesk, task: Task, policy: ApprovalPolicy, approvalId: string, action: string, evidence: string): void {
  if (!sup.config.approvals) return;
  const who = whoAnswers(policy, action, evidence);
  if (who.who === "user") { ctx.emit(task.id, "supervisor", { kind: "approval", approvalId, decision: "ask_user", reason: who.because, source: "policy", ms: 0 }); return; }
  void sup.approve({ brief: task.brief ?? task.task, action, evidence, recentEvents: recentEventLines(ctx, task.id), sideEffects: sideEffectsLine(ctx, task.id), cwd: task.cwd, floor: policy.mode !== "auto" }).then((v) => {
    if (!desk.isPending(approvalId)) return;   // the user got there first
    ctx.emit(task.id, "supervisor", { kind: "approval", approvalId, decision: v.decision, reason: v.reason, source: v.source, ms: v.ms });
    if (v.decision === "allow") desk.resolve(approvalId, "allow", "allowed", "router");
    else if (v.decision === "deny") desk.resolve(approvalId, "deny", "denied", "router");
  });
}

export type Watchdog = { touch(): void; pause(): void; stop(): void; readonly cancelledWith: string | null };

/** No events for `watchdog_ms` → the supervisor looks: continue (reset), cancel (abort this attempt), or ask the user. */
export function watchdog(ctx: EngineContext, sup: Supervisor | undefined, desk: ApprovalDesk, task: Task, attempt: AbortController): Watchdog {
  const ms = sup?.config.watchdog_ms ?? 0;
  const state = { timer: null as NodeJS.Timeout | null, last: ctx.now(), started: ctx.now(), continues: 0, stopped: false, cancelledWith: null as string | null };
  const cancel = (why: string, reason: string) => { state.cancelledWith = why; attempt.abort(new Error(reason)); };
  const arm = () => {
    if (state.timer) clearTimeout(state.timer);
    if (ms <= 0 || !sup || state.stopped) return;
    state.timer = setTimeout(() => void fire(), ms);
    state.timer.unref?.();
  };
  const fire = async () => {
    if (state.stopped || !sup) return;
    const silentMs = ctx.now() - state.last;
    const brief = ctx.store.getTask(task.id)?.brief ?? task.task;
    const v = await sup.checkIn({ brief, elapsedMs: ctx.now() - state.started, silentMs, recentEvents: recentEventLines(ctx, task.id), agentsRunning: agentsRunning(ctx, task.id), continues: state.continues, cwd: task.cwd }, attempt.signal);
    if (state.stopped) return;
    ctx.emit(task.id, "supervisor", { kind: "checkin", action: v.action, note: v.note, source: v.source, silentMs, ms: v.ms });
    if (v.action === "continue") { state.continues++; arm(); return; }
    if (v.action === "cancel") return cancel(v.note || "no progress", "cancelled by the supervisor");
    const answer = await desk.request(task.id, `执行已 ${Math.round(silentMs / 1000)} 秒没有动静，继续等吗？允许 = 继续，拒绝 = 取消这次执行并换人`, v.note, { humanOnly: true });
    if (state.stopped) return;
    if (answer === "allow") { state.continues = 0; arm(); return; }
    cancel(`the user stopped waiting (${v.note || "no progress"})`, "cancelled by the user via the supervisor");
  };
  arm();
  return {
    touch: () => { state.last = ctx.now(); arm(); },
    pause: () => { if (state.timer) clearTimeout(state.timer); state.timer = null; },
    stop: () => { state.stopped = true; if (state.timer) clearTimeout(state.timer); },
    get cancelledWith() { return state.cancelledWith; },
  };
}

/** On done: check the result against the brief. One rejection sends the task back; a second is recorded but overruled. */
export async function acceptance(ctx: EngineContext, sup: Supervisor | undefined, task: Task, result: string, rejectionsSoFar: number, signal: AbortSignal): Promise<{ rejected: string | null; rejections: number }> {
  if (!sup?.config.acceptance) return { rejected: null, rejections: rejectionsSoFar };
  const current = ctx.store.getTask(task.id) ?? task;
  let outFiles: string[] = [];
  try { outFiles = listTree(join(task.cwd, OUT_DIR)).map((f) => f.path); } catch { outFiles = []; }
  const v = await sup.accept({ brief: current.brief ?? task.task, result, diff: gitDiffSummary(task.cwd), outFiles, cwd: task.cwd }, signal);
  const overruled = !v.accepted && rejectionsSoFar >= 1;
  ctx.emit(task.id, "supervisor", { kind: "acceptance", accepted: v.accepted, missing: v.missing, note: v.note, source: v.source, ms: v.ms, ...(overruled ? { overruled: true } : {}) });
  if (v.accepted || overruled) return { rejected: null, rejections: rejectionsSoFar };
  return { rejected: `not accepted: ${v.missing.join("; ") || v.note}`, rejections: rejectionsSoFar + 1 };
}
