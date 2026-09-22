/** The pipeline: pin → validate; otherwise router (with timeout and one retry) → validate → default. */

import { aggregateRecords, guardsFor, recordText, type RecordRow } from "../threads/record.js";
import type { ThreadBrief } from "../threads/types.js";
import { EMPTY_CONTEXT, type LoadedContext } from "./context.js";
import { parseDecision, type Decision } from "./decision.js";
import { classify, defaultTarget } from "./defaultPolicy.js";
import { redispatchMessage, systemPrompt, taskMessage, type ExtensionsSummary, type RepairTool } from "./prompt.js";
import { nextStep, type Attempt, type Limits, type NextStep } from "./reroute.js";
import type { Router } from "./routers/types.js";
import { categoryOf, markUnavailable, type TargetRef, type Targets } from "./targets.js";
import { validateDecision, validatePin, validateTarget, type Quota, type Running, type Verdict } from "./validate.js";

export type RouteRequest = {
  readonly task: string;
  readonly cwd: string;
  readonly pin?: TargetRef;
  readonly needsBrowser?: boolean;
  /** Targets treated as unavailable for this task (the executor a user handed the task off from). */
  readonly exclude?: readonly TargetRef[];
};

export type RouteDeps = {
  readonly targets: Targets;
  readonly router: Router;
  readonly quota: Quota;
  readonly running: Running;
  /** Repair tools the router may request during a re-dispatch (none registered yet). */
  readonly repairs?: readonly RepairTool[];
  /** The user's CONTEXT.md, already linted (see context.ts). */
  readonly context?: LoadedContext;
  /** MEMORY.md, linted the same way. */
  readonly memory?: LoadedContext;
  /** Track record rows (last 30 days) for the prompt and the guards. */
  readonly records?: readonly RecordRow[];
  readonly extensions?: ExtensionsSummary;
  /** Open threads for the router's thread assignment (threads-v0 §6). */
  readonly threads?: readonly ThreadBrief[];
};

/** The router's label, else the default policy's coarse class. */
export function kindOf(task: string, decision: Decision | null): string {
  return decision?.kind ?? classify(task);
}

export type RouteResult = {
  /** The router asked for the user's input instead of dispatching (Decision.action=clarify). */
  readonly clarify?: string;
  readonly verdict: Verdict;
  readonly decision: Decision | null;
  /** How the executable target was obtained. */
  readonly source: "pin" | "router" | "default";
  readonly routerError: string | null;
  readonly routerMs: number;
  readonly attempts: number;
};

export async function route(req: RouteRequest, deps: RouteDeps): Promise<RouteResult> {
  const exclude = req.exclude ?? [];
  const targets = exclude.length ? markUnavailable(deps.targets, exclude) : deps.targets;
  const fallback = defaultTargetExcluding(req, deps, exclude);
  const ctx = { targets, quota: deps.quota, running: deps.running, lowConfidenceTarget: fallback, category: categoryOf(req.task, targets) };

  if (req.pin) {
    // A pin is the user's decision: it is validated against the full catalog, exclusions notwithstanding.
    const verdict = validatePin(req.pin, { ...ctx, targets: deps.targets }, req.needsBrowser ?? false);
    return { verdict, decision: null, source: "pin", routerError: null, routerMs: 0, attempts: 0 };
  }

  const extra = exclude.length ? `Excluded (do not choose; the user handed this task off from them): ${exclude.map((e) => `${e.harness}/${e.model}`).join(", ")}` : undefined;
  const asked = await askRouter(req, { ...deps, targets }, extra);
  if (asked.decision?.action === "clarify" && asked.decision.question?.trim()) {
    return { ...asked, clarify: asked.decision.question.trim(), verdict: { ok: false, notes: ["router asks the user a question first"] }, source: "router" };
  }
  if (asked.decision) {
    const verdict = validateDecision(asked.decision, { ...ctx, guards: guardsFor(deps.records ?? [], kindOf(req.task, asked.decision)) });
    if (verdict.ok) return { ...asked, verdict, source: verdict.chosen !== "default" ? "router" : "default" };
    const last = validateTarget(fallback, ctx, asked.decision.needs_browser, "default");
    return { ...asked, verdict: last.ok ? { ...last, notes: [...verdict.notes, ...last.notes] } : verdict, source: "default" };
  }
  const verdict = validateTarget(fallback, ctx, req.needsBrowser ?? false, "default");
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
    quota: deps.quota, running: deps.running, lowConfidenceTarget: fallback, category: categoryOf(req.task, deps.targets), ...(req.limits ? { limits: req.limits } : {}) });
  if (step.kind !== "ask-router") return { step, decision: req.decision, routerError: null, routerMs: 0 };

  const targets = markUnavailable(deps.targets, step.exclude);
  const summaries = req.attempts.map((a) => ({ harness: a.harness, model: a.model, kind: a.kind, excerpt: a.excerpt,
    sideEffects: a.sideEffects.filesChanged + a.sideEffects.commandsRun + a.sideEffects.approvalsGranted > 0 }));
  const repairs = deps.repairs ?? [];
  const extra = redispatchMessage(summaries, step.exclude, req.diffSummary ?? "", repairs);
  const asked = await askRouter(req, { ...deps, targets }, extra);
  const excludedFallback = defaultTargetExcluding(req, deps, step.exclude);
  const ctx = { targets, quota: deps.quota, running: deps.running, lowConfidenceTarget: excludedFallback, category: categoryOf(req.task, targets) };
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
    const verdict = validateDecision(asked.decision, { ...ctx, guards: guardsFor(deps.records ?? [], kindOf(req.task, asked.decision)) });
    if (verdict.ok) {
      const source = verdict.chosen !== "default" ? "router" : "default";
      return { step: { kind: "redispatch", verdict, source }, decision: asked.decision, routerError: null, routerMs: asked.routerMs };
    }
    const last = validateTarget(excludedFallback, ctx, asked.decision.needs_browser, "default");
    const merged = last.ok ? { ...last, notes: [...verdict.notes, ...last.notes] } : verdict;
    return { step: { kind: "redispatch", verdict: merged, source: "default" }, decision: asked.decision, routerError: null, routerMs: asked.routerMs };
  }
  const verdict = validateTarget(excludedFallback, ctx, req.needsBrowser ?? false, "default");
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
  const system = systemPrompt(deps.targets, { context: deps.context ?? EMPTY_CONTEXT, memory: deps.memory ?? EMPTY_CONTEXT, record: recordText(aggregateRecords(deps.records ?? [])), extensions: deps.extensions ?? { mcp: [], skills: [] }, threads: deps.threads ?? [] });
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
      error = `${parsed.error}; reply began: ${JSON.stringify(reply.text.trim().slice(0, 200))}`;
    } catch (err) {
      error = (err as Error).message;
      if (/timed out/.test(error)) return { decision: null, routerError: error, routerMs: ms, attempts: attempt };
    } finally {
      clearTimeout(timer);
    }
  }
  return { decision: null, routerError: error, routerMs: ms, attempts: 2 };
}
