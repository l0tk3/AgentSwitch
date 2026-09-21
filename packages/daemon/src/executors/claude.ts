/** Claude Code executor via the Agent SDK. `canUseTool` is the approval hook: read-only tools and
 *  edits inside cwd are allowed, everything else (Bash, writes outside cwd, web) asks the engine.
 *  User settings are not loaded (settingSources: []); the gate proxy goes into the tool env. */

import { query, type CanUseTool, type EffortLevel, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Extensions, NO_EXTENSIONS } from "../extensions/index.js";
import { NO_AGENTS, NO_SIDE_EFFECTS, type AgentCounts, type ExecutionOutcome } from "../router/failure.js";
import type { RateLimitCache, RateLimitInfo } from "../quota/windows.js";
import { autoAllowedMcp, claudeMcpFromRegistry, claudePluginDir, mcpServerOf } from "./extensions.js";
import { claudeMcpServers, gateEnv, mcpServerEnv, type GateOptions } from "./gate.js";
import { composePrompt, executorInstructions } from "./instructions.js";
import { commandTouchesProtected, isProtected, NO_PROTECTED, type ProtectedPaths } from "./protected.js";
import type { ApprovalDecision, ExecutionInput, Executor } from "./types.js";

export type ClaudeExecutorOptions = {
  readonly gate?: GateOptions | null;
  readonly browser?: boolean;
  readonly maxTurns?: number;
  readonly executable?: string;
  readonly rateLimits?: RateLimitCache;
  readonly extensions?: Pick<Extensions, "mcpFor" | "skillsInto">;
  /** Paths denied outright, never offered for approval (daemon home, gate home, daemon config). */
  readonly protected?: ProtectedPaths;
};

const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "TodoRead", "Task", "WebSearch", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export type ToolDecision = { kind: "allow" } | { kind: "ask"; action: string; evidence: string } | { kind: "deny"; reason: string };

export const PROTECTED_DENIAL = "denied by AgentSwitch: this path holds the daemon's own configuration or credentials; the model cannot change its own constraints";

/** Real path of `p` even when it does not exist yet: realpath of the nearest existing ancestor + the rest.
 *  macOS reports the temp dir as /var/... and /private/var/... interchangeably. */
export function canonical(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return p;
    tail.unshift(basename(head));
    head = parent;
  }
  try { head = realpathSync(head); } catch { return p; }
  return tail.length ? join(head, ...tail) : head;
}

/** Policy: what needs a human. `cwd` should already be canonical; `allowedMcp` = registry servers marked approval=allow. */
export function decideTool(toolName: string, input: Record<string, unknown>, cwd: string, allowedMcp: ReadonlySet<string> = new Set(), prot: ProtectedPaths = NO_PROTECTED): ToolDecision {
  if (READ_ONLY.has(toolName) || toolName === "Skill") return { kind: "allow" };
  const server = mcpServerOf(toolName);
  if (server && (server === "secret-gate" || server === "playwright" || allowedMcp.has(server))) return { kind: "allow" };
  if (EDIT_TOOLS.has(toolName)) {
    const raw = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
    const p = raw === null ? null : canonical(resolve(cwd, raw));
    if (p && isProtected(p, cwd, prot)) return { kind: "deny", reason: `${PROTECTED_DENIAL} (${p})` };
    if (p && (p === cwd || p.startsWith(cwd + sep))) return { kind: "allow" };
    return { kind: "ask", action: `${toolName} outside cwd: ${p ?? "?"}`, evidence: JSON.stringify(input).slice(0, 1000) };
  }
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    const hit = commandTouchesProtected(command, cwd, prot);
    if (hit) return { kind: "deny", reason: `${PROTECTED_DENIAL} (${hit})` };
    return { kind: "ask", action: `Bash: ${command}`, evidence: String(input.description ?? "") };
  }
  return { kind: "ask", action: `${toolName}`, evidence: JSON.stringify(input).slice(0, 1000) };
}

export type AgentEvent = { readonly agentId: string; readonly status: "started" | "progress" | "completed" | "failed" | "stopped"; readonly description: string; readonly summary?: string; readonly tokens?: number; readonly background?: boolean };

export type Folded = { text: string[]; tools: number; edits: number; result: Extract<SDKMessage, { type: "result" }> | null; refusal: boolean; rateLimited: boolean; agents: AgentCounts; agentEvents: AgentEvent[] };

export const EMPTY_FOLD: Folded = { text: [], tools: 0, edits: 0, result: null, refusal: false, rateLimited: false, agents: NO_AGENTS, agentEvents: [] };

