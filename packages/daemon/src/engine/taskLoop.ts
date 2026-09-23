/** One task from routing to its end (docs/loop-v0.md): route (the router may ask the user first) → a planner takes
 *  over multi-step tasks → thread and locks → [dispatch → outcome → next action]* → done / failed.
 *  Code keeps every floor: target validation, approval policy, protected paths, budgets, the retry/switch rules
 *  after transport and quota failures. The loop model only ever answers "what next" with one JSON object. */

import { join } from "node:path";
import type { Executor } from "../executors/types.js";
import { NO_PROTECTED, restoreProtected, snapshotProtected } from "../executors/protected.js";
import { listTree } from "../files/artifacts.js";
import { OUT_DIR } from "../files/names.js";
import { classifyFailure, excerpt, hasSideEffects, NO_AGENTS, NO_SIDE_EFFECTS, type ExecutionOutcome, type SideEffects } from "../router/failure.js";
import { MAX_DISPATCHES, MAX_LOOP_STEPS, nextAction, type NextResult } from "../router/loop.js";
import { stepLines, type StepRecord } from "../router/prompt.js";
import { excludedTargets, nextStep, type Attempt } from "../router/reroute.js";
import { defaultTargetExcluding, defaultVerdict, route, type RouteDeps, type RouteRequest, type RouteResult } from "../router/route.js";
import type { Router } from "../router/routers/types.js";
import { categoryOf, type TargetRef } from "../router/targets.js";
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
import { CLARIFY_ID, clarifyQuestion } from "./questions.js";
import type { Scheduler } from "./scheduler.js";
import { acceptance, answerQuestions, watchdog } from "./supervise.js";
import type { ThreadBook } from "./threadBook.js";
import type { Task } from "./types.js";

export const MAX_CLARIFICATIONS = 2;

/** Prefixed to the brief of a read-only step; its approval requests are refused outright (loop-v0 §6). */
export const READ_ONLY_BRIEF: Record<"research" | "verify", string> = {
  research: "This is a read-only research step: look and report; change nothing, create nothing, submit no form, send nothing. Any action that needs approval will be refused.",
  verify: "This is a read-only verification step: check the earlier work and report; change nothing, submit nothing. Any action that needs approval will be refused.",
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
  | { readonly kind: "failed"; readonly attempt: Attempt }
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
};

type FailureContext = { readonly failed: Attempt; readonly reason: HandoffReason; readonly exclude: readonly TargetRef[] };

const addEffects = (a: SideEffects, b: SideEffects): SideEffects => ({ filesChanged: a.filesChanged + b.filesChanged, commandsRun: a.commandsRun + b.commandsRun, approvalsGranted: a.approvalsGranted + b.approvalsGranted });

export class TaskLoop {
  constructor(private readonly d: LoopDeps) {}

  private get ctx(): EngineContext { return this.d.ctx; }

  async run(initial: Task, signal: AbortSignal, held: Release[]): Promise<void> {
    this.ctx.store.updateTask(initial.id, { status: "routing" });
    const first = await this.routeWithQuestions(initial, this.d.composer.task(initial), signal);
    if (!first) return;
    const { routed, composed } = first;
    const routeLogId = this.d.engine.routingLog?.record(initial.task, initial.cwd, routed) ?? null;
    if (routeLogId !== null) this.ctx.store.updateTask(initial.id, { routeLogId });
    this.ctx.emit(initial.id, "routed", { source: routed.source, verdict: routed.verdict, decision: routed.decision, routerMs: routed.routerMs, routerError: routed.routerError });
    if (!routed.verdict.ok) return this.fail(initial.id, `no target: ${routed.verdict.notes.join("; ")}`);
    const task = await this.d.threads.assign(initial, routed.decision, (q, e) => this.d.desk.request(initial.id, q, e, { humanOnly: true }));
    if (signal.aborted) return;
    // Locks in a fixed order (background-v0 §1): thread, then cwd; the harness slot is taken per dispatch.
    held.push(await this.d.scheduler.acquireThread(task, signal));
    held.push(await this.d.scheduler.acquireCwd(task, signal));
    if (signal.aborted) return;
    const current = this.ctx.store.updateTask(task.id, { decision: routed.decision, brief: this.d.composer.repairBrief(task, routed.decision?.brief ?? composed) });
    let st: State | null = {
      current, verdict: routed.verdict, steps: [], attempts: [], dispatches: 0, budget: MAX_DISPATCHES, loopCalls: 0, loopBudget: MAX_LOOP_STEPS, rejections: 0, planner: null, lastSuccess: null, tokens: 0, sideEffects: NO_SIDE_EFFECTS,
      looping: current.decision?.plan === "multi" && !task.pin,
      handoff: task.handoffFrom ? this.d.threads.handoffText(task, task.handoffFrom, task.decision?.handoff_note ?? null) : null,
    };
    if (current.decision?.plan === "multi" && !task.pin) st = await this.escalate(task, composed, st, signal);
    while (st) st = await this.step(task, composed, st, signal);
  }

