/** One task from routing to its end (docs/loop-v0.md): route (the router may ask the user first) → a planner takes
 *  over multi-step tasks → thread and locks → [dispatch → outcome → next action]* → done / failed.
 *  Code keeps every floor: target validation, approval policy, protected paths, budgets, the retry/switch rules
 *  after transport and quota failures. The loop model only ever answers "what next" with one JSON object. */

import { namedHosts } from "../executors/browserSlots.js";
import { isReadOnlyCommand, shellCommandOf } from "../executors/readOnly.js";
import { join } from "node:path";
import type { Executor } from "../executors/types.js";
import { NO_PROTECTED, restoreProtected, snapshotProtected } from "../executors/protected.js";
import { knownTokens as tokensIn } from "../executors/tokens.js";
import { listTree } from "../files/artifacts.js";
import { OUT_DIR } from "../files/names.js";
import { classifyFailure, excerpt } from "../router/failure.js";
import { detectRefusal, hasSideEffects, NO_AGENTS, NO_SIDE_EFFECTS, type ExecutionOutcome, type SideEffects } from "../core/outcome.js";
import { LOOP_FAILURE_MESSAGE, MAX_DISPATCHES, MAX_LOOP_STEPS, nextAction, type NextResult } from "../router/loop.js";
import { stepLines, type StepRecord } from "../router/prompt.js";
import { evidenceExcerpt } from "../core/evidence.js";
import { localizeQuestion } from "../router/questionLanguage.js";
import { excludedTargets, nextStep, type Attempt } from "../router/reroute.js";
import { narrowTransfer, pinTransfer, type TransferGrant } from "../core/transfer.js";
import { defaultTargetExcluding, route, type RouteDeps, type RouteRequest, type RouteResult } from "../router/route.js";
import type { Router } from "../core/modelCall.js";
import { routerSupervisor } from "../router/supervisor.js";
import { categoryOf } from "../router/targets.js";
import type { TargetRef } from "../core/target.js";
import type { Verdict } from "../router/validate.js";
import { gitDiffSummary } from "../threads/handoff.js";
import type { HandoffReason } from "../threads/types.js";
import { sleep } from "../util/sleep.js";
import type { ApprovalPolicy } from "./approvalPolicy.js";
import type { ApprovalDesk } from "./approvals.js";
import type { Composer } from "./compose.js";
import type { EngineContext } from "./context.js";
import type { EngineDeps } from "./engine.js";
import type { Release } from "./locks.js";
import { CLARIFY_ID, clarifyQuestion } from "../core/questions.js";
import { recoverRefusal } from "./refusal.js";
import type { Scheduler } from "./scheduler.js";
import { acceptance, answerQuestions, recentEventLines, watchdog } from "./supervise.js";
import type { ThreadBook } from "./threadBook.js";
import { TERMINAL, type BlockCause, type Task } from "./types.js";
import { ATTEMPT_EXCERPT_CHARS } from "../core/limits.js";

export const MAX_CLARIFICATIONS = 2;
/** An aborted executor gets this long to settle before its execution is quarantined. */
const EXIT_GRACE_MS = 2_000;
/** Excerpts: a rejection's or a transport failure's evidence, the steps shown when asking for more budget, a
 *  checkpoint's brief, and the text observed during a silent run. */
const ATTEMPT_EVIDENCE_CHARS = 500;
const BUDGET_STEPS_SHOWN = 3;
const BUDGET_EVIDENCE_CHARS = 2000;
const CHECKPOINT_BRIEF_CHARS = 8_000;
const OBSERVED_TEXT_CHARS = 4_000;
const OBSERVED_EVENTS = 12;

/** Prefixed to the brief of a read-only step; its approval requests are refused outright (loop-v0 §6). */
export const READ_ONLY_BRIEF: Record<"research" | "verify", string> = {
  research: "This is a read-only research step: look and report; change nothing, create nothing, submit no form, send nothing. Commands that only read inside the working directory (git log/status/diff/show, ls, cat, head, grep, find, wc) run without asking; any other action that needs approval will be refused.",
  verify: "This is a read-only verification step: check the earlier work and report; change nothing, submit nothing. Commands that only read inside the working directory (git log/status/diff/show, ls, cat, head, grep, find, wc) run without asking; any other action that needs approval will be refused.",
};

export type LoopDeps = {
  readonly ctx: EngineContext;
  readonly engine: EngineDeps;
  readonly desk: ApprovalDesk;
  readonly scheduler: Scheduler;
  readonly threads: ThreadBook;
  readonly composer: Composer;
  readonly routeDeps: () => RouteDeps;
  readonly policyFor: (task: Task) => ApprovalPolicy;
};

type OkVerdict = Extract<Verdict, { ok: true }>;
type Purpose = "research" | "do" | "verify";

type DispatchOutcome =
  | { readonly kind: "succeeded"; readonly outcome: ExecutionOutcome }
  | { readonly kind: "cancelled" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "failed"; readonly attempt: Attempt; readonly result: string }
  | { readonly kind: "protected"; readonly paths: readonly string[] };

/** The loop's state between steps; replaced, never mutated. */
type State = {
  readonly current: Task;
  readonly verdict: Verdict;
  readonly steps: readonly StepRecord[];
  readonly attempts: readonly Attempt[];
  readonly handoff: string | null;
  readonly dispatches: number;
  readonly budget: number;
  readonly loopCalls: number;
  readonly loopBudget: number;
  readonly rejections: number;
  /** The planner once a task is multi-step; null = the router decides. */
  readonly planner: Router | null;
  /** Once true, every successful step goes back to the loop model: the router said multi, or a research/verify step ran. */
  readonly looping: boolean;
  readonly lastSuccess: ExecutionOutcome | null;
  readonly tokens: number;
  readonly sideEffects: SideEffects;
  readonly refusalRetried: boolean;
  /** Only the immediate clarification attempt; its failure must never fall through to target switching. */
  readonly clarificationPending: boolean;
  /** The one correction round after an acceptance rejection has been used (router-v0 §6.2). */
  readonly corrected?: boolean;
  /** §5.2 grant pinned from the first routing decision (the router saw only the user's task and trusted context). */
  readonly transfer: TransferGrant | null;
  /** The grant for the current decision's dispatches: the pin, or a subset a later step decision restated. */
  readonly stepTransfer: TransferGrant | null;
};

