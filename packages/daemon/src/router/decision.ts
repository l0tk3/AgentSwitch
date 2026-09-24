/** What the router model returns, and how to pull it out of a chatty reply. */

import { z } from "zod";
import { zodIssues } from "../util/zod.js";
import { extractJsonObject } from "../util/json.js";
import { TargetRef } from "../core/target.js";

/** A task-kind label (the track record groups by it). */
const MAX_KIND_CHARS = 40;

export { extractJsonObject };

export const Decision = z.object({
  harness: z.string().min(1),
  model: z.string().min(1).nullable().default(null),
  effort: z.string().min(1).nullable().default(null),
  brief: z.string().min(1),
  needs_browser: z.boolean().default(false),
  /** A category from targets.yaml whose allow list restricts the executor (null = unrestricted). */
  category: z.string().min(1).nullable().default(null),
  /** Task kind for the track record (threads-v0 §7): code-multifile | code-small | browser | chat | translate | other. */
  kind: z.string().min(1).max(MAX_KIND_CHARS).nullable().default(null),
  /** Which open thread this task continues (threads-v0 §6): a listed thread id, or "new". */
  thread: z.string().min(1).nullable().default(null),
  thread_confidence: z.number().min(0).max(1).nullable().default(null),
  expected_size: z.enum(["small", "medium", "large"]).default("medium"),
  /** loop-v0 §6: "multi" hands the task to the planner, which runs it step by step. */
  plan: z.enum(["single", "multi"]).default("single"),
  /** loop-v0 §6: with plan=multi, the catalog model the router wants to run the loop; null = the daemon's default. */
  planner: TargetRef.nullable().default(null),
  /** loop-v0: research/verify steps are read-only (approvals refused, brief says so). */
  purpose: z.enum(["research", "do", "verify"]).default("do"),
  risk: z.string().nullable().default(null),
  fallbacks: z.array(TargetRef).default([]),
  reason: z.string().default(""),
  confidence: z.number().min(0).max(1),
  /** Re-dispatch only: keep going with a new target, run a repair tool first, or tell the user why not. */
  action: z.enum(["redispatch", "repair", "give_up", "clarify"]).default("redispatch"),
  /** action=clarify: the one thing only the user can supply (credential, URL, which of two readings). */
  question: z.string().nullable().default(null),
  /** action=repair only: which registered repair tool to run, with its arguments. */
  repair: z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }).nullable().default(null),
  /** Re-dispatch only: what the next executor must know about the previous attempt. */
  handoff_note: z.string().nullable().default(null),
  /** gate-next-v0 §5.2 field transfer as the router wrote it. Read it only through `parseTransfer`/`transferGrant`
   *  (core/transfer.ts): a malformed grant must never fail the whole decision, and is dropped, never widened. */
  transfer: z.unknown().default(null),
});
export type Decision = z.infer<typeof Decision>;

export type ParseResult = { ok: true; decision: Decision } | { ok: false; error: string };


export function parseDecision(text: string): ParseResult {
  const raw = extractJsonObject(text);
  if (raw === undefined) return { ok: false, error: "no JSON object in reply" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const parsed = Decision.safeParse(value);
  if (parsed.success) return { ok: true, decision: parsed.data };
  // Non-dispatch actions do not need a target. In particular, a minimal give_up
  // must never become a schema error followed by the default policy dispatching.
  // Keep the existing Decision type for persisted records and callers; these
  // compatibility fields are not an executable target and route() stops first.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const control = value as Record<string, unknown>;
    if (control.action === "give_up" || control.action === "clarify" || control.action === "repair") {
      const reason = typeof control.reason === "string" ? control.reason : "";
      const repair = Decision.shape.repair.safeParse(control.repair);
      return { ok: true, decision: Decision.parse({
        harness: "router", brief: typeof control.brief === "string" && control.brief.trim() ? control.brief : reason || "Router control decision",
        confidence: 1, action: control.action, reason,
        question: typeof control.question === "string" ? control.question : null,
        repair: repair.success ? repair.data : null,
      }) };
    }
  }
  return { ok: false, error: zodIssues(parsed.error) };
}
