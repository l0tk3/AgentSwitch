/** Codex executor over `codex app-server`: thread/start → turn/start → items → turn/completed.
 *  Approvals (item/…/requestApproval, execCommandApproval, applyPatchApproval) go to the
 *  engine; MCP elicitations are accepted. A private CODEX_HOME holds a 0600 copy of auth.json and
 *  our config (never the user's ~/.codex/config.toml), removed when the run ends. */

import type { ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Extensions, NO_EXTENSIONS } from "../extensions/index.js";
import { isImage } from "../files/names.js";
import { NO_ANSWER_MESSAGE, type UserAnswers, type UserQuestion } from "../core/questions.js";
import type { Attachment } from "../files/uploads.js";
import { detectRefusal, NO_AGENTS, NO_SIDE_EFFECTS, type AgentCounts, type ExecutionOutcome, type RefusalSignal } from "../core/outcome.js";
import { AppServerClient, type Json } from "../harness/appserver.js";
import { codexMcpToml } from "./extensions.js";
import { codexGateToml, gateRun, mcpServerEnv, reportTransfer, withoutCredentialRepair, type GateOptions, type GateRun } from "./gate.js";
import { stripProxy } from "../util/env.js";
import { composePrompt, executorInstructions } from "./instructions.js";
import { watchRunStop, type RunStop } from "./lifecycle.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../core/limits.js";
import { spawnOwned, terminateProcess } from "../harness/processes.js";
import type { CredentialRepair, ExecutionInput, Executor } from "./types.js";

export type CodexExecutorOptions = {
  readonly binary: string;
  readonly authPath?: string;
  readonly gate?: GateOptions | null;
  readonly browser?: boolean;
  readonly maxMs?: number;
  readonly extensions?: Pick<Extensions, "mcpFor" | "skillsInto">;
};

const USER_INPUT_METHOD = "item/tool/requestUserInput";
/** Excerpt sizes: approval evidence (file changes can be long), sub-agent lines, errors, and what an exit or a refused
 *  resume quotes. */
const APPROVAL_EVIDENCE_CHARS = 2000;
const AGENT_DESCRIPTION_CHARS = 120;
const AGENT_SUMMARY_CHARS = 200;
const ERROR_EXCERPT_CHARS = 500;
const STDERR_QUOTE_CHARS = 300;
const REPLY_QUOTE_CHARS = 200;
const RESUME_ERROR_CHARS = 120;
const APPROVAL_METHODS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "execCommandApproval", "applyPatchApproval"]);

export function codexConfigToml(gate: GateOptions | null | undefined, profile: string, browser: boolean, effort: string | null, mcpToml = "", repair?: CredentialRepair, run: GateRun = {}): string {
  const head = `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n${effort ? `model_reasoning_effort = ${JSON.stringify(effort)}\n` : ""}`;
  return head + (gate ? "\n" + codexGateToml(gate, profile, browser, repair, run) : "\n[sandbox_workspace_write]\nnetwork_access = true\n") + mcpToml;
}

/** Codex's request_user_input questions (app-server protocol, experimental) in the shared shape. */
export function codexQuestions(params: Json): UserQuestion[] {
  const raw = Array.isArray(params.questions) ? (params.questions as Json[]) : [];
  return raw.map((q, i) => ({
    id: String(q.id ?? `q${i + 1}`), header: String(q.header ?? ""), text: String(q.question ?? ""),
    options: (Array.isArray(q.options) ? (q.options as Json[]) : []).map((o) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })).filter((o) => o.label),
    multi: false, secret: Boolean(q.isSecret),
  })).filter((q) => q.text);
}

/** The response Codex expects: every question id → its answers; an unanswered card tells the model so. */
export function codexAnswers(questions: readonly UserQuestion[], answers: UserAnswers | null): Json {
  return { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: answers ? [...(answers[q.id] ?? [])] : [NO_ANSWER_MESSAGE] }])) };
}