type FailureContext = { readonly failed: Attempt; readonly reason: HandoffReason; readonly exclude: readonly TargetRef[] };

const addEffects = (a: SideEffects, b: SideEffects): SideEffects => ({ filesChanged: a.filesChanged + b.filesChanged, commandsRun: a.commandsRun + b.commandsRun, approvalsGranted: a.approvalsGranted + b.approvalsGranted });

export class TaskLoop {
  constructor(private readonly d: LoopDeps) {}

  private get ctx(): EngineContext { return this.d.ctx; }

  private active(id: string, signal?: AbortSignal): boolean {
    const current = this.ctx.store.getTask(id);
    return !signal?.aborted && !!current && !TERMINAL.has(current.status);
  }

  /** The loop model timed out once and is asked again (loop-v0 §8): shown, so the longer wait is not silence. */
  private retrying(task: Task, planner: Router | null): () => void {
    return () => this.ctx.emit(task.id, "step", { n: 0, action: "plan", source: "retry", model: (planner ?? this.d.engine.router).name, timeoutMs: this.loopTimeout(planner) });
  }

  private loopTimeout(planner: Router | null): number {
    return planner ? this.d.engine.targets.router.planner_timeout_ms : this.d.engine.targets.router.timeout_ms;
  }

  async run(initial: Task, signal: AbortSignal, held: Release[]): Promise<void> {
    this.ctx.store.updateTask(initial.id, { status: "routing" });
    const first = await this.routeWithQuestions(initial, this.d.composer.task(initial), signal);
    if (!first || !this.active(initial.id, signal)) return;
    const { routed, composed } = first;
    const routeLogId = this.d.engine.routingLog?.record(initial.task, initial.cwd, routed, this.ctx.now(), initial.id) ?? null;
    if (routeLogId !== null) this.ctx.store.updateTask(initial.id, { routeLogId });
    this.ctx.emit(initial.id, "routed", { source: routed.source, verdict: routed.verdict, decision: routed.decision, routerMs: routed.routerMs, routerError: routed.routerError });
    if (!routed.verdict.ok) return this.fail(initial.id, routed.decision?.action === "give_up"
      ? `调度模型已停止：${routed.decision.reason || "未提供原因"}`
      : `no target: ${routed.verdict.notes.join("; ")}`);
    const task = await this.d.threads.assign(initial, routed.decision, (q, e) => this.d.desk.request(initial.id, q, e, { humanOnly: true }));
    if (signal.aborted) return;
    // Locks in a fixed order (background-v0 §1): thread, then cwd; the harness slot is taken per dispatch.
    held.push(await this.d.scheduler.acquireThread(task, signal));
    held.push(await this.d.scheduler.acquireCwd(task, signal));
    if (signal.aborted) return;
    const current = this.ctx.store.updateTask(task.id, { decision: routed.decision, brief: this.d.composer.repairBrief(task, routed.decision?.brief ?? composed) });
    const transfer = this.pinTransfer(current);
    let st: State | null = {
      current, verdict: routed.verdict, steps: [], attempts: [], dispatches: 0, budget: MAX_DISPATCHES, loopCalls: 0, loopBudget: MAX_LOOP_STEPS, rejections: 0, planner: null, lastSuccess: null, tokens: 0, sideEffects: NO_SIDE_EFFECTS, refusalRetried: false, clarificationPending: false, transfer, stepTransfer: transfer,
      looping: current.decision?.plan === "multi" && !task.pin,
      handoff: [task.handoffFrom ? this.d.threads.handoffText(task, task.handoffFrom, task.decision?.handoff_note ?? null) : null, this.d.composer.checkpointContext(current)].filter(Boolean).join("\n\n") || null,
    };
    if (current.decision?.plan === "multi" && !task.pin) st = await this.escalate(task, composed, st, signal);
    while (st) st = await this.step(task, composed, st, signal);
  }

  /** gate-next-v0 §5.2: the first routing decision is the only source of a field-transfer grant, and its hosts must be
   *  named in the user's own statements. Every outcome is audited (`transfer_grant`); a dropped grant never blocks the task. */
  private pinTransfer(task: Task): TransferGrant | null {
    const pin = pinTransfer(task.decision?.transfer, this.d.composer.refusalSources(task).map((source) => source.text));
    if (pin.note) this.ctx.emit(task.id, "transfer_grant", { status: "dropped", stage: "route", reason: pin.note });
    else if (pin.grant) this.ctx.emit(task.id, "transfer_grant", { status: "pinned", ...pin.grant });
    return pin.grant;
  }

  /** Route, letting the router ask the user first (at most MAX_CLARIFICATIONS rounds). Null when the task failed. */
  private async routeWithQuestions(task: Task, composed: string, signal: AbortSignal): Promise<{ routed: RouteResult; composed: string } | null> {
    let text = composed;
    let routed = await route(this.request(task, text), this.d.routeDeps());
    if (!this.active(task.id, signal)) return null;
    for (let round = 0; routed.clarify && round < MAX_CLARIFICATIONS; round++) {
      this.ctx.emit(task.id, "routed", { source: routed.source, verdict: routed.verdict, decision: routed.decision, routerMs: routed.routerMs, routerError: routed.routerError, clarify: routed.clarify });
      const answer = await this.askUser(task, routed.clarify, signal);
      if (signal.aborted) return null;
      if (answer === null) { this.incomplete(task, null, `waiting for your answer: ${routed.clarify}`, "blocked", undefined, "question"); return null; }
      text = `${text}\n\nUser clarification (in reply to "${routed.clarify}"):\n${answer}`;
      this.ctx.store.updateTask(task.id, { status: "routing" });
      routed = await route(this.request(task, text), this.d.routeDeps());
      if (!this.active(task.id, signal)) return null;
    }
    if (routed.clarify) { this.fail(task.id, `the router kept asking questions: ${routed.clarify}`); return null; }
    return { routed, composed: text };
  }

