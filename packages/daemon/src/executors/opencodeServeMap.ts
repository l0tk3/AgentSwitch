/** Pure mapping between AgentSwitch's shapes and the OpenCode v2 server API (checked against 2.0.8's /openapi.json and
 *  real sessions): permission rules, runtime MCP configs, a turn's messages, approval cards, question forms, and the
 *  shell environment of one execution. */

import { NO_ANSWER_MESSAGE, type UserAnswers, type UserQuestion } from "../core/questions.js";
import { gateEnv, withoutCredentialRepair, type GateOptions } from "./gate.js";
import { stripProxy } from "../util/env.js";
import type { RunSummary } from "./opencodeShared.js";
import { APPROVAL_EVIDENCE_CHARS } from "../core/limits.js";

type Json = Record<string, unknown>;

export type PermissionEffect = "allow" | "deny" | "ask";
export type PermissionRule = { readonly action: string; readonly resource: string; readonly effect: PermissionEffect };

const EFFECTS = new Set<string>(["allow", "deny", "ask"]);

/** A config-file `permission` section as a session ruleset, translated the way OpenCode translates its own config
 *  (seen in GET /api/config): order kept, `bash` becomes `shell`, a bare effect covers `*`. Evaluation is agent rules,
 *  then config rules, then session rules, the last match winning. */
export function toRuleset(permission: Record<string, unknown>): PermissionRule[] {
  const out: PermissionRule[] = [];
  const push = (action: string, resource: string, effect: unknown) => { if (typeof effect === "string" && EFFECTS.has(effect)) out.push({ action, resource, effect: effect as PermissionEffect }); };
  for (const [tool, value] of Object.entries(permission)) {
    const action = tool === "bash" ? "shell" : tool;
    if (typeof value === "string") push(action, "*", value);
    else if (value && typeof value === "object") for (const [resource, effect] of Object.entries(value)) push(action, resource, effect);
  }
  return out;
}

/** `provider/model[/variant…]` as the API's model reference. */
export function modelRef(model: string): { providerID: string; id: string } {
  const [providerID, ...rest] = model.split("/");
  return { providerID: providerID ?? model, id: rest.join("/") || model };
}

/** Config-file MCP entries (`opencodeGateConfig`, `opencodeMcpFromRegistry`) in the runtime API's shape: `enabled` is
 *  not part of it, and a disabled entry is not added at all. */
export function runtimeMcp(entries: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [name, raw] of Object.entries(entries)) {
    const e = raw as Json;
    if (!e || e.enabled === false) continue;
    if (e.type === "local") out[name] = { type: "local", command: e.command, ...(e.environment ? { environment: e.environment } : {}) };
    else if (e.type === "remote") out[name] = { type: "remote", url: e.url, ...(e.headers ? { headers: e.headers } : {}) };
  }
  return out;
}

/** The shell tool's environment for one execution: what `opencode run` handed its shell (the daemon's env without proxy
 *  variables or the repair capability), the gate proxy carrying this execution's scope, PWD and a no-op editor. It
 *  replaces the session's whole shell env (PUT …/environment), so nothing of the server process is inherited. */
export function shellEnv(gate: GateOptions | null, scope: string | null, cwd: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const { OPENCODE_SERVER_PASSWORD: _a, OPENCODE_PASSWORD: _b, OPENCODE_CONFIG: _c, ...base } = stripProxy(withoutCredentialRepair(env));
  return { ...base, ...(gate ? gateEnv(gate, scope) : {}), PWD: cwd, GIT_EDITOR: "true" };
}

export type TurnItem =
  | { readonly key: string; readonly kind: "text"; readonly text: string }
  | { readonly key: string; readonly kind: "tool"; readonly tool: string; readonly input: unknown; readonly error: string | null; readonly output?: unknown };

export type Turn = {
  readonly summary: RunSummary;
  /** Finished pieces in order, keyed so each is emitted once. */
  readonly items: readonly TurnItem[];
  readonly idle: "succeeded" | "failed" | "interrupted" | null;
  readonly httpStatus: number | null;
  readonly tokens: number;
};

const KNOWN_MESSAGES = new Set(["user", "assistant", "idle", "synthetic", "system", "skill", "shell", "compaction", "agent-switched", "model-switched", "location-switched"]);
const KNOWN_PARTS = new Set(["text", "reasoning", "tool"]);

export const createdAt = (m: Json): number => Number((m.time as Json | undefined)?.created ?? 0);

/** An assistant message is final once completed; every other message is final when it appears. */
export const isFinal = (m: Json): boolean => m.type !== "assistant" || (m.time as Json | undefined)?.completed !== undefined;

/** One turn of the root session (messages created at or after `since`, any order) as the standalone path's RunSummary.
 *  A tool counts once it runs. Items keep the model's order: a text part is finished once its message completed or a
 *  later part exists, a tool once it completed or failed, and a message's items stop at its first unfinished part
 *  (with `final`, everything finished or not-a-tool is an item). Unknown message or part types make the telemetry
 *  incomplete. */
