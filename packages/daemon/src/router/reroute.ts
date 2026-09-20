/** After a failed attempt: retry, switch along the fallback chain, ask the router again, or stop.
 *  Pure (router-v0 §6.3, §6.4). The orchestration that actually asks the router is in route.ts. */

import type { Decision } from "./decision.js";
import { hasSideEffects, type FailureKind, type SideEffects } from "./failure.js";
import { markUnavailable, type TargetRef, type Targets } from "./targets.js";
import { validateDecision, validatePin, type Quota, type Running } from "./validate.js";

export type Attempt = {
  readonly harness: string;
  readonly model: string;
  readonly kind: FailureKind;
  readonly excerpt: string;
  readonly sideEffects: SideEffects;
};

export type Limits = { readonly maxAttempts: number; readonly maxRouterAsks: number };
export const DEFAULT_LIMITS: Limits = { maxAttempts: 3, maxRouterAsks: 2 };

export type RerouteInput = {
  readonly decision: Decision | null;
  readonly attempts: readonly Attempt[];
  readonly routerAsks: number;
  readonly targets: Targets;
  readonly quota: Quota;
  readonly running: Running;
  readonly lowConfidenceTarget: TargetRef;
  readonly limits?: Limits;
};

export type NextStep =
  | { readonly kind: "retry"; readonly target: TargetRef; readonly backoffMs: number }
  | { readonly kind: "switch"; readonly target: TargetRef; readonly notes: readonly string[] }
  | { readonly kind: "ask-router"; readonly exclude: readonly TargetRef[] }
  | { readonly kind: "stop"; readonly reason: string; readonly security: boolean };

const TRANSPORT_BACKOFF_MS = 5_000;

export function excludedTargets(attempts: readonly Attempt[]): TargetRef[] {
  const seen = new Map<string, TargetRef>();
  for (const a of attempts) seen.set(`${a.harness}/${a.model}`, { harness: a.harness, model: a.model });
  return [...seen.values()];
}

/** Quota-exhausted harnesses from the history, applied on top of the live quota table. */
export function quotaAfter(attempts: readonly Attempt[], quota: Quota): Quota {
  const out: Record<string, number> = { ...quota };
  for (const a of attempts) if (a.kind === "quota") out[a.harness] = 0;
  return out;
}

export function nextStep(input: RerouteInput): NextStep {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const last = input.attempts.at(-1);
  if (!last) return { kind: "stop", reason: "no attempt to recover from", security: false };
  if (last.kind === "gate_denied") return { kind: "stop", reason: "secret-gate denied a request; not re-dispatching", security: true };
  if (last.sideEffects.approvalsGranted > 0) return { kind: "stop", reason: "an approved action was taken before the failure; hand over to the user", security: false };
  if (input.attempts.length >= limits.maxAttempts) return { kind: "stop", reason: `max attempts (${limits.maxAttempts}) reached`, security: false };

  const target = { harness: last.harness, model: last.model };
  const sameTargetTransportFailures = input.attempts.filter((a) => a.kind === "transport" && a.harness === last.harness && a.model === last.model).length;
  if (last.kind === "transport" && sameTargetTransportFailures === 1 && !hasSideEffects(last.sideEffects)) {
    return { kind: "retry", target, backoffMs: TRANSPORT_BACKOFF_MS };
  }
  if (last.kind === "quota") return switchAlongChain(input, target);

  // transport (after the retry): the environment may be broken for every harness; let the router
  // judge and, once repair tools exist, fix it. refusal / task_failed / unknown: the router judges.
  if (last.kind !== "refusal" && last.kind !== "transport" && hasSideEffects(last.sideEffects)) {
    return { kind: "stop", reason: `${last.kind} after side effects; hand over to the user`, security: false };
  }
  if (input.routerAsks >= limits.maxRouterAsks) {
    // Out of router asks: transport can still move along the chain by itself; the rest stops.
    return last.kind === "transport" ? switchAlongChain(input, target) : { kind: "stop", reason: `router already asked ${input.routerAsks} times`, security: false };
  }
  return { kind: "ask-router", exclude: excludedTargets(input.attempts) };
}

function switchAlongChain(input: RerouteInput, failed: TargetRef): NextStep {
  const excluded = excludedTargets(input.attempts);
  const targets = markUnavailable(input.targets, excluded);
  const quota = quotaAfter(input.attempts, input.quota);
  const ctx = { targets, quota, running: input.running, lowConfidenceTarget: input.lowConfidenceTarget };
  const decision = input.decision ?? {
    harness: failed.harness, model: failed.model, effort: null, brief: "", needs_browser: false, expected_size: "medium" as const,
    risk: null, fallbacks: [], reason: "", confidence: 1, action: "redispatch" as const, repair: null, handoff_note: null,
  };
  const verdict = validateDecision({ ...decision, confidence: Math.max(decision.confidence, targets.router.min_confidence) }, ctx);
  if (verdict.ok) return { kind: "switch", target: { harness: verdict.harness, model: verdict.model }, notes: verdict.notes };
  const lastResort = validatePin(input.lowConfidenceTarget, ctx, decision.needs_browser);
  if (lastResort.ok) return { kind: "switch", target: input.lowConfidenceTarget, notes: [...verdict.notes, "default policy target"] };
  return { kind: "stop", reason: `no remaining target: ${[...verdict.notes, ...lastResort.notes].join("; ")}`, security: false };
}
