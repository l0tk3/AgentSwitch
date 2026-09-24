/** Which Claude models' safeguards flag a real executor request (2026-09-24: a plain "log in to x.com, ask me for the
 *  code" was flagged `[cyber]` on claude-sonnet-5). For a task's last dispatch it rebuilds what the claude-code
 *  executor sent — Claude Code's system prompt with the executor guidance appended, the secret-gate and browser MCP
 *  tools, and the composed prompt (the dispatched brief + CONTEXT.md) — and sends it once per model. As a baseline it
 *  also sends the user's own words alone (no system prompt, no tools). Every tool call is denied and there is one turn,
 *  so nothing runs: no browser opens, no token reaches the gate. Not exact: platform memory and feedback notes the
 *  engine may have added are left out, and CONTEXT.md is today's.
 *  Real model calls; run by hand from packages/daemon:
 *    npx tsx scripts/guardrail_probe.ts <taskId> [model ...]
 *  Env: AGENTSWITCH_URL (default http://127.0.0.1:4721), AGENTSWITCH_HOME (default the Mac app's data folder),
 *  CLAUDE_BIN (default `claude` on PATH). */

import { query, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadContext } from "../src/core/contextDoc.js";
import { mcpConfigFile } from "../src/executors/claude.js";
import { claudeMcpServers, defaultGate, gateEnv, gateRun } from "../src/executors/gate.js";
import { composePrompt, executorInstructions } from "../src/executors/instructions.js";
import { resolveCommand } from "../src/util/which.js";

const DEFAULT_MODELS = ["claude-sonnet-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
const PER_CALL_MS = 180_000;
const FLAGGED = /safeguards flagged/i;
const REQUEST_ID = /Request ID:\s*(req_[A-Za-z0-9]+)/;

type Verdict = { readonly flagged: boolean; readonly detail: string; readonly requestId: string | null; readonly ms: number };

const base = process.env.AGENTSWITCH_URL ?? "http://127.0.0.1:4721";
const home = process.env.AGENTSWITCH_HOME ?? join(homedir(), "Library", "Application Support", "AgentSwitch");
const claude = resolveCommand(process.env.CLAUDE_BIN, "claude", process.env.PATH);

async function lastDispatch(taskId: string): Promise<{ task: string; brief: string }> {
  const task = await (await fetch(`${base}/tasks/${taskId}`)).json() as { task?: string; status?: string };
  if (!task.task) throw new Error(`task ${taskId} not found at ${base}`);
  if (!["done", "partial", "blocked", "failed", "cancelled"].includes(task.status ?? "")) throw new Error(`task ${taskId} is still ${task.status}`);
  const stream = await (await fetch(`${base}/tasks/${taskId}/events`)).text();   // ends after the terminal event
  const dispatched = stream.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)) as { type: string; payload: { brief?: string } })
    .filter((e) => e.type === "dispatched" && e.payload.brief).at(-1);
  if (!dispatched) throw new Error(`task ${taskId} was never dispatched`);
  return { task: task.task, brief: dispatched.payload.brief! };
}

async function ask(prompt: string, options: Options): Promise<Verdict> {
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PER_CALL_MS);
  const texts: string[] = [];
  try {
    for await (const msg of query({ prompt, options: { ...options, abortController: abort } })) {
      if (msg.type === "assistant") for (const block of msg.message.content) if (block.type === "text") texts.push(block.text);
      if (msg.type === "result" && msg.subtype === "success") texts.push(msg.result);
    }
  } catch (err) {
    texts.push(`error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const all = texts.join("\n");
  const flagged = FLAGGED.test(all);
  return { flagged, requestId: REQUEST_ID.exec(all)?.[1] ?? null, detail: flagged ? "" : all.replace(/\s+/g, " ").slice(0, 90), ms: Date.now() - started };
}

const denyAll: CanUseTool = async () => ({ behavior: "deny", message: "guardrail probe: tools are not run" });

async function main(): Promise<void> {
  const [taskId, ...picked] = process.argv.slice(2);
  if (!taskId) throw new Error("usage: npx tsx scripts/guardrail_probe.ts <taskId> [model ...]");
  const models = picked.length ? picked : DEFAULT_MODELS;
  const gate = defaultGate();
  if (!gate) throw new Error("secret-gate not found (set SECRET_GATE_BIN or create packages/secret-gate/.venv)");
  const { task, brief } = await lastDispatch(taskId);
  const prompt = composePrompt({ brief, task, handoffNote: null, context: loadContext(join(home, "CONTEXT.md")).text });
  const runDir = mkdtempSync(join(tmpdir(), "guardrail-probe-"));
  try {
    const servers = claudeMcpServers(gate, join(runDir, "profile"), true, undefined, gateRun({ gateScope: null, transfer: null }, true));
    const full: Options = {
      cwd: runDir, permissionMode: "default", settingSources: [], maxTurns: 1, canUseTool: denyAll, pathToClaudeCodeExecutable: claude,
      systemPrompt: { type: "preset", preset: "claude_code", append: executorInstructions() },
      env: { ...process.env, ...gateEnv(gate, null) } as Record<string, string>,
      extraArgs: { "mcp-config": mcpConfigFile(runDir, servers) },
    };
    const bare: Options = { cwd: runDir, permissionMode: "default", settingSources: [], maxTurns: 1, tools: [], canUseTool: denyAll, pathToClaudeCodeExecutable: claude };
    console.log(`task ${taskId}: "${task.slice(0, 60)}"; prompt ${prompt.length} chars; claude ${claude}\n`);
    console.log("model | full executor request | user's words alone");
    for (const model of models) {
      const f = await ask(prompt, { ...full, model });
      const b = await ask(task, { ...bare, model });
      const cell = (v: Verdict) => (v.flagged ? `FLAGGED ${v.requestId ?? ""}` : `ok (${(v.ms / 1000).toFixed(0)}s) ${v.detail}`);
      console.log(`${model} | ${cell(f)} | ${cell(b)}`);
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

await main();
