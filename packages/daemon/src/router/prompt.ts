/** The router agent's instructions and the per-task message. Kept as plain text so it can be diffed. */

import type { Targets } from "./targets.js";
import { catalogText } from "./targets.js";

export const DECISION_SHAPE = `{
  "harness": "<one of the listed harnesses>",
  "model": "<a model listed under that harness, or null for its default>",
  "effort": "<one of the model's efforts, or null>",
  "brief": "<the task rewritten for the executor: goal, acceptance criteria, paths not to touch, expected size>",
  "needs_browser": <true|false>,
  "expected_size": "small" | "medium" | "large",
  "risk": "<what could go wrong, or null>",
  "fallbacks": [{"harness": "...", "model": "..."}],
  "reason": "<one sentence>",
  "confidence": <0..1>,
  "action": "redispatch" | "repair" | "give_up",   // only when asked to decide again after a failure
  "repair": {"tool": "<a listed repair tool>", "args": {}} | null,   // only with action=repair
  "handoff_note": "<for the next executor: what was already done, what to avoid>" | null
}`;

export function systemPrompt(targets: Targets): string {
  return `You are the dispatcher for AgentSwitch. A task arrives; you decide which coding agent and model
should execute it and write a brief for that executor. You do not execute anything yourself.

Available targets (choose only from this list; every model is selectable):
${catalogText(targets)}

Rules:
- Multi-file code changes that need tests: a top/high model (Claude Opus/Fable or Codex Astra), whichever has quota.
  Small edits: a mid/low model. One-line questions, summaries, translation, very long material: opencode / deepseek-flash.
  Pick a "[1m]" variant only when the whole repository must fit in context. Prefer the cheapest model that is clearly enough.
- Browser tasks (open a site, log in, fill a form): needs_browser=true and a harness with browser support.
  Credentials arrive as enc:v1: tokens; pass them through unchanged and never ask the executor to find a password.
- The brief must contain: goal, acceptance criteria, paths not to touch, expected size. Do not invent requirements.
- You may read files under the working directory to judge size and language. Do not modify anything.
- If unsure, lower confidence instead of guessing.
- Reply with exactly one JSON object and nothing else, of this shape:
${DECISION_SHAPE}`;
}

export function taskMessage(task: string, cwd: string, previousError?: string): string {
  const retry = previousError ? `\n\nYour previous reply was rejected: ${previousError}. Reply with one valid JSON object only.` : "";
  return `Working directory: ${cwd}\n\nTask:\n${task}${retry}`;
}

export type AttemptSummary = { readonly harness: string; readonly model: string; readonly kind: string; readonly excerpt: string; readonly sideEffects: boolean };
export type RepairTool = { readonly name: string; readonly description: string };

/** Appended to the task message when the router is asked again after a failed attempt (§6.5). */
export function redispatchMessage(
  attempts: readonly AttemptSummary[],
  exclude: readonly { harness: string; model: string }[],
  diffSummary: string,
  repairs: readonly RepairTool[] = [],
): string {
  const lines = attempts.map((a, i) => `${i + 1}. ${a.harness}/${a.model} -> ${a.kind}: "${a.excerpt}" (${a.sideEffects ? "had side effects" : "no side effects"})`);
  const tools = repairs.length
    ? repairs.map((r) => `- ${r.name}: ${r.description}`).join("\n")
    : "(none registered; action=repair is not available)";
  return `Previous attempts:
${lines.join("\n")}
Excluded (do not choose): ${exclude.map((e) => `${e.harness}/${e.model}`).join(", ") || "none"}
Worktree diff: ${diffSummary || "(none)"}
Repair tools you may request with action="repair" (the daemon runs them, then asks you again):
${tools}

Decide again.
- refusal: the executor's safety filter misfired on a legitimate task. Judge whether another harness or model is likely
  to accept it, and rewrite the brief so it is clear this is the user's own account and enc:v1: values are placeholders
  substituted locally. If you judge the task genuinely should not be done, set action="give_up" and say why.
- transport (proxy, TLS, network, crash, silent timeout): the environment may be broken for every harness. Pick a
  harness whose path does not share the broken piece, or request a repair tool if one fits, or give_up with what the
  user should check.
- otherwise: pick a different harness or model, or give_up with the reason if nothing listed can do this.
Put what the next executor must know in handoff_note.`;
}