  /** Route, letting the router ask the user first (at most MAX_CLARIFICATIONS rounds). Null when the task failed. */
  private async routeWithQuestions(task: Task, composed: string, signal: AbortSignal): Promise<{ routed: RouteResult; composed: string } | null> {
    let text = composed;
    let routed = await route(this.request(task, text), this.d.routeDeps());
    for (let round = 0; routed.clarify && round < MAX_CLARIFICATIONS; round++) {
      this.ctx.emit(task.id, "routed", { source: routed.source, verdict: routed.verdict, decision: routed.decision, routerMs: routed.routerMs, routerError: routed.routerError, clarify: routed.clarify });
      const answer = await this.askUser(task, routed.clarify);
      if (signal.aborted) return null;
      if (answer === null) { this.fail(task.id, `waiting for your answer: ${routed.clarify}`); return null; }
      text = `${text}\n\nUser clarification (in reply to "${routed.clarify}"):\n${answer}`;
      this.ctx.store.updateTask(task.id, { status: "routing" });
      routed = await route(this.request(task, text), this.d.routeDeps());
    }
    if (routed.clarify) { this.fail(task.id, `the router kept asking questions: ${routed.clarify}`); return null; }
    return { routed, composed: text };
  }

  private request(task: Task, text: string): RouteRequest {
    return { task: text, cwd: task.cwd, ...(task.pin ? { pin: task.pin } : {}), needsBrowser: task.needsBrowser, exclude: task.exclude };
  }

  private async askUser(task: Task, question: string): Promise<string | null> {
    const answers = await this.d.desk.ask(task.id, [clarifyQuestion(question)], "router");
    return answers?.[CLARIFY_ID]?.[0] ?? null;
  }

  /** The router said "multi": the planner takes over from the first step; if it is unusable, the router's decision stands. */
  private async escalate(task: Task, composed: string, st: State, signal: AbortSignal): Promise<State | null> {
    const pick = st.current.decision?.planner ?? null;
    const chosen = this.d.engine.planner?.(pick) ?? null;
    if (!chosen) { this.ctx.emit(task.id, "step", { n: 0, action: "plan", source: "none", pick, note: "no usable planner; the router runs the loop" }); return st; }
    const planner = chosen.router;
    this.ctx.emit(task.id, "step", { n: 0, action: "plan", model: `${chosen.target.harness}/${chosen.target.model}`, pick, reason: st.current.decision?.reason ?? "" });
    const note: StepRecord = { kind: "note", text: `The dispatcher triaged this as a multi-step task: ${st.current.decision?.reason || "(no reason given)"}. Plan it from the start.` };
    const r = await nextAction(planner, this.d.routeDeps(), { req: this.request(task, composed), steps: [note], used: 0, budget: st.budget, exclude: [] }, signal);
    if (!r.action) { this.ctx.emit(task.id, "step", { n: 0, action: "plan", source: "error", routerError: r.routerError, note: "the planner was unusable; the router's decision stands" }); return st; }
    return this.applyAction(task, composed, { ...st, planner, loopCalls: 1 }, r, null, signal);
  }

