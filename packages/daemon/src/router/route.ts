/** The pipeline: pin → validate; otherwise router (with timeout and one retry) → validate → default. */

import { parseDecision, type Decision } from "./decision.js";
import { defaultTarget } from "./defaultPolicy.js";
import { systemPrompt, taskMessage } from "./prompt.js";
import type { Router } from "./routers/types.js";
import type { TargetRef, Targets } from "./targets.js";
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
  readonly now?: () => number;
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
    const source = verdict.ok && verdict.chosen !== "default" ? "router" : "default";
    return { ...asked, verdict, source };
  }
  const verdict = validatePin(fallback, ctx, req.needsBrowser ?? false);
  return { ...asked, verdict, source: "default" };
}

type Asked = { decision: Decision | null; routerError: string | null; routerMs: number; attempts: number };

async function askRouter(req: RouteRequest, deps: RouteDeps): Promise<Asked> {
  const system = systemPrompt(deps.targets);
  let error: string | null = null;
  let ms = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("router timed out")), deps.targets.router.timeout_ms);
    try {
      const input = { task: taskMessage(req.task, req.cwd, error ?? undefined), cwd: req.cwd, system, ...(error ? { previousError: error } : {}) };
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