export function foldTurn(messages: readonly Json[], since: number, sessionId: string, final = false, settled: ReadonlySet<string> = new Set()): Turn {
  const ordered = messages.filter((m) => createdAt(m) >= since).sort((a, b) => createdAt(a) - createdAt(b) || String(a.id).localeCompare(String(b.id)));
  const summary: RunSummary = { text: "", tools: [], errors: [], sessionId, telemetryComplete: true };
  const items: TurnItem[] = [];
  let idle: Turn["idle"] = null;
  let httpStatus: number | null = null;
  let tokens = 0;
  for (const m of ordered) {
    const type = String(m.type ?? "");
    if (!KNOWN_MESSAGES.has(type)) { summary.telemetryComplete = false; continue; }
    if (type === "idle") { const o = String(m.outcome ?? ""); idle = o === "succeeded" || o === "failed" || o === "interrupted" ? o : "failed"; continue; }
    if (type !== "assistant") continue;
    const done = isFinal(m);
    const usage = m.tokens as { input?: number; output?: number } | undefined;
    tokens += (Number(usage?.input) || 0) + (Number(usage?.output) || 0);
    const error = m.error as { type?: string; message?: string; status?: number } | undefined;
    if (error && !settled.has(String(m.id))) { summary.errors.push(`${error.type ?? "error"}: ${error.message ?? ""}`.trim()); if (typeof error.status === "number") httpStatus = error.status; }
    const parts = Array.isArray(m.content) ? (m.content as Json[]) : [];
    let open = false;   // an earlier part of this message is unfinished: later items wait for it
    parts.forEach((p, i) => {
      const key = `${String(m.id)}:${i}`;
      if (!KNOWN_PARTS.has(String(p.type))) { summary.telemetryComplete = false; return; }
      if (p.type === "text") {
        const text = String(p.text ?? "");
        summary.text += text;
        if (done || final || i < parts.length - 1) { if (!open) items.push({ key, kind: "text", text }); }
        else open = true;
      } else if (p.type === "tool") {
        const state = (p.state as Json | undefined) ?? {};
        const status = String(state.status ?? "");
        const finished = status === "completed" || status === "error";
        if (!finished && !final) open = true;
        if (status === "streaming" || !status) return;   // arguments still arriving: nothing ran
        const tool = String(p.name ?? "?");
        summary.tools.push({ tool, input: state.input ?? null });
        if (finished && !open) {
          const err = state.error as { message?: string } | undefined;
          items.push({ key: `${String(m.id)}:${String(p.id ?? i)}`, kind: "tool", tool, input: state.input ?? null, error: status === "error" ? String(err?.message ?? "tool error") : null, ...(state.output !== undefined ? { output: state.output } : {}) });
        }
      }
    });
  }
  return { summary, items, idle, httpStatus, tokens };
}

/** The prompt that lets a session go on after OpenCode stopped it on declined actions (2.0.8 cannot carry a reason
 *  with a reject): what was refused, that it stays refused, and to finish with what is allowed. */
export function declinedPrompt(refused: readonly string[]): string {
  return `AgentSwitch refused ${refused.length === 1 ? "this action" : "these actions"}, and OpenCode stopped your last step:
${refused.map((a) => `- ${a}`).join("\n")}
They are off limits for this task: do not retry them or reach the same data another way. Continue the task with what you are allowed to do. If it cannot be finished without them, give your answer now and say what was refused.`;
}

export type PermissionRequest = { readonly id: string; readonly sessionID: string; readonly action: string; readonly resources?: readonly string[]; readonly metadata?: Json };

/** The approval card for a rule that says "ask": shell reads like Claude's `Bash: …` and access outside the working
 *  directory says "outside cwd", so the engine's approval categories (approvalPolicy.ts) apply to OpenCode too. */
export function approvalFor(req: PermissionRequest): { action: string; evidence: string } {
  const what = (req.resources ?? []).join(" ; ");
  const action = req.action === "shell" || req.action === "bash" ? `Bash: ${what}`
    : req.action === "external_directory" ? `OpenCode access outside cwd: ${what}`
    : `OpenCode ${req.action}: ${what}`;
  return { action, evidence: JSON.stringify({ action: req.action, resources: req.resources ?? [], metadata: req.metadata ?? {} }).slice(0, APPROVAL_EVIDENCE_CHARS) };
}

type FormField = { key?: unknown; type?: unknown; title?: unknown; description?: unknown; custom?: unknown; options?: { value?: unknown; label?: unknown; description?: unknown }[] };

const fieldsOf = (form: Json): FormField[] => (Array.isArray(form.fields) ? (form.fields as FormField[]) : []);

/** The question tool's form (metadata.kind "question") as engine questions; null for any other form. */
export function formQuestions(form: Json): UserQuestion[] | null {
  if ((form.metadata as Json | undefined)?.kind !== "question") return null;
  const questions: UserQuestion[] = [];
  for (const f of fieldsOf(form)) {
    if (f.type !== "string" && f.type !== "multiselect") return null;
    const text = String(f.description ?? f.title ?? "");
    if (!f.key || !text) return null;
    questions.push({
      id: String(f.key), header: String(f.title ?? ""), text,
      options: (f.options ?? []).map((o) => ({ label: String(o.label ?? o.value ?? ""), description: String(o.description ?? "") })).filter((o) => o.label),
      multi: f.type === "multiselect", secret: false,
    });
  }
  return questions.length ? questions : null;
}

/** The form answer: chosen labels mapped back to option values, free text as given. Without answers, the refusal text
 *  the other harnesses get where a field takes free text; null (cancel the form) where it cannot. */
export function formAnswer(form: Json, answers: UserAnswers | null): Record<string, string | string[]> | null {
  const out: Record<string, string | string[]> = {};
  for (const f of fieldsOf(form)) {
    const key = String(f.key);
    const options = f.options ?? [];
    const multi = f.type === "multiselect";
    if (!answers) {
      if (options.length && f.custom === false) return null;
      out[key] = multi ? [NO_ANSWER_MESSAGE] : NO_ANSWER_MESSAGE;
      continue;
    }
    const given = (answers[key] ?? []).map((a) => String(options.find((o) => o.label === a || o.value === a)?.value ?? a));
    out[key] = multi ? given : given.join(", ");
  }
  return out;
}
