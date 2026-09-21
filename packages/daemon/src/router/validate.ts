/** The floor: pure checks that decide whether a router decision may be executed as-is. */

import type { Decision } from "./decision.js";
import type { Guards } from "../threads/record.js";
import { allowedFor, modelSpec, type TargetRef, type Targets } from "./targets.js";

/** Fraction of quota left per harness, 0..1. Missing harness = unknown = treated as available. */
export type Quota = Readonly<Record<string, number>>;
/** Tasks currently running per harness. */
export type Running = Readonly<Record<string, number>>;

export type Context = {
  readonly targets: Targets;
  readonly quota: Quota;
  readonly running: Running;
  /** Where a low-confidence decision goes instead of the router's pick (default policy). */
  readonly lowConfidenceTarget: TargetRef;
  /** Category detected from the task text (keyword floor); the router's own `category` is merged in. */
  readonly category?: string | null;
  /** Track-record guards for this task's kind (threads-v0 §7): demoted targets go behind the fallbacks. */
  readonly guards?: Guards;
};

export type Chosen = "router" | "fallback" | "default" | "pin";

export type Verdict =
  | {
      readonly ok: true;
      readonly harness: string;
      readonly model: string;
      readonly effort: string | null;
      readonly chosen: Chosen;
      readonly queue: boolean;
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly notes: readonly string[] };

type Candidate = { ref: TargetRef; chosen: Chosen };

/** Why a single (harness, model) cannot run now, or undefined when it can. */
export function rejectReason(ref: TargetRef, ctx: Context, needsBrowser: boolean, effort: string | null): string | undefined {
  const harness = ctx.targets.harnesses[ref.harness];
  if (!harness) return `unknown harness ${ref.harness}`;
  const spec = modelSpec(harness, ref.model);
  if (!spec) return `${ref.harness}: model ${ref.model} not in catalog`;
  if (spec.unavailable) return `${ref.harness}/${ref.model} is unavailable`;
  if (needsBrowser && !harness.browser) return `${ref.harness} has no browser`;
  const left = ctx.quota[ref.harness];
  if (left !== undefined && left < ctx.targets.router.quota_threshold) return `${ref.harness} quota exhausted (${left})`;
  if (effort !== null && spec.efforts && !spec.efforts.includes(effort)) return `${ref.model} has no effort ${effort}`;
  const category = ctx.category ?? null;
  if (!allowedFor(ctx.targets, category, ref)) return `${ref.harness}/${ref.model} is not allowed for category ${category} (would refuse)`;
  return undefined;
}

function resolveModel(targets: Targets, harness: string, model: string | null): string {
  return model ?? targets.harnesses[harness]?.default_model ?? "";
}

/** A pinned target skips the router entirely; still subject to catalog, browser, quota and concurrency. */
export function validatePin(pin: TargetRef, ctx: Context, needsBrowser = false): Verdict {
  const reason = rejectReason(pin, { ...ctx, category: null }, needsBrowser, null);
  if (reason) return { ok: false, notes: [`pin rejected: ${reason}`] };
  const warn = allowedFor(ctx.targets, ctx.category ?? null, pin) ? [] : [`pinned ${pin.harness}/${pin.model} is outside the ${ctx.category} allow list; it may refuse`];
  return accept(pin, null, "pin", ctx, warn);
}

export function validateDecision(decision: Decision, base: Context): Verdict {
  const category = decision.category && base.targets.categories[decision.category] ? decision.category : (base.category ?? null);
  const ctx: Context = { ...base, category };
  const { targets } = ctx;
  const notes: string[] = [];
  const candidates: Candidate[] = [];
  if (decision.confidence < targets.router.min_confidence) {
    notes.push(`confidence ${decision.confidence} below ${targets.router.min_confidence}; using default policy target`);
    candidates.push({ ref: ctx.lowConfidenceTarget, chosen: "default" });
  } else {
    const primary = { harness: decision.harness, model: resolveModel(targets, decision.harness, decision.model) };
    const same = (a: TargetRef, b: TargetRef) => a.harness === b.harness && a.model === b.model;
    const demoted = ctx.guards?.demoted.some((d) => same(d, primary)) ?? false;
    if (demoted) notes.push(`${primary.harness}/${primary.model} demoted: ${ctx.guards!.demoted.length ? "three consecutive failures on this kind of task; trying fallbacks first" : ""}`.trimEnd());
    if (!demoted) candidates.push({ ref: primary, chosen: "router" });
    for (const fb of decision.fallbacks) candidates.push({ ref: fb, chosen: "fallback" });
    if (demoted) candidates.push({ ref: primary, chosen: "fallback" });
    const overridden = ctx.guards?.overridden.find((o) => same(o, primary));
    if (overridden && !decision.reason.trim()) notes.push(`${primary.harness}/${primary.model}: the user handed this kind of task off from it before and the router gave no reason`);
  }
  candidates.push({ ref: targets.router.default, chosen: "default" });

  for (const [i, cand] of candidates.entries()) {
    const effort = i === 0 && cand.chosen === "router" ? decision.effort : null;
    const reason = rejectReason(cand.ref, ctx, decision.needs_browser, effort);
    if (reason) {
      notes.push(`${cand.ref.harness}/${cand.ref.model}: ${reason}`);
      continue;
    }
    return accept(cand.ref, effort, cand.chosen, ctx, notes);
  }
  return { ok: false, notes: [...notes, "no candidate can run"] };
}

function accept(ref: TargetRef, effort: string | null, chosen: Chosen, ctx: Context, notes: readonly string[]): Verdict {
  const max = ctx.targets.harnesses[ref.harness]?.max_concurrent ?? 1;
  const queue = (ctx.running[ref.harness] ?? 0) >= max;
  return {
    ok: true,
    harness: ref.harness,
    model: ref.model,
    effort,
    chosen,
    queue,
    notes: queue ? [...notes, `${ref.harness} at max_concurrent; queued`] : notes,
  };
}