/** Approval answer shape differs per method; decline wording mirrors the e2e script's accept wording. */
export function approvalAnswer(method: string, allow: boolean): Json {
  if (method === "mcpServer/elicitation/request") return { action: allow ? "accept" : "decline", content: {} };
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: allow ? "approved" : "denied" };
  return { decision: allow ? "accept" : "decline" };
}

export function describeApproval(method: string, params: Json): { action: string; evidence: string } {
  const item = (params.item as Json | undefined) ?? params;
  const command = item.command ?? params.command;
  const changes = item.changes ?? params.changes;
  if (command) return { action: `${method}: ${Array.isArray(command) ? command.join(" ") : String(command)}`, evidence: JSON.stringify({ cwd: item.cwd ?? params.cwd ?? null, reason: params.reason ?? null }) };
  if (changes) return { action: `${method}: file changes`, evidence: JSON.stringify(changes).slice(0, APPROVAL_EVIDENCE_CHARS) };
  return { action: method, evidence: JSON.stringify(params).slice(0, APPROVAL_EVIDENCE_CHARS) };
}

export type CodexAgentEvent = { readonly agentId: string; readonly status: "started" | "progress" | "completed" | "failed" | "stopped"; readonly description: string; readonly summary?: string };

export type TurnState = { text: string[]; finalText?: string; refusal?: RefusalSignal; tools: number; edits: number; approvals: number; completed: Json | null; errors: string[]; agents: AgentCounts; agentEvents: CodexAgentEvent[]; toolIds: readonly string[] };

export const EMPTY_TURN: TurnState = { text: [], tools: 0, edits: 0, approvals: 0, completed: null, errors: [], agents: NO_AGENTS, agentEvents: [], toolIds: [] };

/** Verified in codex-cli 0.142.3 `app-server generate-ts`: TurnError.codexErrorInfo.
 * Moderation metadata is untyped JsonValue, so no guessed fields are interpreted. */
function providerRefusal(error: unknown): RefusalSignal | null {
  if (!error || typeof error !== "object" || (error as Json).codexErrorInfo !== "cyberPolicy") return null;
  const message = (error as Json).message;
  return { source: "provider", reason: `Codex cyberPolicy${typeof message === "string" ? `: ${message}` : ""}` };
}

/** Sub-agents (background-v0 §2): `collabAgentToolCall` spawn/close items and `subAgentActivity` bookends, on item/started and item/completed. */
function foldAgentItem(state: TurnState, method: string, item: Json): TurnState | null {
  const type = String(item.type ?? "");
  if (type === "subAgentActivity") {
    const kind = String(item.kind ?? "");
    const ev: CodexAgentEvent = { agentId: String(item.agentThreadId ?? ""), description: String(item.agentPath ?? "sub-agent"), status: kind === "started" ? "started" : kind === "completed" ? "completed" : kind === "interrupted" ? "stopped" : "progress" };
    if ((kind === "started") !== (method === "item/started")) return state;   // started on item/started, the rest on item/completed: one event per activity
    const agents = kind === "started" ? { ...state.agents, spawned: state.agents.spawned + 1 } : kind === "completed" ? { ...state.agents, completed: state.agents.completed + 1 } : kind === "interrupted" ? { ...state.agents, failed: state.agents.failed + 1 } : state.agents;
    return { ...state, agents, agentEvents: [...state.agentEvents, ev] };
  }
  if (type === "collabAgentToolCall") {
    const tool = String(item.tool ?? "");
    const status = String(item.status ?? "");
    const ids = Array.isArray(item.receiverThreadIds) ? (item.receiverThreadIds as unknown[]).map(String) : [];
    if (method === "item/completed" && status === "failed") {
      return { ...state, agents: { ...state.agents, failed: state.agents.failed + 1 }, agentEvents: [...state.agentEvents, { agentId: ids[0] ?? "", status: "failed", description: `${tool}: ${String(item.prompt ?? "").slice(0, AGENT_DESCRIPTION_CHARS)}` }] };
    }
    if (method === "item/completed" && (tool === "wait" || tool === "closeAgent") && status === "completed") {
      return { ...state, agents: { ...state.agents, completed: state.agents.completed + Math.max(1, ids.length) }, agentEvents: [...state.agentEvents, ...(ids.length ? ids : [""]).map((id) => ({ agentId: id, status: "completed" as const, description: tool }))] };
    }
    if (method === "item/completed") return { ...state, agentEvents: [...state.agentEvents, { agentId: ids[0] ?? "", status: "progress", description: `${tool} ${status}`, ...(item.prompt ? { summary: String(item.prompt).slice(0, AGENT_SUMMARY_CHARS) } : {}) }] };
    return state;
  }
  return null;
}