/** Sub-agent bookends (background-v0 §2): task_started / task_progress / task_notification, ambient tasks ignored. */
function foldTask(state: Folded, msg: SDKMessage): Folded | null {
  if (msg.type !== "system") return null;
  const m = msg as { subtype?: string; task_id?: string; description?: string; summary?: string; status?: string; is_backgrounded?: boolean; ambient?: boolean; usage?: { total_tokens?: number } };
  if (m.ambient) return state;
  const base = { agentId: String(m.task_id ?? ""), description: String(m.description ?? "") };
  if (m.subtype === "task_started") return { ...state, agents: { ...state.agents, spawned: state.agents.spawned + 1 }, agentEvents: [...state.agentEvents, { ...base, status: "started", background: m.is_backgrounded ?? false }] };
  if (m.subtype === "task_progress") return { ...state, agentEvents: [...state.agentEvents, { ...base, status: "progress", ...(m.summary ? { summary: m.summary } : {}), ...(m.usage?.total_tokens !== undefined ? { tokens: m.usage.total_tokens } : {}) }] };
  if (m.subtype === "task_notification") {
    const status = m.status === "completed" ? "completed" : m.status === "failed" ? "failed" : "stopped";
    const agents = { ...state.agents, completed: state.agents.completed + (status === "completed" ? 1 : 0), failed: state.agents.failed + (status === "completed" ? 0 : 1) };
    return { ...state, agents, agentEvents: [...state.agentEvents, { ...base, status, ...(m.summary ? { summary: m.summary } : {}), ...(m.usage?.total_tokens !== undefined ? { tokens: m.usage.total_tokens } : {}) }] };
  }
  return null;
}

export function foldMessage(state: Folded, msg: SDKMessage): Folded {
  const task = foldTask(state, msg);
  if (task) return task;
  if (msg.type === "assistant") {
    const blocks = (msg.message as { content?: { type: string; text?: string; name?: string }[] }).content ?? [];
    const text = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text!);
    const tools = blocks.filter((b) => b.type === "tool_use");
    const edits = tools.filter((b) => b.name && EDIT_TOOLS.has(b.name)).length;
    return { ...state, text: [...state.text, ...text], tools: state.tools + tools.length, edits: state.edits + edits };
  }
  if (msg.type === "result") return { ...state, result: msg };
  if (msg.type === "system" && (msg as { subtype?: string }).subtype === "model_refusal_no_fallback") return { ...state, refusal: true };
  if (msg.type === "rate_limit_event") return { ...state, rateLimited: true };
  return state;
}

export function outcomeFromFold(state: Folded, approvals: number, cancelled: boolean): ExecutionOutcome {
  const r = state.result;
  const usage = r ? (r.usage as { input_tokens?: number; output_tokens?: number }) : undefined;
  const tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  const sideEffects = { ...NO_SIDE_EFFECTS, filesChanged: state.edits, commandsRun: state.tools - state.edits, approvalsGranted: approvals };
  const agents = state.agents;
  if (state.refusal) return { ok: false, exitCode: 0, lastText: `refusal: ${state.text.at(-1) ?? "model refused"}`, sideEffects, tokens, agents };
  if (!r) return { ok: false, exitCode: cancelled ? null : 1, stderr: cancelled ? "cancelled" : "no result message", lastText: state.text.join("\n"), timedOut: !cancelled, sideEffects, tokens, agents };
  const sessionId = r.session_id ? { sessionId: r.session_id } : {};
  if (r.subtype === "success" && !r.is_error) return { ok: true, exitCode: 0, lastText: r.result, sideEffects, tokens, agents, ...sessionId };
  const errText = r.subtype === "success" ? r.result : `${r.subtype}${state.rateLimited ? " (rate limited)" : ""}`;
  return { ok: false, exitCode: 1, stderr: state.rateLimited ? `rate limit: ${errText}` : errText, lastText: state.text.join("\n"), sideEffects, tokens, agents };
}

/** Private config dir per thread. CLAUDE_CONFIG_DIR alone makes the CLI look for a per-dir keychain entry
 *  ("Claude Code-credentials-<hash>") and report "Not logged in"; CLAUDE_SECURESTORAGE_CONFIG_DIR="" keeps the
 *  user's normal keychain login (verified 2026-09-21, scripts/resume_experiment.ts). */
export function claudeHomeEnv(threadHome: string | null): Record<string, string> {
  if (!threadHome) return {};
  const dir = join(threadHome, "claude");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" };
}

