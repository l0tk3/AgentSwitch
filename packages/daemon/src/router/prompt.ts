/** The router agent's instructions and the per-task message. Kept as plain text so it can be diffed. */

import { contextSection, EMPTY_CONTEXT, type LoadedContext } from "./context.js";
import type { Targets } from "./targets.js";
import { catalogText } from "./targets.js";
import type { ThreadBrief } from "../threads/types.js";

/** What the router is told about the world besides the catalog: user context, learned memory, track record, extensions. */
export type PromptExtras = {
  readonly context?: LoadedContext;
  readonly memory?: LoadedContext;
  /** Pre-rendered `recordText()` over the last 30 days. */
  readonly record?: string;
  readonly extensions?: ExtensionsSummary;
  /** Open threads the task might continue. */
  readonly threads?: readonly ThreadBrief[];
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
  "thread": "<id of the open thread this continues, or \"new\">",
  "thread_confidence": <0..1>,
  "expected_size": "small" | "medium" | "large",
  "plan": "single" | "multi",   // multi = something must be found out first, or several dependent steps
  "purpose": "research" | "do" | "verify",   // research/verify = look only, change nothing, submit nothing
  "risk": "<what could go wrong, or null>",
  "fallbacks": [{"harness": "...", "model": "..."}],
  "reason": "<one sentence>",
  "confidence": <0..1>,
  "action": "redispatch" | "repair" | "give_up" | "clarify",   // redispatch by default; clarify = ask the user first
  "question": "<with action=clarify: the one question the user must answer>" | null,
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
  Credentials arrive as enc:v1: tokens and never as plaintext; never ask the executor to find a password. Tokens in
  the user's message reach the executor verbatim with a list saying what each one is: in the brief, refer to them by
  that description ("the Google app password from the user's message") instead of copying them.
- If the task belongs to a category listed under the catalog, set "category" to its name and choose harness,
  model and every fallback only from that category's targets; the others refuse such tasks outright.
- The brief must contain: goal, acceptance criteria, paths not to touch, expected size. Do not invent requirements.
- You may read files under the working directory to judge size and language. Do not modify anything.
- Label the task's "kind" for the track record: code-multifile, code-small, browser, chat, translate or other.
- If the task cannot be done without something only the user can supply (a credential or site missing from the
  context, a URL, which of two readings they mean), reply with action "clarify" and one precise question instead of
  dispatching. Do not clarify for things an executor can find out by itself.
- "plan": "multi" when the task cannot be done well in one go: something must be looked up first (what a form
  requires, what a site offers), or later steps depend on earlier results. The daemon then runs it step by step with
  a planner. "single" for anything one executor can finish by itself.
- If unsure about the target, lower confidence instead of guessing.
- Reply with exactly one JSON object and nothing else, of this shape:
${DECISION_SHAPE}${contextSection(x.context ?? EMPTY_CONTEXT)}${memorySection(x.memory)}${recordSection(x.record)}${extensionsSection(x.extensions)}${threadsSection(x.threads)}`;
}

export function threadsSection(threads: readonly ThreadBrief[] | undefined): string {
  if (!threads?.length) return "";
  const lines = threads.map((t) => {
    const age = t.lastActivity ? `${Math.max(1, Math.round((Date.now() - t.lastActivity) / 60_000))} min ago` : "no activity";
    const last = t.lastTarget ? `${t.lastTarget.harness}/${t.lastTarget.model}` : "nobody yet";
    return `- ${t.id} "${t.title ?? "(untitled)"}" cwd ${t.cwd}; last: ${last}, ${age}${t.goal ? `; goal: ${t.goal.slice(0, 200)}` : ""}${t.progress ? `; progress: ${t.progress.slice(0, 200)}` : ""}`;
  });
  return `

Open threads (ongoing jobs). If the task continues one of them, set "thread" to its id and say how sure you are in
"thread_confidence"; otherwise "thread": "new". When it continues a thread, prefer that thread's last target so the
conversation can be resumed natively, unless its quota is gone or the model is clearly wrong for the task:
${lines.join("\n")}`;
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

/** loop-v0: one step of a running task: what happened, and what the model may reply. */
export type StepRecord =
  | { readonly kind: "dispatch"; readonly purpose: "research" | "do" | "verify"; readonly harness: string; readonly model: string; readonly brief: string; readonly ok: boolean;
      readonly failureKind: string | null; readonly reply: string; readonly sideEffects: string; readonly outFiles: readonly string[]; readonly diff: string }
  | { readonly kind: "ask_user"; readonly question: string; readonly answer: string | null }
  | { readonly kind: "note"; readonly text: string };

const REPLY_EXCERPT = 3000;
const BRIEF_EXCERPT = 300;

function stepLine(s: StepRecord, i: number): string {
  if (s.kind === "note") return `${i + 1}. ${s.text}`;
  if (s.kind === "ask_user") return `${i + 1}. ask_user: "${s.question}" → ${s.answer === null ? "no answer" : JSON.stringify(s.answer)}`;
  const head = `${i + 1}. dispatch [${s.purpose}] ${s.harness}/${s.model} — brief: ${JSON.stringify(s.brief.slice(0, BRIEF_EXCERPT))}`;
  const outcome = s.ok ? `   → done. Reply: ${s.reply.slice(0, REPLY_EXCERPT) || "(empty)"}` : `   → failed (${s.failureKind ?? "unknown"}): ${JSON.stringify(s.reply.slice(0, 500))}`;
  return `${head}\n${outcome}\n   side effects: ${s.sideEffects}; out/: ${s.outFiles.length ? s.outFiles.join(", ") : "(none)"}; worktree: ${s.diff || "(clean)"}`;
}

export function stepLines(steps: readonly StepRecord[]): string[] { return steps.map(stepLine); }

/** The message for a next-step call: the task, every step so far, the budget. */
export function stepsMessage(task: string, cwd: string, steps: readonly StepRecord[], used: number, budget: number, previousError?: string): string {
  const retry = previousError ? `\n\nYour previous reply was rejected: ${previousError}. Reply with one valid JSON object only.` : "";
  const lines = steps.length ? steps.map(stepLine).join("\n") : "(none yet)";
  return `Working directory: ${cwd}\n\nTask:\n${task}\n\nSteps so far:\n${lines}\nDispatches used: ${used} of ${budget}.\n\nDecide the next action.${retry}`;
}

/** Appended to the dispatcher's system prompt for next-step calls. */
export function loopSection(exclude: readonly { harness: string; model: string }[], repairs: readonly RepairTool[] = []): string {
  const tools = repairs.length ? repairs.map((r) => `- ${r.name}: ${r.description}`).join("\n") : "(none registered; action=repair is not available)";
  return `

You are running this task step by step: after each step you see its outcome and choose the next action. Reply with one
JSON object, one of:
- a dispatch: the decision shape above with "action": "dispatch" and "purpose": "research" (look only: change nothing,
  submit nothing), "do", or "verify" (check earlier work: change nothing). The executor sees earlier steps only through
  your brief and a short handoff, so put in the brief everything it needs from them (what a previous step found, what
  to do with it). Refer to the user's enc:v1: tokens by their field names, never copy them.
- {"action": "ask_user", "question": "<one precise question only the user can answer>"}
- {"action": "finish", "result": "<for the user: what was done and what was found; quote the executor where useful>"}
- {"action": "give_up", "reason": "<why this cannot be done>"}
- {"action": "repair", "repair": {"tool": "<a listed repair tool>", "args": {}}} — only with a listed tool.
Excluded (failed already; do not choose): ${exclude.map((e) => `${e.harness}/${e.model}`).join(", ") || "none"}
For transport failures (proxy, TLS, network, crash, silent timeout) the environment may be broken for every harness;
prefer a path that does not share the broken piece. A step that failed after side effects: say in the brief what is
already done so it is not redone.
Repair tools you may request with action="repair" (the daemon runs them, then asks you again):
${tools}`;
}