  private request(task: Task, text: string): RouteRequest {
    const feedback = this.d.composer.feedbackContext(this.ctx.store.getTask(task.id) ?? task);
    return { task: feedback ? `${text}\n\n${feedback}` : text, cwd: task.cwd, ...(task.pin ? { pin: task.pin } : {}), needsBrowser: task.needsBrowser, exclude: task.exclude };
  }

  private async askUser(task: Task, question: string, signal: AbortSignal): Promise<string | null> {
    const text = await localizeQuestion(this.d.engine.questionRouter ?? this.d.engine.router, question, task.cwd, this.d.engine.targets.router.timeout_ms, signal);
    if (signal.aborted) return null;
    const answers = await this.d.desk.ask(task.id, [clarifyQuestion(text, question)], "router");
    return answers?.[CLARIFY_ID]?.[0] ?? null;
  }

  /** The planner owns a multi-step task; an unusable plan leaves it blocked before any dispatch. */
  private async escalate(task: Task, composed: string, st: State, signal: AbortSignal): Promise<State | null> {
    const pick = st.current.decision?.planner ?? null;
    const chosen = this.d.engine.planner?.(pick) ?? null;
    if (!chosen) { this.ctx.emit(task.id, "step", { n: 0, action: "plan", source: "none", pick, note: "no usable planner; the router runs the loop" }); return st; }
    const planner = chosen.router;
    this.ctx.emit(task.id, "step", { n: 0, action: "plan", model: `${chosen.target.harness}/${chosen.target.model}`, pick, reason: st.current.decision?.reason ?? "" });
    const note: StepRecord = { kind: "note", text: `The dispatcher triaged this as a multi-step task: ${st.current.decision?.reason || "(no reason given)"}. Plan it from the start.` };
    const r = await nextAction(planner, this.d.routeDeps(), { req: this.request(task, composed), steps: [note], used: 0, budget: st.budget, exclude: [], timeoutMs: this.loopTimeout(planner), transfer: st.transfer }, signal, this.retrying(task, planner));
    if (!this.active(task.id, signal)) return null;
    if (!r.action) return this.planningFailure(task, st, r, "initial_plan", `${chosen.target.harness}/${chosen.target.model}`);
    return this.applyAction(task, composed, { ...st, planner, loopCalls: 1 }, r, null, signal);
  }