export function claudeExecutor(opts: ClaudeExecutorOptions = {}): Executor {
  return {
    harness: "claude-code",
    async run(input: ExecutionInput): Promise<ExecutionOutcome> {
      const cwd = canonical(resolve(input.cwd));
      const ext = opts.extensions ?? NO_EXTENSIONS;
      const servers = ext.mcpFor("claude-code");
      const allowedMcp = autoAllowedMcp(servers);
      let approvals = 0;
      const canUseTool: CanUseTool = async (toolName, toolInput) => {
        const d = decideTool(toolName, toolInput, cwd, allowedMcp, opts.protected ?? NO_PROTECTED);
        if (d.kind === "allow") return { behavior: "allow", updatedInput: toolInput };
        if (d.kind === "deny") { input.emit("tool_call", { tool: toolName, denied: d.reason }); return { behavior: "deny", message: d.reason }; }
        const decision: ApprovalDecision = await input.approve(d.action, d.evidence);
        if (decision === "allow") { approvals++; return { behavior: "allow", updatedInput: toolInput }; }
        return { behavior: "deny", message: "denied by the user via AgentSwitch" };
      };
      const runDir = mkdtempSync(join(tmpdir(), "agentswitch-claude-"));
      const profile = join(runDir, "profile");
      const pluginRoot = join(runDir, "plugin");
      ext.skillsInto("claude-code", join(pluginRoot, "skills"));
      const plugin = claudePluginDir(pluginRoot, join(pluginRoot, "skills"));
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      input.signal.addEventListener("abort", onAbort, { once: true });
      const browser = (opts.browser ?? true) && input.browser;
      const baseEnv = { ...(opts.gate ? gateEnv(opts.gate) : {}), ...claudeHomeEnv(input.threadHome) };
      const mcpServers = { ...(opts.gate ? claudeMcpServers(opts.gate, profile, browser) : {}), ...claudeMcpFromRegistry(servers, mcpServerEnv(opts.gate)) };
      const options: Options = {
        cwd, model: input.model, canUseTool, permissionMode: "default", settingSources: [],
        systemPrompt: { type: "preset", preset: "claude_code", append: executorInstructions() },
        maxTurns: opts.maxTurns ?? 200, abortController: abort, includePartialMessages: false,
        ...(input.effort && EFFORTS.has(input.effort) ? { effort: input.effort as EffortLevel } : {}),
        env: { ...process.env, ...baseEnv, GIT_EDITOR: "true" } as Record<string, string>,
        ...(input.resume ? { resume: input.resume } : {}),
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        ...(plugin ? { plugins: [{ type: "local" as const, path: plugin }], skills: "all" as const } : {}),
        ...(opts.executable ? { pathToClaudeCodeExecutable: opts.executable } : {}),
      };
      const prompt = composePrompt(input);
      let state: Folded = EMPTY_FOLD;
      try {
        for await (const msg of query({ prompt, options })) {
          const before = state;
          state = foldMessage(state, msg);
          if (msg.type === "rate_limit_event") opts.rateLimits?.record(msg.rate_limit_info);
          for (const t of state.text.slice(before.text.length)) input.emit("text", { text: t });
          if (state.tools > before.tools) input.emit("tool_call", { tool: "claude", count: state.tools - before.tools });
          for (const a of state.agentEvents.slice(before.agentEvents.length)) input.emit("agent", { harness: "claude-code", ...a });
        }
      } catch (err) {
        if (!input.signal.aborted) return { ok: false, exitCode: 1, stderr: (err as Error).message, lastText: state.text.join("\n"), sideEffects: { ...NO_SIDE_EFFECTS, approvalsGranted: approvals }, agents: state.agents };
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        rmSync(runDir, { recursive: true, force: true });
      }
      return outcomeFromFold(state, approvals, input.signal.aborted);
    },
  };
}

/** One-turn query whose only purpose is the rate_limit_event it emits (subscription windows). */
export async function probeRateLimits(model = "claude-haiku-4-5-20251001", executable?: string): Promise<RateLimitInfo[]> {
  const infos: RateLimitInfo[] = [];
  const options: Options = { model, maxTurns: 1, permissionMode: "default", settingSources: [], canUseTool: async () => ({ behavior: "deny", message: "probe" }), ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) };
  for await (const msg of query({ prompt: "Reply with the single word: ok", options })) {
    if (msg.type === "rate_limit_event") infos.push(msg.rate_limit_info);
  }
  return infos;
}
