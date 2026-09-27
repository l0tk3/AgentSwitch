/** The supervisor's three hooks inside the engine (docs/supervisor-v0.md): answer an approval on the user's
 *  behalf within the approval policy, watch a silent run, and check a finished result against the brief. */

import { join } from "node:path";
import { listTree } from "../files/artifacts.js";
import { OUT_DIR } from "../files/names.js";
import { repairTokens, TOKEN_RE } from "../executors/tokens.js";
import type { Supervisor } from "../router/supervisor.js";
import { evidenceExcerpt } from "../core/evidence.js";
import { gitDiffSummary } from "../threads/handoff.js";
import { whoAnswers, type ApprovalPolicy } from "./approvalPolicy.js";
import type { ApprovalDesk } from "./approvals.js";
import type { EngineContext } from "./context.js";
import { describeAnswers, validateAnswers, type UserAnswers, type UserQuestion } from "../core/questions.js";
import { TERMINAL, type Task } from "./types.js";
import { SUPPORT_CALL_TIMEOUT_MS } from "../core/limits.js";

const RECENT_EVENTS = 20;
/** One event line: text, a command or an approval's action, and a shorter note (a denial, a sub-agent). */
const EVENT_TEXT_CHARS = 160;
const EVENT_DETAIL_CHARS = 120;
const EVENT_NOTE_CHARS = 80;
/** The brief and the final reply in the acceptance check (inside the supervisor's own budgets). */
const ACCEPT_BRIEF_CHARS = 3800;
const ACCEPT_RESULT_CHARS = 7800;
const AGENT_ENDED = new Set(["completed", "failed", "stopped"]);

/** Short lines of the task's latest events for the supervisor's prompts. */
export function recentEventLines(ctx: EngineContext, taskId: string, n = RECENT_EVENTS): string[] {
  return ctx.store.eventsSince(taskId).filter((e) => e.type !== "tool_result").slice(-n).map((e) => {
    const p = e.payload;
    const t = new Date(e.ts).toISOString().slice(11, 19);
    switch (e.type) {
      case "text": return `${t} text: ${String(p.text ?? "").replace(/\s+/g, " ").slice(0, EVENT_TEXT_CHARS)}`;
      case "tool_call": {
        const input = (p.input ?? {}) as Record<string, unknown>;
        const detail = p.command ?? input.command ?? input.url ?? input.file_path ?? input.path ?? input.pattern ?? input.query;
        return `${t} tool ${p.tool ?? "?"}${detail ? `: ${String(detail).slice(0, EVENT_DETAIL_CHARS)}` : p.denied ? ` denied: ${String(p.denied).slice(0, EVENT_NOTE_CHARS)}` : ""}`;
      }
      case "agent": return `${t} sub-agent ${p.status}: ${String(p.description ?? "").slice(0, EVENT_NOTE_CHARS)}`;
      case "approval_request": return `${t} approval requested: ${String(p.action ?? "").slice(0, EVENT_DETAIL_CHARS)}`;
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
  }).catch((err: unknown) => ctx.emit(task.id, "supervisor", { kind: "approval", approvalId, decision: "ask_user", reason: (err as Error).message, source: "error", ms: 0 }));
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
    state.timer = setTimeout(() => { fire().catch((err: unknown) => ctx.emit(task.id, "supervisor", { kind: "checkin", action: "continue", note: (err as Error).message, source: "error", silentMs: 0, ms: 0 })); }, ms);
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
    const answer = await desk.request(task.id, `执行已 ${Math.round(silentMs / 1000)} 秒无新进展。是否继续等待？允许：继续等待；拒绝：取消本次执行并改派`, v.note, { humanOnly: true });
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

/** Completion checks never overrule a rejection or turn an unavailable verifier into success. */
export async function acceptance(ctx: EngineContext, sup: Supervisor | undefined, task: Task, result: string, rejectionsSoFar: number, signal: AbortSignal,
  options: { goal?: string; feedback?: string; required?: boolean; timeoutMs?: number } = {}): Promise<{ rejected: string | null; rejections: number; unavailable?: boolean }> {
  if (!options.required && !sup?.config.acceptance) return { rejected: null, rejections: rejectionsSoFar };
  if (!sup) return { rejected: "无法验证原任务是否完成：验收服务不可用", rejections: rejectionsSoFar + 1, unavailable: true };
  if (signal.aborted || TERMINAL.has(ctx.store.getTask(task.id)?.status ?? "cancelled")) return { rejected: "cancelled", rejections: rejectionsSoFar };
  let outFiles: string[] = [];
  try { outFiles = listTree(join(task.cwd, OUT_DIR)).map((f) => f.path); } catch { outFiles = []; }
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new Error("completion verification timed out")), options.timeoutMs ?? SUPPORT_CALL_TIMEOUT_MS);
  let onAbort!: () => void;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("completion verification cancelled or timed out"));
      combined.addEventListener("abort", onAbort, { once: true });
    });
    combined.throwIfAborted();
    const v = await Promise.race([sup.accept({ brief: evidenceExcerpt(options.goal ?? task.task, ACCEPT_BRIEF_CHARS), result: evidenceExcerpt(result, ACCEPT_RESULT_CHARS), diff: gitDiffSummary(task.cwd), outFiles, cwd: task.cwd, ...(options.feedback ? { feedback: options.feedback } : {}) }, combined), aborted]);
    combined.throwIfAborted();
    if (TERMINAL.has(ctx.store.getTask(task.id)?.status ?? "cancelled")) return { rejected: "cancelled", rejections: rejectionsSoFar };
    const accepted = v.accepted && v.source !== "error";
    ctx.emit(task.id, "supervisor", { kind: "acceptance", accepted, missing: v.missing, note: v.note, source: v.source, ms: v.ms });
    if (accepted) return { rejected: null, rejections: rejectionsSoFar };
    return { rejected: `not accepted: ${v.missing.join("; ") || v.note}`, rejections: rejectionsSoFar + 1, ...(v.source === "error" ? { unavailable: true } : {}) };
  } catch {
    return { rejected: signal.aborted ? "cancelled" : "无法验证原任务是否完成：验收服务不可用或超时", rejections: rejectionsSoFar + 1, unavailable: true };
  } finally {
    clearTimeout(timer);
    if (onAbort) combined.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

export type QuestionMaterial = { readonly userMessage: string; readonly context: string; readonly steps: readonly string[]; readonly knownTokens: ReadonlySet<string>; readonly feedback?: string; readonly observations?: readonly string[] };

/** Every enc:v1: token in the answers must be one the task legitimately holds (a damaged copy is repaired first);
 *  anything else could be an invention and goes to the user instead. */
export function answersUseKnownTokens(answers: UserAnswers, known: ReadonlySet<string>): UserAnswers | null {
  const out: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(answers)) {
    const fixed = list.map((a) => repairTokens(a, known).text);
    if (fixed.some((a) => (a.match(TOKEN_RE) ?? []).some((t) => !known.has(t)))) return null;
    out[id] = fixed;
  }
  return out;
}

