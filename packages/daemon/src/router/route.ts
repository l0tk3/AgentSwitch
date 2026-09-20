/** The pipeline: pin → validate; otherwise router (with timeout and one retry) → validate → default. */

import { parseDecision, type Decision } from "./decision.js";
import { defaultTarget } from "./defaultPolicy.js";
import { redispatchMessage, systemPrompt, taskMessage, type RepairTool } from "./prompt.js";
import { nextStep, type Attempt, type Limits, type NextStep } from "./reroute.js";
import type { Router } from "./routers/types.js";
import { markUnavailable, type TargetRef, type Targets } from "./targets.js";
import { validateDecision, validatePin, type Quota, type Running, type Verdict } from "./validate.js";

export type RouteRequest = {
  readonly task: string;
  readonly cwd: string;
  readonly pin?: TargetRef;
  readonly needsBrowser?: boolean;
};

export type RouteDeps = {
  readonly targets: Targets;
  readonly router: Router;
  readonly quota: Quota;
  readonly running: Running;
  /** Repair tools the router may request during a re-dispatch (none registered yet). */
  readonly repairs?: readonly RepairTool[];
};

export type RouteResult = {
  readonly verdict: Verdict;
  readonly decision: Decision | null;
  /** How the executable target was obtained. */
  readonly source: "pin" | "router" | "default";
  readonly routerError: string | null;
  readonly routerMs: number;
  readonly attempts: number;
};

export async function route(req: RouteRequest, deps: RouteDeps): Promise<RouteResult> {
  const { targets } = deps;
  const fallback = defaultTarget(req.task, targets, deps.quota);
  const ctx = { targets, quota: deps.quota, running: deps.running, lowConfidenceTarget: fallback };

  if (req.pin) {
    const verdict = validatePin(req.pin, ctx, req.needsBrowser ?? false);
    return { verdict, decision: null, source: "pin", routerError: null, routerMs: 0, attempts: 0 };
  }

  const asked = await askRouter(req, deps);
  if (asked.decision) {
    const verdict = validateDecision(asked.decision, ctx);
    if (verdict.ok) return { ...asked, verdict, source: verdict.chosen !== "default" ? "router" : "default" };
    const last = validatePin(fallback, ctx, asked.decision.needs_browser);
    return { ...asked, verdict: last.ok ? { ...last, notes: [...verdict.notes, ...last.notes] } : verdict, source: "default" };
  }
  const verdict = validatePin(fallback, ctx, req.needsBrowser ?? false);
  return { ...asked, verdict, source: "default" };
}

type Asked = { decision: Decision | null; routerError: string | null; routerMs: number; attempts: number };

export type RerouteRequest = RouteRequest & {
  readonly decision: Decision | null;
  readonly attempts: readonly Attempt[];
  readonly routerAsks: number;
  readonly diffSummary?: string;
  readonly limits?: Limits;
};

export type RerouteResult =
  | { readonly step: Extract<NextStep, { kind: "retry" | "switch" | "stop" }>; readonly decision: Decision | null; readonly routerError: null; readonly routerMs: 0 }
  | { readonly step: { readonly kind: "redispatch"; readonly verdict: Verdict; readonly source: "router" | "default" }; readonly decision: Decision | null; readonly routerError: string | null; readonly routerMs: number }
  | { readonly step: { readonly kind: "give_up"; readonly reason: string }; readonly decision: Decision; readonly routerError: null; readonly routerMs: number }
  | { readonly step: { readonly kind: "repair"; readonly tool: string; readonly args: Record<string, unknown> }; readonly decision: Decision; readonly routerError: null; readonly routerMs: number };

