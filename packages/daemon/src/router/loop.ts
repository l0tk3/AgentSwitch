/** loop-v0: the next action of a running task, from the loop model (the router, or the planner for multi-step
 *  tasks). One call, one JSON object; a dispatch goes through the same floors as the first routing decision. */

import { z } from "zod";
import { askJson } from "./ask.js";
import { Decision, extractJsonObject, type Decision as DecisionT } from "./decision.js";
import { loopSection, stepsMessage, type StepRecord } from "./prompt.js";
import { routerSystem, verdictFor, type RouteDeps, type RouteRequest } from "./route.js";
import type { Router } from "./routers/types.js";
import { markUnavailable, type TargetRef } from "./targets.js";
import type { Verdict } from "./validate.js";

export const MAX_DISPATCHES = 5;
export const MAX_LOOP_STEPS = 12;

export type LoopAction =
  | { readonly kind: "dispatch"; readonly decision: DecisionT; readonly verdict: Verdict; readonly source: "router" | "default" }
  | { readonly kind: "ask_user"; readonly question: string }
  | { readonly kind: "finish"; readonly result: string | null; readonly reason: string }
  | { readonly kind: "give_up"; readonly reason: string }
  | { readonly kind: "repair"; readonly tool: string; readonly args: Record<string, unknown> };

export type LoopReply =
  | { readonly kind: "dispatch"; readonly decision: DecisionT }
  | { readonly kind: "ask_user"; readonly question: string }
  | { readonly kind: "finish"; readonly result: string | null; readonly reason: string }
  | { readonly kind: "give_up"; readonly reason: string }
  | { readonly kind: "repair"; readonly decision: DecisionT; readonly tool: string; readonly args: Record<string, unknown> };

const Head = z.object({
  action: z.enum(["dispatch", "redispatch", "repair", "finish", "ask_user", "clarify", "give_up"]).default("dispatch"),
  question: z.string().nullable().default(null),
  result: z.string().nullable().default(null),
  reason: z.string().default(""),
}).loose();

/** A reply in the decision shape is a dispatch; finish / ask_user / give_up need only their own fields. */
export function parseLoopReply(text: string): { ok: true; value: LoopReply } | { ok: false; error: string } {
  const raw = extractJsonObject(text);
  if (raw === undefined) return { ok: false, error: "no JSON object in reply" };
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch (err) { return { ok: false, error: `invalid JSON: ${(err as Error).message}` }; }
  const head = Head.safeParse(obj);
  if (!head.success) return { ok: false, error: head.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const h = head.data;
  if (h.action === "finish") return { ok: true, value: { kind: "finish", result: h.result?.trim() || null, reason: h.reason } };
  if (h.action === "give_up") return { ok: true, value: { kind: "give_up", reason: h.reason || "router gave up" } };
  if (h.action === "ask_user" || h.action === "clarify") {
    return h.question?.trim() ? { ok: true, value: { kind: "ask_user", question: h.question.trim() } } : { ok: false, error: "ask_user needs a question" };
  }
  const decision = Decision.safeParse({ ...(obj as Record<string, unknown>), action: h.action === "repair" ? "repair" : "redispatch" });
  if (!decision.success) return { ok: false, error: decision.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const d = decision.data;
  if (h.action === "repair" && d.repair) return { ok: true, value: { kind: "repair", decision: d, tool: d.repair.tool, args: d.repair.args } };
  return { ok: true, value: { kind: "dispatch", decision: d } };
}

export type NextInput = {
  readonly req: RouteRequest;
  readonly steps: readonly StepRecord[];
  readonly used: number;
  readonly budget: number;
  /** Targets that failed in this task: hidden from the catalog and refused by the floor. */
  readonly exclude: readonly TargetRef[];
};

export type NextResult = { readonly action: LoopAction | null; readonly routerError: string | null; readonly routerMs: number };

/** Ask the loop model what to do next. A dispatch is validated like any routing decision (excluded targets fall to the
 *  default policy); an unusable reply gives `action: null` and the caller decides (default target, or finish). */
export async function nextAction(router: Router, deps: RouteDeps, input: NextInput, signal?: AbortSignal): Promise<NextResult> {
  const system = routerSystem({ ...deps, targets: input.exclude.length ? markUnavailable(deps.targets, input.exclude) : deps.targets }) + loopSection(input.exclude, deps.repairs ?? []);
  const body = (error?: string) => stepsMessage(input.req.task, input.req.cwd, input.steps, input.used, input.budget, error);
  const r = await askJson(router, { system, cwd: input.req.cwd, body }, parseLoopReply, deps.targets.router.timeout_ms, signal);
  if (!r.value) return { action: null, routerError: r.error, routerMs: r.ms };
  const v = r.value;
  if (v.kind === "repair") {
    const listed = (deps.repairs ?? []).some((t) => t.name === v.tool);
    if (listed) return { action: { kind: "repair", tool: v.tool, args: v.args }, routerError: null, routerMs: r.ms };
    return { action: { kind: "dispatch", decision: v.decision, ...verdictFor(v.decision, input.req, deps, input.exclude) }, routerError: null, routerMs: r.ms };
  }
  if (v.kind === "dispatch") return { action: { kind: "dispatch", decision: v.decision, ...verdictFor(v.decision, input.req, deps, input.exclude) }, routerError: null, routerMs: r.ms };
  return { action: v, routerError: null, routerMs: r.ms };
}