/** loop-v0 §6: an executor's question goes to the supervisor first (never in manual mode); what it cannot answer
 *  from the task's own material, or answers with a token the task does not hold, reaches the user's card. */
export async function answerQuestions(ctx: EngineContext, sup: Supervisor | undefined, desk: ApprovalDesk, task: Task, policy: ApprovalPolicy, questions: readonly UserQuestion[], material: QuestionMaterial, signal?: AbortSignal, timeoutMs = SUPPORT_CALL_TIMEOUT_MS): Promise<UserAnswers | null> {
  const stopped = () => signal?.aborted || TERMINAL.has(ctx.store.getTask(task.id)?.status ?? "cancelled");
  if (stopped()) return null;
  if (sup?.answer && policy.mode !== "manual") {
    const current = ctx.store.getTask(task.id) ?? task;
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let onAbort!: () => void;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("question resolution cancelled or timed out"));
        combined.addEventListener("abort", onAbort, { once: true });
      });
      combined.throwIfAborted();
      const v = await Promise.race([sup.answer({ brief: current.brief ?? task.task, userMessage: material.userMessage, context: material.context, steps: material.steps, cwd: task.cwd,
        ...(material.feedback ? { feedback: material.feedback } : {}), ...(material.observations ? { observations: material.observations } : {}),
        questions: questions.map((q) => ({ id: q.id, text: q.originalText ?? q.text, options: q.options.map((o) => o.label), secret: q.secret })) }, combined), aborted]);
      combined.throwIfAborted();
      if (stopped()) return null;
      const checked = v.source === "router" && !v.forward ? validateAnswers(questions, v.answers, true) : null;
      const answers = checked?.ok ? answersUseKnownTokens(checked.answers, material.knownTokens) : null;
      const reason = v.source === "error" ? "调度模型未能核实答复，已转交你确认" : !answers && !v.forward ? "调度模型的答复不完整或含未知凭据，已转交你确认" : v.reason;
      ctx.emit(task.id, "supervisor", { kind: "question", answered: answers !== null, reason, source: v.source, ms: v.ms, questions: questions.map((q) => q.text), text: answers ? describeAnswers(questions, answers) : null });
      if (answers) {
        ctx.emit(task.id, "feedback", { version: 1, source: "router", status: "answered", questions, answers, reason });
        return answers;
      }
    } catch {
      if (stopped()) return null;
      ctx.emit(task.id, "supervisor", { kind: "question", answered: false, reason: controller.signal.aborted ? "调度模型答复超时，已转交你确认" : "调度模型暂不可用，已转交你确认", source: "error", ms: Date.now() - started, questions: questions.map((q) => q.text), text: null });
    } finally {
      clearTimeout(timer);
      if (onAbort) combined.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
  if (stopped()) return null;
  return desk.ask(task.id, questions, "executor");
}