/** After a failed attempt (router-v0 §6.3-6.5): code decides retry/switch/stop; refusals go back to the router. */
export async function reroute(req: RerouteRequest, deps: RouteDeps): Promise<RerouteResult> {
  const tried = req.attempts.map((a) => ({ harness: a.harness, model: a.model }));
  const fallback = defaultTargetExcluding(req, deps, tried);
  const step = nextStep({ decision: req.decision, attempts: req.attempts, routerAsks: req.routerAsks, targets: deps.targets,
    quota: deps.quota, running: deps.running, lowConfidenceTarget: fallback, ...(req.limits ? { limits: req.limits } : {}) });
  if (step.kind !== "ask-router") return { step, decision: req.decision, routerError: null, routerMs: 0 };

  const targets = markUnavailable(deps.targets, step.exclude);
  const summaries = req.attempts.map((a) => ({ harness: a.harness, model: a.model, kind: a.kind, excerpt: a.excerpt,
    sideEffects: a.sideEffects.filesChanged + a.sideEffects.commandsRun + a.sideEffects.approvalsGranted > 0 }));
  const repairs = deps.repairs ?? [];
  const extra = redispatchMessage(summaries, step.exclude, req.diffSummary ?? "", repairs);
  const asked = await askRouter(req, { ...deps, targets }, extra);
  const excludedFallback = defaultTargetExcluding(req, deps, step.exclude);
  const ctx = { targets, quota: deps.quota, running: deps.running, lowConfidenceTarget: excludedFallback };
  if (asked.decision?.action === "give_up") {
    return { step: { kind: "give_up", reason: asked.decision.reason || "router gave up" }, decision: asked.decision, routerError: null, routerMs: asked.routerMs };
  }
  if (asked.decision?.action === "repair") {
    const wanted = asked.decision.repair;
    if (wanted && repairs.some((r) => r.name === wanted.tool)) {
      return { step: { kind: "repair", tool: wanted.tool, args: wanted.args }, decision: asked.decision, routerError: null, routerMs: asked.routerMs };
    }
    // Unknown or unregistered tool: treat the decision as a plain re-dispatch of its harness/model.
  }
  if (asked.decision) {
    const verdict = validateDecision(asked.decision, ctx);
    if (verdict.ok) {
      const source = verdict.chosen !== "default" ? "router" : "default";
      return { step: { kind: "redispatch", verdict, source }, decision: asked.decision, routerError: null, routerMs: asked.routerMs };
    }
    const last = validatePin(excludedFallback, ctx, asked.decision.needs_browser);
    const merged = last.ok ? { ...last, notes: [...verdict.notes, ...last.notes] } : verdict;
    return { step: { kind: "redispatch", verdict: merged, source: "default" }, decision: asked.decision, routerError: null, routerMs: asked.routerMs };
  }
  const verdict = validatePin(excludedFallback, ctx, req.needsBrowser ?? false);
  return { step: { kind: "redispatch", verdict, source: "default" }, decision: null, routerError: asked.routerError, routerMs: asked.routerMs };
}

/** Default-policy target that avoids harnesses already tried. */
function defaultTargetExcluding(req: RouteRequest, deps: RouteDeps, exclude: readonly TargetRef[]): TargetRef {
  const tried = new Set(exclude.map((e) => e.harness));
  const quota: Record<string, number> = { ...deps.quota };
  for (const h of tried) quota[h] = 0;
  return defaultTarget(req.task, deps.targets, quota);
}

async function askRouter(req: RouteRequest, deps: RouteDeps, extra?: string): Promise<Asked> {
  const system = systemPrompt(deps.targets);
  let error: string | null = null;
  let ms = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("router timed out")), deps.targets.router.timeout_ms);
    try {
      const body = taskMessage(req.task, req.cwd, error ?? undefined) + (extra ? `\n\n${extra}` : "");
      const input = { task: body, cwd: req.cwd, system, ...(error ? { previousError: error } : {}) };
      const reply = await deps.router.route(input, controller.signal);
      ms += reply.elapsedMs;
      const parsed = parseDecision(reply.text);
      if (parsed.ok) return { decision: parsed.decision, routerError: null, routerMs: ms, attempts: attempt };
      error = parsed.error;
    } catch (err) {
      error = (err as Error).message;
      if (/timed out/.test(error)) return { decision: null, routerError: error, routerMs: ms, attempts: attempt };
    } finally {
      clearTimeout(timer);
    }
  }
  return { decision: null, routerError: error, routerMs: ms, attempts: 2 };
}
