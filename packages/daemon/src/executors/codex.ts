/** Codex executor over `codex app-server`: thread/start → turn/start → items → turn/completed.
 *  Approvals (item/…/requestApproval, execCommandApproval, applyPatchApproval) go to the
 *  engine; MCP elicitations are accepted. A private CODEX_HOME holds a 0600 copy of auth.json and
 *  our config (never the user's ~/.codex/config.toml), removed when the run ends. */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_SIDE_EFFECTS, type ExecutionOutcome } from "../router/failure.js";
import { AppServerClient, type Json } from "./appserver.js";
import { codexGateToml, stripProxy, type GateOptions } from "./gate.js";
import { executorInstructions } from "./instructions.js";
import type { ExecutionInput, Executor } from "./types.js";

export type CodexExecutorOptions = {
  readonly binary: string;
  readonly authPath?: string;
  readonly gate?: GateOptions | null;
  readonly browser?: boolean;
  readonly maxMs?: number;
};

const APPROVAL_METHODS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "execCommandApproval", "applyPatchApproval"]);

export function codexConfigToml(gate: GateOptions | null | undefined, profile: string, browser: boolean, effort: string | null): string {
  const head = `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n${effort ? `model_reasoning_effort = ${JSON.stringify(effort)}\n` : ""}`;
  return head + (gate ? "\n" + codexGateToml(gate, profile, browser) : "\n[sandbox_workspace_write]\nnetwork_access = true\n");
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

export type TurnState = { text: string[]; tools: number; edits: number; approvals: number; completed: Json | null; errors: string[] };

export function applyNotification(state: TurnState, method: string, params: Json): TurnState {
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
  };
}

function prepareHome(opts: CodexExecutorOptions, effort: string | null, browser: boolean): { home: string; profile: string } {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-codex-"));
  chmodSync(home, 0o700);
  const auth = opts.authPath ?? join(process.env.HOME ?? "", ".codex", "auth.json");
  if (!existsSync(auth)) throw new Error(`${auth} not found; run codex login`);
  copyFileSync(auth, join(home, "auth.json"));
  chmodSync(join(home, "auth.json"), 0o600);
  const profile = join(home, "chromium-profile");
  writeFileSync(join(home, "config.toml"), codexConfigToml(opts.gate, profile, browser, effort));
  writeFileSync(join(home, "AGENTS.md"), executorInstructions());   // Codex's global instructions live in $CODEX_HOME/AGENTS.md
  return { home, profile };
}

export function codexExecutor(opts: CodexExecutorOptions): Executor {
  return {
    harness: "codex",
    async run(input: ExecutionInput): Promise<ExecutionOutcome> {
      const { home } = prepareHome(opts, input.effort, (opts.browser ?? true) && input.browser);
      const env = { ...stripProxy(process.env), CODEX_HOME: home };
      let child: ChildProcess | null = null;
      let state: TurnState = { text: [], tools: 0, edits: 0, approvals: 0, completed: null, errors: [] };
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
          if (state.completed) notifyDone?.();
        });
        child.on("exit", () => { client.fail(new Error("app-server exited")); notifyDone?.(); });
        const onAbort = () => child?.kill("SIGTERM");
        input.signal.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => { state = { ...state, errors: [...state.errors, "timed out"] }; child?.kill("SIGTERM"); }, opts.maxMs ?? 30 * 60_000);
        try {
          await client.request("initialize", { clientInfo: { name: "agentswitch", version: "0.1.0" } });
          client.notify("initialized");
          const thread = await client.request("thread/start", { cwd: input.cwd, sandbox: "workspace-write", approvalPolicy: "on-request", ephemeral: true, model: input.model });
          const threadId = String((thread.thread as Json).id);
          const prompt = input.handoffNote ? `${input.brief}\n\nHandoff from a previous attempt:\n${input.handoffNote}` : input.brief;
          await client.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
          await completed;
          return outcomeFromTurn(state, input.signal.aborted ? "cancelled" : (child.exitCode !== null && !state.completed ? `app-server exited ${child.exitCode}: ${stderr.slice(0, 300)}` : null));
        } finally {
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onAbort);
        }
      } finally {
        child?.kill("SIGTERM");
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}
