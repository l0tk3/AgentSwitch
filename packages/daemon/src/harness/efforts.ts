/** How hard an agent thinks (docs/terminal-v0.md §1 思考强度, 2026-10-07; user: 新建终端和当前的模型选择页面都没有思考强度的选择，
 *  能不能根据各个 agent 客户端和模型适配一下). Each agent has its own word and its own levels:
 *
 *  - Claude Code: effort — `low … max`, the levels differ by model (`supportedModels()` says which); `--effort <level>`
 *    for one session, `/effort <level>` in a running one.
 *  - Codex: reasoning effort — per model (`model/list`: `supportedReasoningEfforts`, `defaultReasoningEffort`);
 *    `-c model_reasoning_effort="<level>"`. In a running session it is chosen in `/model`'s picker.
 *  - OpenCode: a model's variants (DeepSeek V4.1 Flash: none, low, high, max), part of the model's name:
 *    `-m provider/model#variant`. In a running session `/variants`.
 *  - pi: thinking — one list for every model (its `--help`), `--thinking <level>`; it uses what the model can.
 *
 *  A level is never passed on unless the agent (or its own help) lists it: an unknown one would fail the launch. */

/** The four agents a terminal runs (the terminals' own list, which this layer does not reach up to). */
type TerminalHarness = "claude-code" | "codex" | "opencode" | "pi";

/** A level's name as the agents write them: a short lowercase word. */
export const EFFORT = /^[a-z][a-z0-9_-]{0,23}$/;

/** pi's `--thinking` levels (pi 1.0.4 `--help`). */
export const PI_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Claude Code's levels, lowest first (the Agent SDK's `EffortLevel`): what any model of its may take. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Codex's reasoning efforts, lowest first, for a model whose own list is not known. */
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** Lowest first, whatever order an agent lists them in; a level this does not know keeps its place after the known. */
const ORDER = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
export function ordered(levels: readonly string[]): string[] {
  const rank = (l: string) => { const i = ORDER.indexOf(l); return i < 0 ? ORDER.length : i; };
  return [...new Set(levels.filter((l) => EFFORT.test(l)))].sort((a, b) => rank(a) - rank(b));
}

/** What the agents offer today: per model, and for the agent's own default model (no model chosen). */
export type EffortOffers = {
  /** `<agent>` → the levels when no model is chosen; absent: none can be chosen without a model. */
  readonly any: Readonly<Partial<Record<TerminalHarness, readonly string[]>>>;
  /** `<agent>` → `<model id>` → its levels. A model listed with none takes no level. */
  readonly models: Readonly<Partial<Record<TerminalHarness, Readonly<Record<string, readonly string[]>>>>>;
};

/** The levels a new terminal may be started with, for this agent and model (none chosen: the agent's default model).
 *  Null: nothing can be chosen (the model takes no level, or OpenCode without a model, whose variants belong to one). */
export function effortsFor(offers: EffortOffers, harness: TerminalHarness, model: string | undefined): readonly string[] | null {
  const listed = model ? offers.models[harness]?.[model] : offers.any[harness];
  if (listed) return listed.length ? listed : null;
  // Not listed (the agent's list was not read, or a model typed by hand): the agent's own vocabulary, which it clamps to
  // what the model takes. OpenCode fails a turn whose variant the model lacks, so an unlisted one is never sent.
  if (harness === "claude-code") return CLAUDE_EFFORTS;
  if (harness === "codex") return CODEX_EFFORTS;
  if (harness === "pi") return PI_THINKING;
  return null;
}

/** The agent's arguments for a level, and the model argument's value (OpenCode writes the variant into it). */
export function effortArgs(harness: TerminalHarness, effort: string | undefined, model: string | undefined): { args: string[]; model: string | undefined } {
  if (!effort || !EFFORT.test(effort)) return { args: [], model };
  switch (harness) {
    case "claude-code": return { args: ["--effort", effort], model };
    case "codex": return { args: ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`], model };
    case "opencode": return { args: [], model: model ? `${model}#${effort}` : model };
    case "pi": return { args: ["--thinking", effort], model };
  }
}

type Json = Record<string, unknown>;

/** OpenCode's models with their variants, as its server lists them for a folder (`GET /api/model`): `provider/id` →
 *  the variants' ids. Empty when the server has not loaded its models yet. */
export async function openCodeVariants(call: (method: string, path: string) => Promise<unknown>, directory: string): Promise<Record<string, string[]>> {
  const answer = (await call("GET", `/api/model?directory=${encodeURIComponent(directory)}`)) as Json;
  const listed = Array.isArray(answer.data) ? (answer.data as Json[]) : [];
  const out: Record<string, string[]> = {};
  for (const m of listed) {
    if (typeof m.providerID !== "string" || typeof m.id !== "string") continue;
    const variants = Array.isArray(m.variants) ? (m.variants as Json[]).map((v) => String(v.id ?? "")).filter((v) => EFFORT.test(v)) : [];
    out[`${m.providerID}/${m.id}`] = ordered(variants);
  }
  return out;
}