export function applyNotification(state: TurnState, method: string, params: Json): TurnState {
  if (method === "item/started" || method === "item/completed") {
    const item = (params.item as Json) ?? {};
    const type = String(item.type ?? "");
    // Count an operation when it starts: a broken stream may never deliver completion.
    // Unknown tool kinds (including browser/dynamic MCP tools) are conservatively operations.
    const passive = new Set(["agentMessage", "userMessage", "reasoning", "plan", "contextCompaction", "enteredReviewMode", "exitedReviewMode", "subAgentActivity"]);
    const id = typeof item.id === "string" && item.id ? item.id : null;
    if (!passive.has(type) && (!id || !state.toolIds.includes(id))) state = {
      ...state, tools: state.tools + 1, edits: state.edits + (type === "fileChange" ? 1 : 0),
      toolIds: id ? [...state.toolIds, id] : state.toolIds,
    };
    const agent = foldAgentItem(state, method, item);
    if (agent) return agent;
  }
  if (method === "item/completed") {
    const item = (params.item as Json) ?? {};
    const type = String(item.type ?? "");
    if (type === "agentMessage") return { ...state, text: [...state.text, String(item.text ?? "")], ...(item.phase === "final_answer" ? { finalText: String(item.text ?? "") } : {}) };
    return state;
  }
  if (method === "turn/completed") return { ...state, completed: params };
  if (method === "error" || method === "turn/error") {
    const refusal = providerRefusal(params.error);
    return { ...state, errors: [...state.errors, JSON.stringify(params).slice(0, ERROR_EXCERPT_CHARS)], ...(refusal ? { refusal } : {}) };
  }
  return state;
}

export function outcomeFromTurn(state: TurnState, extraError: string | null): ExecutionOutcome {
  const text = (state.finalText ?? state.text.at(-1) ?? "").trimEnd();
  const errors = [...state.errors, ...(extraError ? [extraError] : [])];
  const turnError = (state.completed?.turn as Json | undefined)?.error ?? state.completed?.error;
  if (turnError) errors.push(JSON.stringify(turnError).slice(0, ERROR_EXCERPT_CHARS));
  const refusal = state.refusal ?? providerRefusal(turnError) ?? detectRefusal({ ok: true, lastText: text });
  const ok = !refusal && errors.length === 0 && state.completed !== null;
  return {
    ok, exitCode: ok ? 0 : 1, stderr: errors.join("\n"), lastText: text || (ok ? "(no message)" : ""),
    sideEffects: { ...NO_SIDE_EFFECTS, filesChanged: state.edits, commandsRun: Math.max(state.tools - state.edits, state.agents.spawned), approvalsGranted: state.approvals },
    sideEffectsKnown: state.completed !== null && extraError === null,
    agents: state.agents, ...(refusal ? { refusal } : {}),
  };
}

/** CODEX_HOME for this run: the thread's private <home>/codex when there is a thread (kept across runs so
 *  `thread/resume` finds the rollout + thread_history sqlite), else a temp dir removed afterwards. auth.json is
 *  re-copied and config/AGENTS.md/skills regenerated on every run. */
