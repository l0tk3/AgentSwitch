/** Codex executor over `codex app-server`: thread/start → turn/start → items → turn/completed.
 *  Approvals (item/…/requestApproval, execCommandApproval, applyPatchApproval) go to the
 *  engine; MCP elicitations are accepted. A private CODEX_HOME holds a 0600 copy of auth.json and
 *  our config (never the user's ~/.codex/config.toml), removed when the run ends. */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Extensions, NO_EXTENSIONS } from "../extensions/index.js";
import { isImage } from "../files/names.js";
import type { Attachment } from "../files/uploads.js";
import { NO_AGENTS, NO_SIDE_EFFECTS, type AgentCounts, type ExecutionOutcome } from "../router/failure.js";
import { AppServerClient, type Json } from "./appserver.js";
import { codexMcpToml } from "./extensions.js";
import { codexGateToml, mcpServerEnv, stripProxy, type GateOptions } from "./gate.js";
import { composePrompt, executorInstructions } from "./instructions.js";
import type { ExecutionInput, Executor } from "./types.js";

export type CodexExecutorOptions = {
  readonly binary: string;
  readonly authPath?: string;
  readonly gate?: GateOptions | null;
  readonly browser?: boolean;
  readonly maxMs?: number;
  readonly extensions?: Pick<Extensions, "mcpFor" | "skillsInto">;
};

const APPROVAL_METHODS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "execCommandApproval", "applyPatchApproval"]);

export function codexConfigToml(gate: GateOptions | null | undefined, profile: string, browser: boolean, effort: string | null, mcpToml = ""): string {
  const head = `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n${effort ? `model_reasoning_effort = ${JSON.stringify(effort)}\n` : ""}`;
  return head + (gate ? "\n" + codexGateToml(gate, profile, browser) : "\n[sandbox_workspace_write]\nnetwork_access = true\n") + mcpToml;
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
  if (changes) return { action: `${method}: file changes`, evidence: JSON.stringify(changes).slice(0, 2000) };
  return { action: method, evidence: JSON.stringify(params).slice(0, 2000) };
}

export type CodexAgentEvent = { readonly agentId: string; readonly status: "started" | "progress" | "completed" | "failed" | "stopped"; readonly description: string; readonly summary?: string };

export type TurnState = { text: string[]; tools: number; edits: number; approvals: number; completed: Json | null; errors: string[]; agents: AgentCounts; agentEvents: CodexAgentEvent[] };

export const EMPTY_TURN: TurnState = { text: [], tools: 0, edits: 0, approvals: 0, completed: null, errors: [], agents: NO_AGENTS, agentEvents: [] };

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
      return { ...state, tools: state.tools + 1, agents: { ...state.agents, failed: state.agents.failed + 1 }, agentEvents: [...state.agentEvents, { agentId: ids[0] ?? "", status: "failed", description: `${tool}: ${String(item.prompt ?? "").slice(0, 120)}` }] };
    }
    if (method === "item/completed" && (tool === "wait" || tool === "closeAgent") && status === "completed") {
      return { ...state, tools: state.tools + 1, agents: { ...state.agents, completed: state.agents.completed + Math.max(1, ids.length) }, agentEvents: [...state.agentEvents, ...(ids.length ? ids : [""]).map((id) => ({ agentId: id, status: "completed" as const, description: tool }))] };
    }
    if (method === "item/completed") return { ...state, tools: state.tools + 1, agentEvents: [...state.agentEvents, { agentId: ids[0] ?? "", status: "progress", description: `${tool} ${status}`, ...(item.prompt ? { summary: String(item.prompt).slice(0, 200) } : {}) }] };
    return state;
  }
  return null;
}

export function applyNotification(state: TurnState, method: string, params: Json): TurnState {
  if (method === "item/started" || method === "item/completed") {
    const agent = foldAgentItem(state, method, (params.item as Json) ?? {});
    if (agent) return agent;
  }
  if (method === "item/completed") {
    const item = (params.item as Json) ?? {};
    const type = String(item.type ?? "");
    if (type === "agentMessage") return { ...state, text: [...state.text, String(item.text ?? "")] };
    if (type === "commandExecution") return { ...state, tools: state.tools + 1 };
    if (type === "fileChange") return { ...state, edits: state.edits + 1, tools: state.tools + 1 };
    if (type === "mcpToolCall") return { ...state, tools: state.tools + 1 };
    return state;
  }
  if (method === "turn/completed") return { ...state, completed: params };
  if (method === "error" || method === "turn/error") return { ...state, errors: [...state.errors, JSON.stringify(params).slice(0, 500)] };
  return state;
}

export function outcomeFromTurn(state: TurnState, extraError: string | null): ExecutionOutcome {
  const text = state.text.join("\n").trim();
  const errors = [...state.errors, ...(extraError ? [extraError] : [])];
  const turnError = (state.completed?.turn as Json | undefined)?.error ?? state.completed?.error;
  if (turnError) errors.push(JSON.stringify(turnError).slice(0, 500));
  const ok = errors.length === 0 && state.completed !== null;
  return {
    ok, exitCode: ok ? 0 : 1, stderr: errors.join("\n"), lastText: text || (ok ? "(no message)" : ""),
    sideEffects: { ...NO_SIDE_EFFECTS, filesChanged: state.edits, commandsRun: state.tools - state.edits, approvalsGranted: state.approvals },
    agents: state.agents,
  };
}

/** CODEX_HOME for this run: the thread's private <home>/codex when there is a thread (kept across runs so
 *  `thread/resume` finds the rollout + thread_history sqlite), else a temp dir removed afterwards. auth.json is
 *  re-copied and config/AGENTS.md/skills regenerated on every run. */
