/** Refusals have one bounded clarification path, separate from quality acceptance and target fallback. A provider's
 *  safety classifier block is not the model refusing: it gets one identical resend instead (router-v0 §6.2). */

import { hasSideEffects } from "../core/outcome.js";
import { localizeQuestion } from "../router/questionLanguage.js";
import { clarificationBrief, diagnoseRefusal, type RefusalSource } from "../router/refusal.js";
import type { Attempt } from "../router/reroute.js";
import type { LoopDeps } from "./taskLoop.js";
import { CLARIFY_ID, clarifyQuestion } from "../core/questions.js";
import type { Task } from "./types.js";

export type RefusalRecovery =
  | { readonly kind: "retry"; readonly brief: string }
  /** The same brief to the same target in a new session: nothing rewritten, no other model. */
  | { readonly kind: "resend" }
  | { readonly kind: "stop"; readonly error: string }
  | { readonly kind: "cancelled" };

export async function recoverRefusal(d: LoopDeps, task: Task, attempt: Attempt, alreadyRetried: boolean, signal: AbortSignal): Promise<RefusalRecovery> {
  const target = { harness: attempt.harness, model: attempt.model };
  const stop = (note: string, reason = "unknown"): RefusalRecovery => {
    d.ctx.emit(task.id, "refusal", { action: "stop", reason, note, target, refusal: attempt.refusal ?? null });
    return { kind: "stop", error: `refusal: ${note}` };
  };
  if (signal.aborted) return { kind: "cancelled" };
  if (attempt.refusal?.source === "provider") return providerBlock(d, task, attempt, alreadyRetried, stop);
  if (alreadyRetried) return stop("the single clarification retry has been used");
  if (attempt.sideEffectsKnown === false || hasSideEffects(attempt.sideEffects)) return stop("execution had side effects or incomplete telemetry; review its progress before continuing");

  const brief = task.brief ?? task.task;
  // Freeze the original sources. While waiting, only a real answer to this task can add facts;
  // edits to CONTEXT.md during diagnosis do not silently expand the source material.
  const initial = d.composer.refusalSources(task);
  let sources = initial;
  let newAnswer: RefusalSource | null = null;
  for (let round = 0; round < 2; round++) {
    const diagnosis = await diagnoseRefusal(d.engine.router, { cwd: task.cwd, brief, refusal: attempt.refusal?.reason ?? attempt.excerpt, sources }, d.engine.targets.router.timeout_ms, signal);
    if (signal.aborted) return { kind: "cancelled" };
    const live = d.ctx.store.getTask(task.id) ?? task;
    d.ctx.store.updateTask(task.id, { routerAsks: live.routerAsks + 1 });
    const result = diagnosis.diagnosis;
    if (!result) return stop("refusal diagnosis was unavailable or invalid; no fallback target was selected");
    if (result.action === "stop") return stop(result.note, result.reason);
    if (result.action === "clarify") {
      if (newAnswer && !result.facts.some((fact) => fact.sourceId === newAnswer!.id && fact.quote === newAnswer!.text)) {
        return stop("the diagnosis did not preserve the user's complete clarification answer");
      }
      d.ctx.emit(task.id, "refusal", { ...result, target, ms: diagnosis.ms, refusal: attempt.refusal ?? null });
      const clarified = clarificationBrief(brief, attempt.refusal?.reason ?? attempt.excerpt, result.facts);
      return { kind: "retry", brief: `${clarified}\n\nOriginal user task (scope and constraints still apply):\n${JSON.stringify(task.task)}` };
    }
    if (round > 0 || !result.question) return stop("one clarification question was already asked; no grounded retry is available");
    d.ctx.emit(task.id, "refusal", { ...result, target, ms: diagnosis.ms });
    // This goes straight to the user; the supervisor must not manufacture missing authorization.
    const text = await localizeQuestion(d.engine.questionRouter ?? d.engine.router, result.question, task.cwd, d.engine.targets.router.timeout_ms, signal);
    if (signal.aborted) return { kind: "cancelled" };
    const answers = await d.desk.ask(task.id, [clarifyQuestion(text, result.question)], "router");
    if (signal.aborted) return { kind: "cancelled" };
    if (!answers?.[CLARIFY_ID]?.some((value) => value.trim())) return stop("the user did not provide the missing context");
    const known = new Set(initial.map((source) => source.id));
    const added = d.composer.refusalSources(task).filter((source) => source.id.startsWith("answer:") && !known.has(source.id));
    if (added.length !== 1) return stop("the clarification answer could not be attributed to this question");
    newAnswer = added[0]!;
    sources = [...initial, newAnswer];
  }
  return stop("no grounded clarification was available");
}

/** A provider's safety classifier flagged the request (e.g. `[cyber]` on a plain login). Such flags are false positives
 *  often enough that the identical request passes when sent again (2026-09-24: 11 of 11 resends passed), so it is sent
 *  once more unchanged — unless it was already resent, or the flagged run had already done something. */
function providerBlock(d: LoopDeps, task: Task, attempt: Attempt, alreadyRetried: boolean, stop: (note: string, reason?: string) => RefusalRecovery): RefusalRecovery {
  if (alreadyRetried) return stop("the provider's safety classifier blocked the identical resend as well", "provider_safety");
  if (hasSideEffects(attempt.sideEffects)) return stop("the provider's safety classifier blocked a run that had already done something; review its progress before continuing", "provider_safety");
  d.ctx.emit(task.id, "refusal", { action: "retry", reason: "provider_safety", note: "the provider's safety classifier blocked the request; resending it unchanged once, in a new session", target: { harness: attempt.harness, model: attempt.model }, refusal: attempt.refusal ?? null });
  return { kind: "resend" };
}
