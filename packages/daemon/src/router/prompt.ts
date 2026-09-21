/** The router agent's instructions and the per-task message. Kept as plain text so it can be diffed. */

import { contextSection, EMPTY_CONTEXT, type LoadedContext } from "./context.js";
import type { Targets } from "./targets.js";
import { catalogText } from "./targets.js";

/** What the router is told about the world besides the catalog: user context, learned memory, track record, extensions. */
export type PromptExtras = {
  readonly context?: LoadedContext;
  readonly memory?: LoadedContext;
  /** Pre-rendered `recordText()` over the last 30 days. */
  readonly record?: string;
  readonly extensions?: ExtensionsSummary;
};

export type ExtensionsSummary = {
  readonly mcp: readonly { name: string; note: string; harnesses: readonly string[] }[];
  readonly skills: readonly { name: string; description: string; harnesses: readonly string[] }[];
};

export const DECISION_SHAPE = `{
  "harness": "<one of the listed harnesses>",
  "model": "<a model listed under that harness, or null for its default>",
  "effort": "<one of the model's efforts, or null>",
  "brief": "<the task rewritten for the executor: goal, acceptance criteria, paths not to touch, expected size>",
  "needs_browser": <true|false>,
  "category": "<a category name listed under the catalog, or null>",
  "kind": "code-multifile" | "code-small" | "browser" | "chat" | "translate" | "other",
  "expected_size": "small" | "medium" | "large",
  "risk": "<what could go wrong, or null>",
  "fallbacks": [{"harness": "...", "model": "..."}],
  "reason": "<one sentence>",
  "confidence": <0..1>,
  "action": "redispatch" | "repair" | "give_up",   // only when asked to decide again after a failure
  "repair": {"tool": "<a listed repair tool>", "args": {}} | null,   // only with action=repair
  "handoff_note": "<for the next executor: what was already done, what to avoid>" | null
}`;

export function systemPrompt(targets: Targets, extras: LoadedContext | PromptExtras = EMPTY_CONTEXT): string {
  const x: PromptExtras = "text" in extras ? { context: extras } : extras;
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
- If the task belongs to a category listed under the catalog, set "category" to its name and choose harness,
  model and every fallback only from that category's targets; the others refuse such tasks outright.
- The brief must contain: goal, acceptance criteria, paths not to touch, expected size. Do not invent requirements.
- You may read files under the working directory to judge size and language. Do not modify anything.
- Label the task's "kind" for the track record: code-multifile, code-small, browser, chat, translate or other.
- If unsure, lower confidence instead of guessing.
- Reply with exactly one JSON object and nothing else, of this shape:
${DECISION_SHAPE}${contextSection(x.context ?? EMPTY_CONTEXT)}${memorySection(x.memory)}${recordSection(x.record)}${extensionsSection(x.extensions)}`;
}

export function memorySection(memory: LoadedContext | undefined): string {
  if (!memory?.text.trim()) return "";
  return `

Learned facts (appended automatically after earlier tasks; the user may edit them):
${memory.text.trim()}`;
}

export function recordSection(record: string | undefined): string {
  if (!record?.trim()) return "";
  return `

Track record, last 30 days, by task kind (runs, successes, average time and tokens; "user handed off" means the
user took that kind of task away from that target):
${record.trim()}
Prefer targets that succeed at this kind of task. If you pick a target the user handed this kind of task off from,
say why in "reason". A target with three consecutive refusals/failures on a kind is moved behind your fallbacks by the daemon.`;
}

export function extensionsSection(ext: ExtensionsSummary | undefined): string {
  if (!ext || (!ext.mcp.length && !ext.skills.length)) return "";
  const mcp = ext.mcp.map((m) => `- mcp ${m.name}${m.note ? `: ${m.note}` : ""} (${m.harnesses.join(", ")})`);
  const skills = ext.skills.map((s) => `- skill ${s.name}${s.description ? `: ${s.description}` : ""} (${s.harnesses.join(", ")})`);
  return `

Extensions the executors have (MCP servers and skills, with the harnesses that get them). Mention a relevant one in
the brief by name; the executor loads its details itself:
${[...mcp, ...skills].join("\n")}`;
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

Decide again from the history above: a different harness or model, a repair tool, or give_up with the reason.
For transport failures (proxy, TLS, network, crash, silent timeout) the environment may be broken for every harness;
prefer a path that does not share the broken piece. Put what the next executor must know in handoff_note.`;
}
