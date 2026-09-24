/** loop-v0: the next action of a running task, from the loop model (the router, or the planner for multi-step
 *  tasks). One call, one JSON object; a dispatch goes through the same floors as the first routing decision. */

import { z } from "zod";
import { askJson, type AskFailureKind } from "./ask.js";
import { Decision, extractJsonObject, type Decision as DecisionT } from "./decision.js";
import { loopSection, stepsMessage, type StepRecord } from "./prompt.js";
import { routerSystem, verdictFor, type RouteDeps, type RouteRequest } from "./route.js";
import type { Router } from "../core/modelCall.js";
import type { TransferGrant } from "../core/transfer.js";
import { markUnavailable } from "./targets.js";
import type { TargetRef } from "../core/target.js";
import type { Verdict } from "./validate.js";
import { zodIssues } from "../util/zod.js";

/** Open items a `finish` reply may list. */
const MAX_REMAINING_ITEMS = 30;

export const MAX_DISPATCHES = 5;
export const MAX_LOOP_STEPS = 12;
export type Completion = "complete" | "partial" | "blocked";

export type LoopAction =
  | { readonly kind: "dispatch"; readonly decision: DecisionT; readonly verdict: Verdict; readonly source: "router" | "default" }
  | { readonly kind: "ask_user"; readonly question: string }
  | { readonly kind: "finish"; readonly result: string | null; readonly reason: string; readonly completion: Completion; readonly remaining: readonly string[] }
  | { readonly kind: "give_up"; readonly reason: string }
  | { readonly kind: "repair"; readonly tool: string; readonly args: Record<string, unknown> };

export type LoopReply =
  | { readonly kind: "dispatch"; readonly decision: DecisionT }
  | { readonly kind: "ask_user"; readonly question: string }
  | { readonly kind: "finish"; readonly result: string | null; readonly reason: string; readonly completion: Completion; readonly remaining: readonly string[] }
  | { readonly kind: "give_up"; readonly reason: string }
  | { readonly kind: "repair"; readonly decision: DecisionT; readonly tool: string; readonly args: Record<string, unknown> };

const Head = z.object({
  action: z.enum(["dispatch", "redispatch", "repair", "finish", "ask_user", "clarify", "give_up"]).default("dispatch"),
  question: z.string().nullable().default(null),
  result: z.string().nullable().default(null),
  reason: z.string().default(""),
}).loose();

const Finish = z.object({
  completion: z.enum(["complete", "partial", "blocked"]),
  remaining: z.array(z.string().trim().min(1)).max(MAX_REMAINING_ITEMS),
});

/** A reply in the decision shape is a dispatch; finish / ask_user / give_up need only their own fields. */
export function parseLoopReply(text: string): { ok: true; value: LoopReply } | { ok: false; error: string } {
  const raw = extractJsonObject(text);
  if (raw === undefined) return { ok: false, error: "no JSON object in reply" };
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch (err) { return { ok: false, error: `invalid JSON: ${(err as Error).message}` }; }
  const head = Head.safeParse(obj);
  if (!head.success) return { ok: false, error: zodIssues(head.error) };
  const h = head.data;
  if (h.action === "finish") {
    const completion = Finish.safeParse(obj);
    if (!completion.success) return { ok: false, error: "finish requires completion (complete/partial/blocked) and remaining (array of unresolved work)" };
    const { completion: status, remaining } = completion.data;
    const result = h.result?.trim() || null;
    if (status === "complete" && (!result || remaining.length)) return { ok: false, error: "complete requires a nonempty result and no remaining work" };
    if (status !== "complete" && !remaining.length) return { ok: false, error: "partial/blocked requires the remaining work or blocking condition" };
    return { ok: true, value: { kind: "finish", result, reason: h.reason, completion: status, remaining } };
  }
  if (h.action === "give_up") return { ok: true, value: { kind: "give_up", reason: h.reason || "router gave up" } };
  if (h.action === "ask_user" || h.action === "clarify") {
    return h.question?.trim() ? { ok: true, value: { kind: "ask_user", question: h.question.trim() } } : { ok: false, error: "ask_user needs a question" };
  }
  const decision = Decision.safeParse({ ...(obj as Record<string, unknown>), action: h.action === "repair" ? "repair" : "redispatch" });
  if (!decision.success) return { ok: false, error: zodIssues(decision.error) };
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
  /** A true planner has its own deadline; otherwise use the router's configured timeout. */
  readonly timeoutMs?: number;
  /** §5.2 grant pinned from the first routing decision, shown so a dispatch can restate it (or a subset). */
  readonly transfer?: TransferGrant | null;
};