function prepareHome(opts: CodexExecutorOptions, effort: string | null, browser: boolean, threadHome: string | null): { home: string; profile: string; persistent: boolean } {
  const persistent = threadHome !== null;
  const home = persistent ? join(threadHome, "codex") : mkdtempSync(join(tmpdir(), "agentswitch-codex-"));
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o700);
  const auth = opts.authPath ?? join(process.env.HOME ?? "", ".codex", "auth.json");
  if (!existsSync(auth)) throw new Error(`${auth} not found; run codex login`);
  copyFileSync(auth, join(home, "auth.json"));
  chmodSync(join(home, "auth.json"), 0o600);
  const profile = join(home, "chromium-profile");
  const ext = opts.extensions ?? NO_EXTENSIONS;
  const mcpToml = codexMcpToml(ext.mcpFor("codex"), mcpServerEnv(opts.gate));
  writeFileSync(join(home, "config.toml"), codexConfigToml(opts.gate, profile, browser, effort, mcpToml));
  writeFileSync(join(home, "AGENTS.md"), executorInstructions());   // Codex's global instructions live in $CODEX_HOME/AGENTS.md
  ext.skillsInto("codex", join(home, "skills"));                     // Codex discovers $CODEX_HOME/skills/*/SKILL.md
  return { home, profile, persistent };
}

export function codexExecutor(opts: CodexExecutorOptions): Executor {
  return {
    harness: "codex",
    async run(input: ExecutionInput): Promise<ExecutionOutcome> {
      const { home, persistent } = prepareHome(opts, input.effort, (opts.browser ?? true) && input.browser, input.threadHome);
      const env = { ...stripProxy(process.env), CODEX_HOME: home, GIT_EDITOR: "true" };
      let child: ChildProcess | null = null;
      let state: TurnState = EMPTY_TURN;
      let notifyDone: (() => void) | null = null;
      const completed = new Promise<void>((r) => (notifyDone = r));
      try {
        child = spawn(opts.binary, ["app-server"], { cwd: input.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
        const client = new AppServerClient(child.stdin!, child.stdout!, async (method, params) => {
          if (method === "mcpServer/elicitation/request") return approvalAnswer(method, true);
          if (!APPROVAL_METHODS.has(method)) return { decision: "decline" };
          const { action, evidence } = describeApproval(method, params);
          const decision = await input.approve(action, evidence);
          if (decision === "allow") state = { ...state, approvals: state.approvals + 1 };
          return approvalAnswer(method, decision === "allow");
        }, (method, params) => {
          const before = state;
          state = applyNotification(state, method, params);
          if (state.text.length > before.text.length) input.emit("text", { text: state.text.at(-1) });
          if (state.tools > before.tools) { const item = (params.item as Json) ?? {}; input.emit("tool_call", { tool: String(item.type ?? method), command: item.command ?? null }); }
          for (const a of state.agentEvents.slice(before.agentEvents.length)) input.emit("agent", { harness: "codex", ...a });
          if (state.completed) notifyDone?.();
        });
        child.on("exit", () => { client.fail(new Error("app-server exited")); notifyDone?.(); });
        const onAbort = () => child?.kill("SIGTERM");
        input.signal.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => { state = { ...state, errors: [...state.errors, "timed out"] }; child?.kill("SIGTERM"); }, opts.maxMs ?? 30 * 60_000);
        try {
          await client.request("initialize", { clientInfo: { name: "agentswitch", version: "0.1.0" } });
          client.notify("initialized");
          const threadId = await openThread(client, input, persistent);
          const prompt = composePrompt(input);
          await client.request("turn/start", { threadId, input: codexInput(prompt, input.attachments, input.cwd) });
          await completed;
          return { ...outcomeFromTurn(state, input.signal.aborted ? "cancelled" : (child.exitCode !== null && !state.completed ? `app-server exited ${child.exitCode}: ${stderr.slice(0, 300)}` : null)), sessionId: threadId };
        } finally {
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onAbort);
        }
      } finally {
        child?.kill("SIGTERM");
        if (!persistent) rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

/** Resume the thread's Codex conversation when we have one (verified: `thread/resume {threadId}` reloads the
 *  rollout from CODEX_HOME); fall back to a fresh thread if the resume is refused. Persistent homes start
 *  non-ephemeral threads so the rollout is written at all. */
async function openThread(client: AppServerClient, input: ExecutionInput, persistent: boolean): Promise<string> {
  const base = { cwd: input.cwd, sandbox: "workspace-write", approvalPolicy: "on-request", model: input.model };
  if (input.resume) {
    try {
      const resumed = await client.request("thread/resume", { threadId: input.resume, ...base });
      const id = (resumed.thread as Json | undefined)?.id;
      if (typeof id === "string") { input.emit("text", { text: `(resumed Codex thread ${id})` }); return id; }
    } catch (err) {
      input.emit("text", { text: `(could not resume Codex thread ${input.resume}: ${(err as Error).message.slice(0, 120)}; starting a new one)` });
    }
  }
  const started = await client.request("thread/start", { ...base, ephemeral: !persistent });
  return String((started.thread as Json).id);
}

/** Text plus each image attachment as a local image item, so Codex sees screenshots without a Read tool. */
export function codexInput(text: string, attachments: readonly Attachment[], cwd: string): Json[] {
  const images = attachments.filter((a) => isImage(a.name)).map((a) => ({ type: "localImage", path: join(cwd, a.path) }));
  return [{ type: "text", text }, ...images];
}