  /** One dispatch and whatever follows it. Null ends the loop (the task is done, failed or cancelled). */
  private async step(task: Task, composed: string, st: State, signal: AbortSignal): Promise<State | null> {
    if (!this.active(task.id, signal)) return null;
    if (!st.verdict.ok) { this.fail(task.id, `no target: ${st.verdict.notes.join("; ")}`); return null; }
    if (st.dispatches >= st.budget) {
      if (st.clarificationPending) { this.fail(task.id, "refusal: dispatch budget exhausted before the clarification retry"); return null; }
      const more = await this.askForMore(task, `已派发 ${st.dispatches} 次，任务仍未完成。是否继续？允许：再派发最多 ${MAX_DISPATCHES} 次；拒绝：停止`, st);
      if (!this.active(task.id, signal)) return null;
      if (!more) { this.incomplete(task, st, `stopped after ${st.dispatches} dispatches`); return null; }
      return { ...st, budget: st.budget + MAX_DISPATCHES };
    }
    const purpose: Purpose = st.current.decision?.purpose ?? "do";
    const outcome = await this.dispatch(st.current, st.verdict, signal, st.handoff, purpose, st);
    if (!this.active(task.id, signal)) return null;
    if (outcome.kind === "cancelled") return null;
    if (outcome.kind === "blocked") { this.incomplete(task, st, outcome.reason, "blocked", undefined, "question"); return null; }
    if (outcome.kind === "protected") { this.fail(task.id, `executor changed protected files (restored): ${outcome.paths.join(", ")}`, true); return null; }
    const after: State = { ...st, dispatches: st.dispatches + 1, steps: [...st.steps, this.record(st.current, st.verdict, purpose, outcome)], looping: st.looping || purpose !== "do" };
    if (outcome.kind === "failed") return this.afterFailure(task, composed, after, outcome.attempt, signal);
    const done: State = { ...after, clarificationPending: false, lastSuccess: outcome.outcome, tokens: after.tokens + (outcome.outcome.tokens ?? 0), sideEffects: addEffects(after.sideEffects, outcome.outcome.sideEffects ?? NO_SIDE_EFFECTS) };
    if (done.planner !== null || done.looping) return this.decideNext(task, composed, done, signal);
    // A single-step task: the supervisor's acceptance (when configured) is the only check before done.
    const check = await acceptance(this.ctx, this.d.engine.supervisor, done.current, outcome.outcome.lastText ?? "", done.rejections, signal, { goal: composed, feedback: this.d.composer.feedbackContext(done.current) ?? "", timeoutMs: this.d.engine.targets.router.timeout_ms });
    if (!this.active(task.id, signal)) return null;
    if (!check.rejected) { this.finish(task, done, null); return null; }
    if (check.unavailable || done.rejections >= 1) { this.incomplete(task, done, check.rejected); return null; }
    const attempt: Attempt = { harness: st.verdict.harness, model: st.verdict.model, kind: "rejected", acceptance: true, excerpt: evidenceExcerpt(check.rejected, ATTEMPT_EVIDENCE_CHARS), sideEffects: outcome.outcome.sideEffects ?? NO_SIDE_EFFECTS, sideEffectsKnown: outcome.outcome.sideEffectsKnown ?? outcome.outcome.sideEffects !== undefined };
    this.ctx.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: hasSideEffects(attempt.sideEffects) });
    return this.afterFailure(task, composed, { ...done, clarificationPending: st.clarificationPending, rejections: check.rejections }, attempt, signal);
  }

  /** Code rules first (retry / switch / stop); everything else is the loop model's call, the failed target excluded. */
  private async afterFailure(task: Task, composed: string, st: State, attempt: Attempt, signal: AbortSignal): Promise<State | null> {
    if (!this.active(task.id, signal)) return null;
    const attempts = [...st.attempts, attempt];
    const current = this.ctx.store.updateTask(task.id, { attempts, status: "routing" });
    // Resolve refusals before the normal loop, including its model-switch and finish fallbacks.
    if (attempt.kind === "refusal") {
      const recovery = await recoverRefusal(this.d, current, attempt, st.refusalRetried, signal);
      if (recovery.kind === "cancelled") return null;
      if (recovery.kind === "stop") { this.fail(task.id, recovery.error); return null; }
      if (recovery.kind === "resend") {
        // The same brief to the same target; the flagged session is already dropped, so it starts a new one.
        this.ctx.emit(task.id, "redispatch", { kind: "provider_safety", target: { harness: attempt.harness, model: attempt.model } });
        return { ...st, current, attempts, refusalRetried: true, clarificationPending: true };
      }
      const brief = this.d.composer.repairBrief(current, recovery.brief);
      const updated = this.ctx.store.updateTask(task.id, { brief, ...(current.decision ? { decision: { ...current.decision, brief } } : {}) });
      this.ctx.emit(task.id, "redispatch", { kind: "clarification", target: { harness: attempt.harness, model: attempt.model } });
      return { ...st, current: updated, attempts, refusalRetried: true, clarificationPending: true };
    }
    if (st.clarificationPending) {
      const note = `the clarification retry ended with ${attempt.kind}; no automatic fallback`;
      this.ctx.emit(task.id, "refusal", { action: "stop", reason: "unknown", note });
      this.fail(task.id, note, attempt.kind === "gate_denied");
      return null;
    }
    // A result the acceptance check rejected goes back to the executor that wrote it, once: its own session resumed
    // (it knows what it ran), the reason in its handoff. Checking its work against the real state is what it can do
    // best, commands run or not; "stop and check the scene" was the user's job before (router-v0 §6.2, 2026-09-24).
    if (attempt.kind === "rejected" && attempt.acceptance && !st.corrected) {
      const target = { harness: attempt.harness, model: attempt.model };
      this.ctx.emit(task.id, "redispatch", { kind: "correction", target, reason: attempt.excerpt });
      const effort = st.verdict.ok ? st.verdict.effort : null;
      return { ...st, current, attempts, corrected: true, verdict: { ok: true, ...target, effort, chosen: "router", notes: [] }, handoff: correctionNote(attempt.excerpt) };
    }
    const deps = this.d.routeDeps();
    const req = this.request(task, composed);
    const tried = attempts.map((a) => ({ harness: a.harness, model: a.model }));
    const step = nextStep({ decision: current.decision, attempts, routerAsks: current.routerAsks, targets: deps.targets, quota: deps.quota,
      lowConfidenceTarget: defaultTargetExcluding(req, deps, tried), category: categoryOf(composed, deps.targets) });
    const reason: HandoffReason = attempt.kind === "quota" ? "quota" : `failure:${attempt.kind}`;
    let base: State = { ...st, current, attempts };
    if (step.kind === "stop") {
      if (!step.security && (attempt.sideEffectsKnown === false || hasSideEffects(attempt.sideEffects) || attempt.kind === "rejected")) this.incomplete(task, base, step.reason, "blocked");
      else if (!step.security && st.lastSuccess) this.incomplete(task, base, step.reason);
      else this.fail(task.id, step.reason, step.security);
      return null;
    }
    if (step.kind === "retry") {
      this.ctx.emit(task.id, "redispatch", { kind: "retry", target: step.target, backoffMs: step.backoffMs });
      try { await sleep(this.d.engine.retryBackoffMs ?? step.backoffMs, signal); } catch { return null; }
      return { ...base, verdict: { ok: true, harness: step.target.harness, model: step.target.model, effort: null, chosen: "router", notes: [] } };
    }
    if (step.kind === "switch") {
      this.ctx.emit(task.id, "redispatch", { kind: "switch", target: step.target, notes: step.notes });
      const verdict: Verdict = { ok: true, harness: step.target.harness, model: step.target.model, effort: null, chosen: "fallback", notes: step.notes };
      return { ...base, verdict, handoff: this.d.threads.recordHandoff(current, attempt, reason, step.target, null) };
    }
    if (base.loopCalls >= base.loopBudget) {
      const more = await this.askForMore(task, `调度已执行 ${base.loopCalls} 步。是否增加 ${MAX_LOOP_STEPS} 步用于分析本次失败？`, base);
      if (!this.active(task.id, signal)) return null;
      if (!more) { this.incomplete(task, base, "调度预算已用尽，失败原因和剩余工作尚未处理"); return null; }
      base = { ...base, loopBudget: base.loopBudget + MAX_LOOP_STEPS };
    }
    const r = await nextAction(st.planner ?? deps.router, deps, { req, steps: st.steps, used: st.dispatches, budget: st.budget, exclude: step.exclude, timeoutMs: this.loopTimeout(st.planner), transfer: st.transfer }, signal, this.retrying(task, st.planner));
    if (!this.active(task.id, signal)) return null;
    const asked = this.ctx.store.updateTask(task.id, { routerAsks: current.routerAsks + 1 });
    return this.applyAction(task, composed, { ...base, current: asked, loopCalls: st.loopCalls + 1 }, r, { failed: attempt, reason, exclude: step.exclude }, signal);
  }

  /** After a successful research/verify/multi-step dispatch: the loop model says what comes next. */
  private async decideNext(task: Task, composed: string, st: State, signal: AbortSignal): Promise<State | null> {
    if (!this.active(task.id, signal)) return null;
    if (st.loopCalls >= st.loopBudget) {
      const more = await this.askForMore(task, `调度已执行 ${st.loopCalls} 步，任务仍未结束。是否继续？允许：再增加 ${MAX_LOOP_STEPS} 步；拒绝：保留进度并停止`, st);
      if (!this.active(task.id, signal)) return null;
      if (!more) { this.incomplete(task, st, "调度预算已用尽，尚未确认原任务完成"); return null; }
      return this.decideNext(task, composed, { ...st, loopBudget: st.loopBudget + MAX_LOOP_STEPS }, signal);
    }
    this.ctx.store.updateTask(task.id, { status: "routing" });
    const deps = this.d.routeDeps();
    const r = await nextAction(st.planner ?? deps.router, deps, { req: this.request(task, composed), steps: st.steps, used: st.dispatches, budget: st.budget, exclude: excludedTargets(st.attempts), timeoutMs: this.loopTimeout(st.planner), transfer: st.transfer }, signal, this.retrying(task, st.planner));
    return this.applyAction(task, composed, { ...st, loopCalls: st.loopCalls + 1 }, r, null, signal);
  }

  /** Turn the loop model's reply into the next state: a validated dispatch, a question card, or the end. */
  private async applyAction(task: Task, composed: string, st: State, r: NextResult, failure: FailureContext | null, signal: AbortSignal): Promise<State | null> {
    if (!this.active(task.id, signal)) return null;
    const n = st.steps.length + 1;
    const a = r.action;
    if (!a) return this.planningFailure(task, st, r, "next_action", (st.planner ?? this.d.engine.router).name);
    if (a.kind === "give_up") { this.fail(task.id, `router gave up: ${a.reason}`); return null; }
    if (a.kind === "repair") { this.fail(task.id, `router requested repair tool ${a.tool}; repair tools are not wired yet`); return null; }
    if (a.kind === "finish") {
      this.ctx.emit(task.id, "step", { n, action: "finish", completion: a.completion, remaining: a.remaining, reason: a.reason, model: (st.planner ?? this.d.engine.router).name, routerMs: r.routerMs });
      if (a.completion !== "complete") { this.incomplete(task, st, a.remaining.join("\n"), a.completion, a.result); return null; }
      const verifier = this.d.engine.supervisor ?? routerSupervisor(st.planner ?? this.d.engine.router, { approvals: false, acceptance: true, watchdog_ms: 0, max_continues: 0 }, this.d.engine.targets.router.timeout_ms);
      const evidence = `Candidate final result:\n${a.result ?? ""}\n\nExecution evidence (each step success is not proof of overall completion):\n${stepLines(st.steps).join("\n") || "No executor steps were performed."}`;
      const checked = await acceptance(this.ctx, verifier, st.current, evidence, st.rejections, signal, { goal: composed, feedback: this.d.composer.feedbackContext(st.current) ?? "", required: true, timeoutMs: this.d.engine.targets.router.timeout_ms });
      if (!this.active(task.id, signal)) return null;
      if (checked.rejected) { this.incomplete(task, st, checked.rejected, undefined, a.result); return null; }
      this.finish(task, st, a.result);
      return null;
    }
    if (a.kind === "ask_user") {
      this.ctx.emit(task.id, "step", { n, action: "ask_user", question: a.question, model: (st.planner ?? this.d.engine.router).name, routerMs: r.routerMs });
      const answer = await this.askUser(task, a.question, signal);
      if (signal.aborted) return null;
      if (answer === null) { this.incomplete(task, st, `waiting for your answer: ${a.question}`, "blocked", undefined, "question"); return null; }
      return this.decideNext(task, composed, { ...st, steps: [...st.steps, { kind: "ask_user", question: a.question, answer }] }, signal);
    }
    const decision = a.decision;
    const current = this.ctx.store.updateTask(task.id, { decision, brief: this.d.composer.repairBrief(task, decision.brief), status: "routing" });
    const logId = this.d.engine.routingLog?.record(task.task, task.cwd, { verdict: a.verdict, decision, source: a.source, routerError: null, routerMs: r.routerMs, attempts: st.attempts.length }, this.ctx.now(), task.id) ?? null;
    if (logId !== null) this.ctx.store.updateTask(task.id, { routeLogId: logId });
    const target: TargetRef | null = a.verdict.ok ? { harness: a.verdict.harness, model: a.verdict.model } : null;
    if (failure) this.ctx.emit(task.id, "redispatch", { kind: "router", source: a.source, verdict: a.verdict, decision, routerError: null });
    else this.ctx.emit(task.id, "step", { n, action: "dispatch", purpose: decision.purpose, target, source: a.source, reason: decision.reason, model: (st.planner ?? this.d.engine.router).name, routerMs: r.routerMs });
    const failureNote = failure && target ? this.d.threads.recordHandoff(current, failure.failed, failure.reason, target, decision.handoff_note) : decision.handoff_note;
    // Loop and planner models read executor replies (page content): their grant is at most a subset of the pin.
    const narrowed = narrowTransfer(st.transfer, decision.transfer);
    if (narrowed.note) this.ctx.emit(task.id, "transfer_grant", { status: "dropped", stage: "step", n, reason: narrowed.note });
    return { ...st, current, verdict: a.verdict, stepTransfer: narrowed.grant, handoff: [stepsNote(st.steps), failureNote].filter(Boolean).join("\n\n") || null };
  }

  /** A missing next action cannot establish completion or authorize replay of a previous operation. */
  private planningFailure(task: Task, st: State, result: NextResult, stage: "initial_plan" | "next_action", model: string): null {
    const kind = result.failure?.kind ?? "service_error";
    const diagnostic = LOOP_FAILURE_MESSAGE[kind];
    this.ctx.emit(task.id, "step", {
      n: stage === "initial_plan" ? 0 : st.steps.length + 1, action: "plan", source: "error", stage, model,
      routerError: diagnostic, routerMs: result.routerMs, tries: result.failure?.tries ?? 0, failureKind: kind,
      ...(result.failure ? { timeoutMs: result.failure.timeoutMs } : {}), dispatches: st.dispatches,
    });
    const progress = st.dispatches === 0 ? "本次任务尚未派发执行，未执行新的业务操作。"
      : `已保存此前 ${st.dispatches} 次派发的进展；已停止，未自动重放业务步骤。`;
    this.incomplete(task, st, `${stage === "initial_plan" ? "首次规划" : "后续规划"}失败：${diagnostic}。${progress}`, undefined, undefined,
      kind === "timeout" ? "planner_timeout" : "planner_error");
    return null;
  }

  private async askForMore(task: Task, question: string, st: State): Promise<boolean> {
    const evidence = evidenceExcerpt(stepLines(st.steps.slice(-BUDGET_STEPS_SHOWN)).join("\n"), BUDGET_EVIDENCE_CHARS);
    return (await this.d.desk.request(task.id, question, evidence, { humanOnly: true })) === "allow";
  }

  private record(task: Task, verdict: OkVerdict, purpose: Purpose, outcome: Exclude<DispatchOutcome, { kind: "cancelled" | "protected" | "blocked" }>): StepRecord {
    let outFiles: string[] = [];
    try { outFiles = listTree(join(task.cwd, OUT_DIR)).map((f) => f.path); } catch { outFiles = []; }
    const effects = outcome.kind === "succeeded" ? outcome.outcome.sideEffects ?? NO_SIDE_EFFECTS : outcome.attempt.sideEffects;
    return {
      kind: "dispatch", purpose, harness: verdict.harness, model: verdict.model, brief: task.brief ?? task.task, ok: outcome.kind === "succeeded",
      failureKind: outcome.kind === "failed" ? outcome.attempt.kind : null, reply: outcome.kind === "succeeded" ? evidenceExcerpt(outcome.outcome.lastText ?? "") : outcome.result,
      sideEffectsKnown: outcome.kind === "succeeded" ? outcome.outcome.sideEffectsKnown ?? outcome.outcome.sideEffects !== undefined : outcome.attempt.sideEffectsKnown ?? false,
      sideEffects: `files changed ${effects.filesChanged}, commands ${effects.commandsRun}, approvals ${effects.approvalsGranted}`, outFiles, diff: gitDiffSummary(task.cwd),
    };
  }

  private async dispatch(task: Task, verdict: OkVerdict, signal: AbortSignal, handoff: string | null, purpose: Purpose, st: State): Promise<DispatchOutcome> {
    const executor: Executor | undefined = this.d.engine.executors.find((e) => e.harness === verdict.harness);
    const target: TargetRef = { harness: verdict.harness, model: verdict.model };
    if (!executor) return this.failedAttempt(task, { ...target, kind: "transport", excerpt: `no executor for harness ${verdict.harness}`, sideEffects: NO_SIDE_EFFECTS });
    let release: Release;
    try { release = await this.d.scheduler.acquireHarness(task, verdict.harness, signal); } catch { return { kind: "cancelled" }; }
    if (!this.active(task.id, signal)) { release(); return { kind: "cancelled" }; }
    this.ctx.store.updateTask(task.id, { status: "running", harness: verdict.harness, model: verdict.model, effort: verdict.effort });
    this.ctx.emit(task.id, "dispatched", { harness: verdict.harness, model: verdict.model, effort: verdict.effort, chosen: verdict.chosen, brief: task.brief, purpose });
    const browser = task.needsBrowser || (task.decision?.needs_browser ?? false);
    // gate-next-v0 §5.2: offered only with the browser; the executor reports whether the browser gate really got it.
    const transfer = st.stepTransfer;
    if (transfer) this.ctx.emit(task.id, "transfer_grant", { status: "offered", ...transfer, harness: verdict.harness, model: verdict.model, attached: browser });
    const prot = this.d.engine.protected ?? NO_PROTECTED;
    const snapshot = snapshotProtected(task.cwd, prot);
    const { threadHome, resume } = this.d.threads.continuation(task, verdict.harness);
    // One attempt = one abort scope: the supervisor's watchdog can end this attempt without cancelling the task.
    const attemptCtl = new AbortController();
    const onTaskAbort = () => attemptCtl.abort(signal.reason);
    signal.addEventListener("abort", onTaskAbort, { once: true });
    const dog = watchdog(this.ctx, this.d.engine.supervisor, this.d.desk, task, attemptCtl);
    let blockedQuestion: string | null = null;
    let observedTools = 0, observedApprovals = 0;
    let observedText = "";
    let checkpointPayload: Record<string, unknown> | null = null;
    let execution: Promise<ExecutionOutcome> | null = null;
    let executionSettled = false;
    const observedEffects = (): SideEffects => ({ filesChanged: 0, commandsRun: observedTools, approvalsGranted: observedApprovals });
    const checkpoint = (ok: boolean, result: string, sideEffects: SideEffects, sideEffectsKnown: boolean) => {
      if (checkpointPayload) return;
      checkpointPayload = { purpose, ok, result: evidenceExcerpt(result), sideEffects, sideEffectsKnown, harness: verdict.harness, model: verdict.model, brief: evidenceExcerpt(brief, CHECKPOINT_BRIEF_CHARS) };
    };
    const readOnly = purpose !== "do";
    const brief = readOnly ? `${READ_ONLY_BRIEF[purpose]}\n\n${this.d.composer.brief(task)}` : this.d.composer.brief(task);
    // A kept browser session (threads-v0 §4b): the thread's slot, else one that has been on a site the task names.
    const lease = browser ? this.d.engine.browserSlots?.acquire({ threadId: task.threadId, hosts: namedHosts(`${task.task}\n${brief}`) }) ?? null : null;
    if (browser && this.d.engine.browserSlots) this.ctx.emit(task.id, "browser_session", lease ? { slot: lease.id, reused: lease.reused, reason: lease.reason } : { slot: null, reason: "all_busy" });
    const priorCheckpoints = this.d.composer.checkpointContext(task);
    const handoffNote = priorCheckpoints && !handoff?.includes(priorCheckpoints) ? [priorCheckpoints, handoff].filter(Boolean).join("\n\n") : handoff;
    const material = { userMessage: this.d.composer.task(task), context: this.d.composer.context()?.text ?? "", steps: stepLines(st.steps), knownTokens: new Set(this.d.composer.tokens(task)) };
    let onAttemptAbort!: () => void;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAttemptAbort = () => reject(attemptCtl.signal.reason instanceof Error ? attemptCtl.signal.reason : new Error("execution interrupted"));
        attemptCtl.signal.addEventListener("abort", onAttemptAbort, { once: true });
      });
      attemptCtl.signal.throwIfAborted();
      execution = executor.run({
        taskId: task.id, task: task.task, brief, cwd: task.cwd, model: verdict.model, effort: verdict.effort, attachments: task.attachments,
        handoffNote, context: material.context || null, platformMemory: this.d.composer.platformExperience(task), feedback: this.d.composer.feedbackContext(task), knownTokens: material.knownTokens, threadHome, resume,
        browser, ...(lease ? { browserProfile: lease.dir } : {}), ...(browser && transfer ? { transfer } : {}), signal: attemptCtl.signal,
        emit: (type, payload) => {
          if (attemptCtl.signal.aborted || !this.active(task.id, signal)) return;
          if (type === "tool_call" && !payload.denied) observedTools += typeof payload.count === "number" && Number.isFinite(payload.count) ? Math.max(1, payload.count) : 1;
          if (type === "text" && typeof payload.text === "string") observedText = evidenceExcerpt([observedText, payload.text].filter(Boolean).join("\n"));
          this.ctx.emit(task.id, type, payload); dog.touch();
        },
        approve: async (action, evidence, requestSignal) => {
          if (attemptCtl.signal.aborted || !this.active(task.id, signal)) return "deny";
          if (readOnly) {
            // A command that only reads, inside the task's folder, is what a look needs (readOnly.ts); the rest is refused.
            const command = shellCommandOf(action);
            if (command !== null && isReadOnlyCommand(command, task.cwd, this.d.engine.protected ?? NO_PROTECTED)) {
              this.ctx.emit(task.id, "supervisor", { kind: "approval", decision: "allow", reason: "a command that only reads, in a read-only step", source: "floor", action });
              return "allow";
            }
            this.ctx.emit(task.id, "supervisor", { kind: "approval", decision: "deny", reason: `${purpose} step is read-only`, source: "floor", action });
            return "deny";
          }
          // Skip-permissions mode (docs/control-v0.md §1): allowed at once, nobody asked. The protected folders were
          // refused by the executor before this point; questions still go through `ask`.
          if (this.d.policyFor(task).mode === "skip") {
            this.ctx.emit(task.id, "supervisor", { kind: "approval", decision: "allow", reason: "skip-permissions mode", source: "policy", action });
            observedApprovals++;
            return "allow";
          }
          dog.pause();
          try {
            const decision = await this.d.desk.request(task.id, action, evidence, requestSignal ? { signal: requestSignal } : {});
            if (attemptCtl.signal.aborted || !this.active(task.id, signal)) return "deny";
            if (decision === "allow") observedApprovals++;
            return decision;
          } finally { dog.touch(); }
        },
        ask: async (questions) => {
          if (attemptCtl.signal.aborted || !this.active(task.id, signal)) return null;
          dog.pause();
          try {
            const answers = await answerQuestions(this.ctx, this.d.engine.supervisor, this.d.desk, task, this.d.policyFor(task), questions, {
              ...material, feedback: this.d.composer.feedbackContext(task) ?? "",
              observations: [...recentEventLines(this.ctx, task.id, OBSERVED_EVENTS), ...(observedText ? [evidenceExcerpt(observedText, OBSERVED_TEXT_CHARS)] : [])],
            }, attemptCtl.signal, this.d.engine.targets.router.timeout_ms);
            if (signal.aborted || attemptCtl.signal.aborted || !this.active(task.id, signal)) return null;
            if (answers === null && !signal.aborted && !attemptCtl.signal.aborted) {
              blockedQuestion = `等待你的答复：${questions.map((q) => q.text).join("；")}`;
              attemptCtl.abort(new Error(blockedQuestion));
              this.incomplete(task, st, blockedQuestion, "blocked", undefined, "question");
            }
            // A user can supply a newly sealed credential while an executor is waiting. Its
            // existing input set must then recognize that token for the remaining tool calls.
            for (const token of tokensIn(...Object.values(answers ?? {}).flat())) material.knownTokens.add(token);
            return answers;
          } finally { dog.touch(); }
        },
      });
      void execution.then(() => { executionSettled = true; }, () => { executionSettled = true; });
      const outcome = await Promise.race([execution, interrupted]);
      dog.stop();
      const reported = outcome.sideEffects ?? NO_SIDE_EFFECTS;
      // Emitted observations are a lower bound; a zero reported afterward cannot erase them.
      const sideEffects: SideEffects = {
        filesChanged: reported.filesChanged,
        commandsRun: Math.max(reported.commandsRun, observedTools - reported.filesChanged),
        approvalsGranted: Math.max(reported.approvalsGranted, observedApprovals),
      };
      const contradictsObservations = reported.commandsRun + reported.filesChanged < observedTools || reported.approvalsGranted < observedApprovals;
      const sideEffectsKnown = (outcome.sideEffectsKnown ?? outcome.sideEffects !== undefined) && !contradictsObservations;
      const result = outcome.lastText || outcome.stderr || "";
      const touched = restoreProtected(task.cwd, prot, snapshot);
      if (touched.length) {
        checkpoint(false, `${result}\n受保护文件被修改并已恢复：${touched.join(", ")}`, sideEffects, sideEffectsKnown);
        this.ctx.emit(task.id, "attempt_failed", { ...target, kind: "protected", excerpt: touched.join(", "), sideEffects, sideEffectsKnown, hadSideEffects: true, security: true });
        return { kind: "protected", paths: touched };
      }
      if (task.threadId && outcome.refusal?.source === "provider") this.d.threads.dropSession(task.threadId, verdict.harness, task.id);
      else if (outcome.sessionId && task.threadId) this.ctx.store.appendThreadEvent(task.threadId, "session", { harness: verdict.harness, sessionId: outcome.sessionId, taskId: task.id });
      if (signal.aborted) { checkpoint(false, `${result}\n执行已取消；继续前需核对现场`, sideEffects, false); return { kind: "cancelled" }; }
      if (blockedQuestion) { checkpoint(false, `${result}\n${blockedQuestion}`, sideEffects, false); return { kind: "blocked", reason: blockedQuestion }; }
      const kind = classifyFailure(outcome);
      checkpoint(!kind && dog.cancelledWith === null, result, sideEffects, sideEffectsKnown);
      if (kind === "refusal" || kind === "gate_denied") {
        const refusal = kind === "refusal" ? detectRefusal(outcome) : null;
        return this.failedAttempt(task, { ...target, kind, excerpt: excerpt(outcome), sideEffects, sideEffectsKnown, ...(refusal ? { refusal } : {}) }, result);
      }
      if (dog.cancelledWith !== null) return this.failedAttempt(task, { ...target, kind: "rejected", excerpt: `supervisor cancelled a silent run: ${dog.cancelledWith}`.slice(0, ATTEMPT_EXCERPT_CHARS), sideEffects, sideEffectsKnown: false }, result);
      if (kind) return this.failedAttempt(task, { ...target, kind, excerpt: excerpt(outcome), sideEffects, sideEffectsKnown }, result);
      return { kind: "succeeded", outcome: { ...outcome, sideEffects, sideEffectsKnown } };
    } catch (err) {
      dog.stop();
      const sideEffects = observedEffects();
      const message = blockedQuestion ?? (err instanceof Error ? err.message : "executor failed");
      restoreProtected(task.cwd, prot, snapshot);
      const observations = observedText ? `Observed executor messages (unverified):\n${observedText}\n\nExecution interrupted:\n${message}` : message;
      checkpoint(false, observations, sideEffects, false);
      if (signal.aborted) return { kind: "cancelled" };
      if (blockedQuestion) return { kind: "blocked", reason: blockedQuestion };
      if (dog.cancelledWith !== null) return this.failedAttempt(task, { ...target, kind: "rejected", excerpt: `supervisor cancelled a silent run: ${dog.cancelledWith}`.slice(0, ATTEMPT_EXCERPT_CHARS), sideEffects, sideEffectsKnown: false }, observations);
      return this.failedAttempt(task, { ...target, kind: "transport", excerpt: evidenceExcerpt(message, ATTEMPT_EVIDENCE_CHARS), sideEffects, sideEffectsKnown: false }, observations);
    } finally {
      if (onAttemptAbort) attemptCtl.signal.removeEventListener("abort", onAttemptAbort);
      signal.removeEventListener("abort", onTaskAbort);
      try {
        if (attemptCtl.signal.aborted && execution && !executionSettled) {
          let timer: NodeJS.Timeout | undefined;
          try { await Promise.race([execution.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, EXIT_GRACE_MS); })]); }
          finally { if (timer) clearTimeout(timer); }
          if (!executionSettled) {
            this.d.scheduler.quarantineExecution(task, execution);
            const payload = (checkpointPayload ?? { purpose, result: "", sideEffects: observedEffects(), harness: verdict.harness, model: verdict.model, brief: evidenceExcerpt(brief, CHECKPOINT_BRIEF_CHARS) }) as Record<string, unknown>;
            checkpointPayload = { ...payload, ok: false, sideEffectsKnown: false, result: evidenceExcerpt(`${payload.result}\n执行器未在退场时限内结束；续跑前必须核对现场。`) };
          }
        }
        // Keep locks until the adapter has had a bounded chance to reap its child processes.
        restoreProtected(task.cwd, prot, snapshot);
        if (checkpointPayload) this.ctx.emit(task.id, "checkpoint", checkpointPayload);
      } finally {
        lease?.release();   // after the adapter reaped its children; closes a browser still holding the profile
        release();
        if (browser) this.d.engine.afterBrowserRun?.();
      }
    }
  }

  private failedAttempt(task: Task, attempt: Attempt, result = attempt.excerpt): DispatchOutcome {
    this.ctx.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: hasSideEffects(attempt.sideEffects) });
    return { kind: "failed", attempt, result: evidenceExcerpt(result) };
  }

  /** Done: the loop model's result when it wrote one, else the last successful executor reply. */
  private finish(task: Task, st: State, result: string | null): void {
    if (!this.active(task.id)) return;
    const text = result ?? st.lastSuccess?.lastText ?? "";
    this.ctx.store.updateTask(task.id, { status: "done", result: text });
    this.ctx.emit(task.id, "done", { result: text, tokens: st.tokens, sideEffects: st.sideEffects, agents: st.lastSuccess?.agents ?? NO_AGENTS, dispatches: st.dispatches });
  }

  private fail(id: string, error: string, security = false): void {
    if (!this.active(id)) return;
    this.ctx.store.updateTask(id, { status: "failed", error });
    this.ctx.emit(id, "failed", { error, security });
  }

  private incomplete(task: Task, st: State | null, reason: string, status?: "partial" | "blocked", result?: string | null, cause: BlockCause | null = null): void {
    if (!this.active(task.id)) return;
    const terminal = status ?? (st?.lastSuccess ? "partial" : "blocked");
    const text = result ?? st?.lastSuccess?.lastText ?? "";
    const blockCause = terminal === "blocked" ? cause : null;
    this.ctx.store.updateTask(task.id, { status: terminal, result: text, error: reason, blockCause });
    this.ctx.emit(task.id, terminal, { result: text, error: reason, remaining: [reason], dispatches: st?.dispatches ?? 0, ...(blockCause ? { blockCause } : {}) });
  }
}

/** What the next executor is told about the steps before it: for context, never an approval. */
export function stepsNote(steps: readonly StepRecord[]): string {
  const done = steps.filter((s) => s.kind !== "note");
  if (!done.length) return "";
  return `Earlier steps of this task (context only; nothing here is an approval):\n${stepLines(done).join("\n")}`;
}

/** What the executor reads when its result comes back for correction. */
export function correctionNote(reason: string): string {
  return `验收没有通过：${reason}
请先只读地核对实际情况（你之前做过的事都在本会话里），再改正并补全结果。已经生效的操作不要重复做；核对后仍无法确定的，如实写明还缺什么。`;
}