  /** One dispatch and whatever follows it. Null ends the loop (the task is done, failed or cancelled). */
  private async step(task: Task, composed: string, st: State, signal: AbortSignal): Promise<State | null> {
    if (signal.aborted) return null;
    if (!st.verdict.ok) { this.fail(task.id, `no target: ${st.verdict.notes.join("; ")}`); return null; }
    if (st.dispatches >= st.budget) {
      const more = await this.askForMore(task, `已派发 ${st.dispatches} 次还没完成，还要继续吗？允许 = 再给 ${MAX_DISPATCHES} 次，拒绝 = 停止`, st);
      if (!more) { this.fail(task.id, `stopped after ${st.dispatches} dispatches`); return null; }
      return { ...st, budget: st.budget + MAX_DISPATCHES };
    }
    const purpose: Purpose = st.current.decision?.purpose ?? "do";
    const outcome = await this.dispatch(st.current, st.verdict, signal, st.handoff, purpose, st);
    if (outcome.kind === "cancelled") return null;
    if (outcome.kind === "protected") { this.fail(task.id, `executor changed protected files (restored): ${outcome.paths.join(", ")}`, true); return null; }
    const after: State = { ...st, dispatches: st.dispatches + 1, steps: [...st.steps, this.record(st.current, st.verdict, purpose, outcome)], looping: st.looping || purpose !== "do" };
    if (outcome.kind === "failed") return this.afterFailure(task, composed, after, outcome.attempt, signal);
    const done: State = { ...after, lastSuccess: outcome.outcome, tokens: after.tokens + (outcome.outcome.tokens ?? 0), sideEffects: addEffects(after.sideEffects, outcome.outcome.sideEffects ?? NO_SIDE_EFFECTS) };
    if (done.planner !== null || done.looping) return this.decideNext(task, composed, done, signal);
    // A single-step task: the supervisor's acceptance (when configured) is the only check before done.
    const check = await acceptance(this.ctx, this.d.engine.supervisor, done.current, outcome.outcome.lastText ?? "", done.rejections, signal);
    if (!check.rejected) { this.finish(task, done, null); return null; }
    const attempt: Attempt = { harness: st.verdict.harness, model: st.verdict.model, kind: "rejected", excerpt: check.rejected.slice(0, 240), sideEffects: outcome.outcome.sideEffects ?? NO_SIDE_EFFECTS };
    this.ctx.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: hasSideEffects(attempt.sideEffects) });
    return this.afterFailure(task, composed, { ...done, rejections: check.rejections }, attempt, signal);
  }

  /** Code rules first (retry / switch / stop); everything else is the loop model's call, the failed target excluded. */
  private async afterFailure(task: Task, composed: string, st: State, attempt: Attempt, signal: AbortSignal): Promise<State | null> {
    const attempts = [...st.attempts, attempt];
    const current = this.ctx.store.updateTask(task.id, { attempts, status: "routing" });
    const deps = this.d.routeDeps();
    const req = this.request(task, composed);
    const tried = attempts.map((a) => ({ harness: a.harness, model: a.model }));
    const step = nextStep({ decision: current.decision, attempts, routerAsks: current.routerAsks, targets: deps.targets, quota: deps.quota, running: deps.running,
      lowConfidenceTarget: defaultTargetExcluding(req, deps, tried), category: categoryOf(composed, deps.targets) });
    const reason: HandoffReason = attempt.kind === "quota" ? "quota" : `failure:${attempt.kind}`;
    const base: State = { ...st, current, attempts };
    if (step.kind === "stop") { this.fail(task.id, step.reason, step.security); return null; }
    if (step.kind === "retry") {
      this.ctx.emit(task.id, "redispatch", { kind: "retry", target: step.target, backoffMs: step.backoffMs });
      try { await sleep(this.d.engine.retryBackoffMs ?? step.backoffMs, signal); } catch { return null; }
      return { ...base, verdict: { ok: true, harness: step.target.harness, model: step.target.model, effort: null, chosen: "router", queue: false, notes: [] } };
    }
    if (step.kind === "switch") {
      this.ctx.emit(task.id, "redispatch", { kind: "switch", target: step.target, notes: step.notes });
      const verdict: Verdict = { ok: true, harness: step.target.harness, model: step.target.model, effort: null, chosen: "fallback", queue: false, notes: step.notes };
      return { ...base, verdict, handoff: this.d.threads.recordHandoff(current, attempt, reason, step.target, null) };
    }
    const r = await nextAction(st.planner ?? deps.router, deps, { req, steps: st.steps, used: st.dispatches, budget: st.budget, exclude: step.exclude }, signal);
    const asked = this.ctx.store.updateTask(task.id, { routerAsks: current.routerAsks + 1 });
    return this.applyAction(task, composed, { ...base, current: asked, loopCalls: st.loopCalls + 1 }, r, { failed: attempt, reason, exclude: step.exclude }, signal);
  }

  /** After a successful research/verify/multi-step dispatch: the loop model says what comes next. */
  private async decideNext(task: Task, composed: string, st: State, signal: AbortSignal): Promise<State | null> {
    if (st.loopCalls >= st.loopBudget) {
      const more = await this.askForMore(task, `调度已走了 ${st.loopCalls} 步还没结束，还要继续吗？允许 = 再给 ${MAX_LOOP_STEPS} 步，拒绝 = 以目前的结果完成`, st);
      if (!more) { this.finish(task, st, null); return null; }
      return { ...st, loopBudget: st.loopBudget + MAX_LOOP_STEPS };
    }
    this.ctx.store.updateTask(task.id, { status: "routing" });
    const deps = this.d.routeDeps();
    const r = await nextAction(st.planner ?? deps.router, deps, { req: this.request(task, composed), steps: st.steps, used: st.dispatches, budget: st.budget, exclude: excludedTargets(st.attempts) }, signal);
    return this.applyAction(task, composed, { ...st, loopCalls: st.loopCalls + 1 }, r, null, signal);
  }

  /** Turn the loop model's reply into the next state: a validated dispatch, a question card, or the end. */
  private async applyAction(task: Task, composed: string, st: State, r: NextResult, failure: FailureContext | null, signal: AbortSignal): Promise<State | null> {
    const n = st.steps.length + 1;
    const a = r.action;
    if (!a) return this.withoutRouter(task, composed, st, r, failure);
    if (a.kind === "give_up") { this.fail(task.id, `router gave up: ${a.reason}`); return null; }
    if (a.kind === "repair") { this.fail(task.id, `router requested repair tool ${a.tool}; repair tools are not wired yet`); return null; }
    if (a.kind === "finish") { this.ctx.emit(task.id, "step", { n, action: "finish", reason: a.reason, model: (st.planner ?? this.d.engine.router).name, routerMs: r.routerMs }); this.finish(task, st, a.result); return null; }
    if (a.kind === "ask_user") {
      this.ctx.emit(task.id, "step", { n, action: "ask_user", question: a.question, model: (st.planner ?? this.d.engine.router).name, routerMs: r.routerMs });
      const answer = await this.askUser(task, a.question);
      if (signal.aborted) return null;
      return this.decideNext(task, composed, { ...st, steps: [...st.steps, { kind: "ask_user", question: a.question, answer }] }, signal);
    }
    const decision = a.decision;
    const current = this.ctx.store.updateTask(task.id, { decision, brief: this.d.composer.repairBrief(task, decision.brief), status: "routing" });
    const logId = this.d.engine.routingLog?.record(task.task, task.cwd, { verdict: a.verdict, decision, source: a.source, routerError: null, routerMs: r.routerMs, attempts: st.attempts.length }) ?? null;
    if (logId !== null) this.ctx.store.updateTask(task.id, { routeLogId: logId });
    const target: TargetRef | null = a.verdict.ok ? { harness: a.verdict.harness, model: a.verdict.model } : null;
    if (failure) this.ctx.emit(task.id, "redispatch", { kind: "router", source: a.source, verdict: a.verdict, decision, routerError: null });
    else this.ctx.emit(task.id, "step", { n, action: "dispatch", purpose: decision.purpose, target, source: a.source, reason: decision.reason, model: (st.planner ?? this.d.engine.router).name, routerMs: r.routerMs });
    const failureNote = failure && target ? this.d.threads.recordHandoff(current, failure.failed, failure.reason, target, decision.handoff_note) : decision.handoff_note;
    return { ...st, current, verdict: a.verdict, handoff: [stepsNote(st.steps), failureNote].filter(Boolean).join("\n\n") || null };
  }

  /** The loop model was unusable: after a failure the default policy picks a target; after success the task ends with what it has. */
  private withoutRouter(task: Task, composed: string, st: State, r: NextResult, failure: FailureContext | null): State | null {
    if (!failure) {
      this.ctx.emit(task.id, "step", { n: st.steps.length + 1, action: "finish", source: "error", routerError: r.routerError, note: "the loop model was unusable; finishing with the last result" });
      this.finish(task, st, null);
      return null;
    }
    const deps = this.d.routeDeps();
    const verdict = defaultVerdict(this.request(task, composed), deps, failure.exclude, st.current.needsBrowser || (st.current.decision?.needs_browser ?? false));
    this.ctx.emit(task.id, "redispatch", { kind: "router", source: "default", verdict, decision: null, routerError: r.routerError });
    const handoff = verdict.ok ? this.d.threads.recordHandoff(st.current, failure.failed, failure.reason, { harness: verdict.harness, model: verdict.model }, null) : null;
    return { ...st, verdict, handoff: [stepsNote(st.steps), handoff].filter(Boolean).join("\n\n") || null };
  }

  private async askForMore(task: Task, question: string, st: State): Promise<boolean> {
    const evidence = stepLines(st.steps.slice(-3)).join("\n").slice(0, 2000);
    return (await this.d.desk.request(task.id, question, evidence, { humanOnly: true })) === "allow";
  }

  private record(task: Task, verdict: OkVerdict, purpose: Purpose, outcome: Exclude<DispatchOutcome, { kind: "cancelled" | "protected" }>): StepRecord {
    let outFiles: string[] = [];
    try { outFiles = listTree(join(task.cwd, OUT_DIR)).map((f) => f.path); } catch { outFiles = []; }
    const effects = outcome.kind === "succeeded" ? outcome.outcome.sideEffects ?? NO_SIDE_EFFECTS : outcome.attempt.sideEffects;
    return {
      kind: "dispatch", purpose, harness: verdict.harness, model: verdict.model, brief: task.brief ?? task.task, ok: outcome.kind === "succeeded",
      failureKind: outcome.kind === "failed" ? outcome.attempt.kind : null, reply: outcome.kind === "succeeded" ? outcome.outcome.lastText ?? "" : outcome.attempt.excerpt,
      sideEffects: `files changed ${effects.filesChanged}, commands ${effects.commandsRun}, approvals ${effects.approvalsGranted}`, outFiles, diff: gitDiffSummary(task.cwd),
    };
  }

  private async dispatch(task: Task, verdict: OkVerdict, signal: AbortSignal, handoff: string | null, purpose: Purpose, st: State): Promise<DispatchOutcome> {
    const executor: Executor | undefined = this.d.engine.executors.find((e) => e.harness === verdict.harness);
    const target: TargetRef = { harness: verdict.harness, model: verdict.model };
    if (!executor) return this.failedAttempt(task, { ...target, kind: "transport", excerpt: `no executor for harness ${verdict.harness}`, sideEffects: NO_SIDE_EFFECTS });
    let release: Release;
    try { release = await this.d.scheduler.acquireHarness(task, verdict.harness, signal); } catch { return { kind: "cancelled" }; }
    this.ctx.store.updateTask(task.id, { status: "running", harness: verdict.harness, model: verdict.model, effort: verdict.effort });
    this.ctx.emit(task.id, "dispatched", { harness: verdict.harness, model: verdict.model, effort: verdict.effort, chosen: verdict.chosen, brief: task.brief, purpose });
    const prot = this.d.engine.protected ?? NO_PROTECTED;
    const snapshot = snapshotProtected(task.cwd, prot);
    const { threadHome, resume } = this.d.threads.continuation(task, verdict.harness);
    // One attempt = one abort scope: the supervisor's watchdog can end this attempt without cancelling the task.
    const attemptCtl = new AbortController();
    const onTaskAbort = () => attemptCtl.abort(signal.reason);
    signal.addEventListener("abort", onTaskAbort, { once: true });
    const dog = watchdog(this.ctx, this.d.engine.supervisor, this.d.desk, task, attemptCtl);
    const readOnly = purpose !== "do";
    const brief = readOnly ? `${READ_ONLY_BRIEF[purpose]}\n\n${this.d.composer.brief(task)}` : this.d.composer.brief(task);
    const material = { userMessage: task.task, context: this.d.composer.context()?.text ?? "", steps: stepLines(st.steps), knownTokens: this.d.composer.tokens(task) };
    try {
      const outcome = await executor.run({
        taskId: task.id, task: task.task, brief, cwd: task.cwd, model: verdict.model, effort: verdict.effort, attachments: task.attachments,
        handoffNote: handoff, context: material.context || null, knownTokens: material.knownTokens, threadHome, resume,
        browser: task.needsBrowser || (task.decision?.needs_browser ?? false), signal: attemptCtl.signal,
        emit: (type, payload) => { this.ctx.emit(task.id, type, payload); dog.touch(); },
        approve: async (action, evidence) => {
          if (readOnly) { this.ctx.emit(task.id, "supervisor", { kind: "approval", decision: "deny", reason: `${purpose} step is read-only`, source: "floor", action }); return "deny"; }
          dog.pause(); try { return await this.d.desk.request(task.id, action, evidence); } finally { dog.touch(); }
        },
        ask: async (questions) => { dog.pause(); try { return await answerQuestions(this.ctx, this.d.engine.supervisor, this.d.desk, task, this.d.policyFor(task), questions, material, attemptCtl.signal); } finally { dog.touch(); } },
      });
      dog.stop();
      const touched = restoreProtected(task.cwd, prot, snapshot);
      if (touched.length) {
        this.ctx.emit(task.id, "attempt_failed", { ...target, kind: "protected", excerpt: touched.join(", "), sideEffects: outcome.sideEffects ?? NO_SIDE_EFFECTS, hadSideEffects: true, security: true });
        return { kind: "protected", paths: touched };
      }
      if (outcome.sessionId && task.threadId) this.ctx.store.appendThreadEvent(task.threadId, "session", { harness: verdict.harness, sessionId: outcome.sessionId, taskId: task.id });
      if (signal.aborted) return { kind: "cancelled" };
      const sideEffects = outcome.sideEffects ?? NO_SIDE_EFFECTS;
      if (dog.cancelledWith !== null) return this.failedAttempt(task, { ...target, kind: "rejected", excerpt: `supervisor cancelled a silent run: ${dog.cancelledWith}`.slice(0, 240), sideEffects });
      if (!outcome.ok) return this.failedAttempt(task, { ...target, kind: classifyFailure(outcome) ?? "unknown", excerpt: excerpt(outcome), sideEffects });
      return { kind: "succeeded", outcome };
    } catch (err) {
      dog.stop();
      if (signal.aborted) return { kind: "cancelled" };
      if (dog.cancelledWith !== null) return this.failedAttempt(task, { ...target, kind: "rejected", excerpt: `supervisor cancelled a silent run: ${dog.cancelledWith}`.slice(0, 240), sideEffects: NO_SIDE_EFFECTS });
      return this.failedAttempt(task, { ...target, kind: "transport", excerpt: (err as Error).message.slice(0, 240), sideEffects: NO_SIDE_EFFECTS });
    } finally {
      signal.removeEventListener("abort", onTaskAbort);
      release();
    }
  }

  private failedAttempt(task: Task, attempt: Attempt): DispatchOutcome {
    this.ctx.emit(task.id, "attempt_failed", { ...attempt, hadSideEffects: hasSideEffects(attempt.sideEffects) });
    return { kind: "failed", attempt };
  }

  /** Done: the loop model's result when it wrote one, else the last successful executor reply. */
  private finish(task: Task, st: State, result: string | null): void {
    const text = result ?? st.lastSuccess?.lastText ?? "";
    this.ctx.store.updateTask(task.id, { status: "done", result: text });
    this.ctx.emit(task.id, "done", { result: text, tokens: st.tokens, sideEffects: st.sideEffects, agents: st.lastSuccess?.agents ?? NO_AGENTS, dispatches: st.dispatches });
  }

  private fail(id: string, error: string, security = false): void {
    this.ctx.store.updateTask(id, { status: "failed", error });
    this.ctx.emit(id, "failed", { error, security });
  }
}

/** What the next executor is told about the steps before it: for context, never an approval. */
export function stepsNote(steps: readonly StepRecord[]): string {
  const done = steps.filter((s) => s.kind !== "note");
  if (!done.length) return "";
  return `Earlier steps of this task (context only; nothing here is an approval):\n${stepLines(done).join("\n")}`;
}