function prepareHome(opts: CodexExecutorOptions, effort: string | null, browser: boolean, threadHome: string | null, repair?: CredentialRepair, run: GateRun = {}, slotProfile?: string): { home: string; profile: string; persistent: boolean; tempProfile: string | null } {
  const persistent = threadHome !== null;
  const home = persistent ? join(threadHome, "codex") : mkdtempSync(join(tmpdir(), "agentswitch-codex-"));
  // Kept logins live only in the three session slots (browserSlots.ts): a thread's own profile from before is removed,
  // and without a slot a persistent home gets a throw-away profile outside it.
  if (persistent) rmSync(join(home, "chromium-profile"), { recursive: true, force: true });
  const tempProfile = !slotProfile && persistent && browser ? mkdtempSync(join(tmpdir(), "agentswitch-codex-profile-")) : null;
  const profile = slotProfile ?? tempProfile ?? join(home, "chromium-profile");
  try {
    fillHome(home, opts, effort, browser, repair, run, profile);
    return { home, profile, persistent, tempProfile };
  } catch (err) {
    if (!persistent) rmSync(home, { recursive: true, force: true });   // a failed setup leaves no temp home behind
    if (tempProfile) rmSync(tempProfile, { recursive: true, force: true });
    throw err;
  }
}

/** auth.json, config.toml (browser profile `profile`), AGENTS.md and skills into `home`. */
function fillHome(home: string, opts: CodexExecutorOptions, effort: string | null, browser: boolean, repair: CredentialRepair | undefined, run: GateRun, profile: string): void {
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o700);
  const auth = opts.authPath ?? join(process.env.HOME ?? "", ".codex", "auth.json");
  if (!existsSync(auth)) throw new Error(`${auth} not found; run codex login`);
  copyFileSync(auth, join(home, "auth.json"));
  chmodSync(join(home, "auth.json"), 0o600);
  const ext = opts.extensions ?? NO_EXTENSIONS;
  const mcpToml = codexMcpToml(ext.mcpFor("codex"), mcpServerEnv(opts.gate));
  writeFileSync(join(home, "config.toml"), codexConfigToml(opts.gate, profile, browser, effort, mcpToml, repair, run), { mode: 0o600 });
  writeFileSync(join(home, "AGENTS.md"), executorInstructions());   // Codex's global instructions live in $CODEX_HOME/AGENTS.md
  ext.skillsInto("codex", join(home, "skills"));                     // Codex discovers $CODEX_HOME/skills/*/SKILL.md
}