export type NextResult = {
  readonly action: LoopAction | null;
  /** Fixed diagnostics only: no model reply excerpts or provider error strings. */
  readonly routerError: string | null;
  readonly routerMs: number;
  readonly failure?: { readonly kind: AskFailureKind; readonly tries: number; readonly timeoutMs: number };
};

export const LOOP_FAILURE_MESSAGE: Readonly<Record<AskFailureKind, string>> = {
  timeout: "模型调用超时，未在截止时间内取得有效规划动作",
  cancelled: "规划调用已取消",
  invalid_response: "模型回复格式不符合规划动作协议（JSON 或必填字段无效）",
  service_error: "规划模型服务调用失败",
};

/** Ask the loop model what to do next. A dispatch is validated like any routing decision (excluded targets fall to the
 *  default policy); an unusable reply gives `action: null`, never a completion assertion. */
export async function nextAction(router: Router, deps: RouteDeps, input: NextInput, signal?: AbortSignal): Promise<NextResult> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? deps.targets.router.timeout_ms;
  let tries = 0;
  const failed = (kind: AskFailureKind): NextResult => ({ action: null, routerError: LOOP_FAILURE_MESSAGE[kind], routerMs: Date.now() - started, failure: { kind, tries, timeoutMs } });
  if (signal?.aborted) return failed("cancelled");
  const system = routerSystem({ ...deps, targets: input.exclude.length ? markUnavailable(deps.targets, input.exclude) : deps.targets }, input.req.task) + loopSection(input.exclude, deps.repairs ?? []);
  const body = (error?: string) => stepsMessage(input.req.task, input.req.cwd, input.steps, input.used, input.budget, error, input.transfer ?? null);
  const deadline = new AbortController();
  const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => deadline.abort(new Error("loop model timed out")), timeoutMs);
  let onAbort!: () => void;
  let r;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error(signal?.aborted ? "cancelled" : "loop model timed out"));
      combined.addEventListener("abort", onAbort, { once: true });
    });
    const guarded: Router = { name: router.name, async route(request, inner) {
      combined.throwIfAborted();
      tries++;
      const reply = await router.route(request, inner);
      combined.throwIfAborted();
      return reply;
    } };
    combined.throwIfAborted();
    r = await Promise.race([askJson(guarded, { system, cwd: input.req.cwd, body }, parseLoopReply, timeoutMs, combined), aborted]);
  } catch {
    return failed(signal?.aborted ? "cancelled" : deadline.signal.aborted ? "timeout" : "service_error");
  } finally {
    clearTimeout(timer);
    if (onAbort) combined.removeEventListener("abort", onAbort);
    deadline.abort();
  }
  if (signal?.aborted) return failed("cancelled");
  if (!r.value) return failed(r.failureKind ?? "service_error");
  const routerMs = Date.now() - started;
  const v = r.value;
  if (v.kind === "repair") {
    const listed = (deps.repairs ?? []).some((t) => t.name === v.tool);
    if (listed) return { action: { kind: "repair", tool: v.tool, args: v.args }, routerError: null, routerMs };
    return { action: { kind: "dispatch", decision: v.decision, ...verdictFor(v.decision, input.req, deps, input.exclude) }, routerError: null, routerMs };
  }
  if (v.kind === "dispatch") return { action: { kind: "dispatch", decision: v.decision, ...verdictFor(v.decision, input.req, deps, input.exclude) }, routerError: null, routerMs };
  return { action: v, routerError: null, routerMs };
}