export function codexExecutor(opts: CodexExecutorOptions): Executor {
  return {
    harness: "codex",
    async run(input: ExecutionInput): Promise<ExecutionOutcome> {
      const browser = (opts.browser ?? true) && input.browser;
      const run = gateRun(input, browser);
      const { home, persistent, tempProfile } = prepareHome(opts, input.effort, browser, input.threadHome, input.credentialRepair, run, input.browserProfile);
      reportTransfer(input, run, "codex", !!opts.gate, browser);
      const env = { ...stripProxy(withoutCredentialRepair(process.env)), CODEX_HOME: home, GIT_EDITOR: "true" };
      let child: ChildProcess | null = null;
      let state: TurnState = EMPTY_TURN;
      let watch: RunStop | null = null;
      const timedOut = () => watch?.timedOut === true;
      let notifyDone: (() => void) | null = null;
      const completed = new Promise<void>((r) => (notifyDone = r));
      try {
        child = spawnOwned(opts.binary, ["app-server"], { cwd: input.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
        const client = new AppServerClient(child.stdin!, child.stdout!, async (method, params) => {
          if (input.signal.aborted) return approvalAnswer(method, false);
          if (method === "mcpServer/elicitation/request") return approvalAnswer(method, true);
          if (method === USER_INPUT_METHOD) { const qs = codexQuestions(params); return codexAnswers(qs, qs.length ? await input.ask(qs) : null); }
          if (!APPROVAL_METHODS.has(method)) return { decision: "decline" };
          const { action, evidence } = describeApproval(method, params);
          const decision = await input.approve(action, evidence);
          if (decision === "allow") state = { ...state, approvals: state.approvals + 1 };
          return approvalAnswer(method, decision === "allow" && !input.signal.aborted);
        }, (method, params) => {
          const before = state;
          state = applyNotification(state, method, params);
          if (state.text.length > before.text.length) input.emit("text", { text: state.text.at(-1) });
          if (state.tools > before.tools) { const item = (params.item as Json) ?? {}; input.emit("tool_call", { tool: String(item.type ?? method), command: item.command ?? null }); }
          for (const a of state.agentEvents.slice(before.agentEvents.length)) input.emit("agent", { harness: "codex", ...a });
          if (state.completed) notifyDone?.();
        });
        child.on("close", () => { client.fail(new Error("app-server exited")); notifyDone?.(); });
        child.on("error", (e) => { stderr += e.message; client.fail(e); notifyDone?.(); });   // e.g. the binary is missing: a transport failure, not a crash
        const stop = () => { if (child) terminateProcess(child); client.fail(new Error("execution stopped")); notifyDone?.(); };
        watch = watchRunStop(input.signal, opts.maxMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS, (cause) => {
          if (cause === "timeout") state = { ...state, errors: [...state.errors, "timed out"] };
          stop();
        });
        await client.request("initialize", { clientInfo: { name: "agentswitch", version: "0.1.0" } });
        client.notify("initialized");
        const threadId = await openThread(client, input, persistent, () => state.tools === 0 && state.approvals === 0 && state.agents.spawned === 0 && state.text.length === 0 && state.errors.length === 0 && !timedOut());
        const prompt = composePrompt({ ...input, transfer: opts.gate ? run.transfer ?? null : null });
        await client.request("turn/start", { threadId, input: codexInput(prompt, input.attachments, input.cwd) });
        await completed;
        return { ...outcomeFromTurn(state, timedOut() ? "timed out" : input.signal.aborted ? "cancelled" : (child.exitCode !== null && !state.completed ? `app-server exited ${child.exitCode}: ${stderr.slice(0, STDERR_QUOTE_CHARS)}` : null)), timedOut: timedOut(), sessionId: threadId };
      } catch (err) {
        return { ...outcomeFromTurn(state, (err as Error).message), timedOut: timedOut() };
      } finally {
        watch?.dispose();
        if (child) await terminateProcess(child);
        if (!persistent) rmSync(home, { recursive: true, force: true });
        if (tempProfile) rmSync(tempProfile, { recursive: true, force: true });
      }
    },
  };
}

/** Resume the thread's Codex conversation when we have one (verified: `thread/resume {threadId}` reloads the
 *  rollout from CODEX_HOME); fall back to a fresh thread if the resume is refused. Persistent homes start
 *  non-ephemeral threads so the rollout is written at all. */
async function openThread(client: AppServerClient, input: ExecutionInput, persistent: boolean, noOperations: () => boolean): Promise<string> {
  const base = { cwd: input.cwd, sandbox: "workspace-write", approvalPolicy: "on-request", model: input.model };
  if (input.resume) {
    try {
      const resumed = await client.request("thread/resume", { threadId: input.resume, ...base });
      const id = (resumed.thread as Json | undefined)?.id;
      if (typeof id === "string") { input.emit("text", { text: `(resumed Codex thread ${id})` }); return id; }
      throw new Error("thread/resume returned no thread id");
    } catch (err) {
      if (input.signal.aborted || !noOperations() || !/(?:thread|session)[^\n]*(?:not found|does not exist|unknown|invalid|expired)/i.test((err as Error).message)) throw err;
      input.emit("text", { text: `(could not resume Codex thread ${input.resume}: ${(err as Error).message.slice(0, RESUME_ERROR_CHARS)}; starting a new one)` });
    }
  }
  const started = await client.request("thread/start", { ...base, ephemeral: !persistent });
  const id = (started.thread as Json | undefined)?.id;
  if (typeof id !== "string" || !id) throw new Error(`thread/start returned no thread id: ${JSON.stringify(started).slice(0, REPLY_QUOTE_CHARS)}`);
  return id;
}

/** Text plus each image attachment as a local image item, so Codex sees screenshots without a Read tool. */
export function codexInput(text: string, attachments: readonly Attachment[], cwd: string): Json[] {
  const images = attachments.filter((a) => isImage(a.name)).map((a) => ({ type: "localImage", path: join(cwd, a.path) }));
  return [{ type: "text", text }, ...images];
}
