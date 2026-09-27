/** OpenCode executor. Default (tech debt #8): a session on the daemon's resident executor server
 *  (`opencode serve --stdio`, opencodeServer.ts), wired per execution by opencodeServeRun.ts; rules that say "ask"
 *  become engine approvals and the question tool becomes engine questions. Fallback, and the only path with
 *  AGENTSWITCH_OPENCODE_EXECUTOR=run: `opencode run --standalone --format json -m <model>` in the task cwd.
 *
 *  The standalone path has static permissions only (design A.3: `run` cannot surface permission prompts), so edits
 *  inside cwd and shell are allowed, the gate home is unreadable and webfetch is denied; both paths share those rules
 *  (opencodeShared.ts). */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Extensions, NO_EXTENSIONS } from "../extensions/index.js";
import type { ExecutionOutcome } from "../core/outcome.js";
import { opencodeMcpFromRegistry } from "./extensions.js";
import { gateEnv, gateRun, mcpServerEnv, reportTransfer, withoutCredentialRepair, type GateOptions } from "./gate.js";
import { stripProxy } from "../util/env.js";
import { composePrompt, withGuidanceHead } from "./instructions.js";
import { interruptedOutcome, watchRunStop } from "./lifecycle.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../core/limits.js";
import type { OpenCodeExecServer } from "./opencodeServer.js";
import { runOnServer } from "./opencodeServeRun.js";
import { opencodeExecConfig, outcomeFromRun, SUBAGENT_TOOL, type OpenCodeExtras, type RunSummary } from "./opencodeShared.js";
import { spawnOwned, terminateProcess } from "../harness/processes.js";
import type { ProtectedPaths } from "./protected.js";
import { clipInput, clipOutput } from "./toolEvents.js";
import type { ExecutionInput, Executor } from "./types.js";

export { opencodeExecConfig, outcomeFromRun, protectedDeny, type OpenCodeExtras, type RunSummary } from "./opencodeShared.js";

/** How much of OpenCode's stderr the "refused to resume" note quotes. */
const RESUME_ERROR_CHARS = 120;

export type OpenCodeExecutorOptions = {
  readonly binary?: string;
  readonly gate?: GateOptions | null;
  readonly maxMs?: number;
  readonly browser?: boolean;
  readonly extensions?: Pick<Extensions, "mcpFor" | "skillsInto">;
  readonly protected?: ProtectedPaths;
  /** The resident executor server; without it, or when it cannot take a run, `opencode run --standalone`. */
  readonly server?: OpenCodeExecServer | null;
  /** Operator log (stderr by default). Never receives a scope, repair key or grant. */
  readonly log?: (line: string) => void;
};

/** Fold the `--format json` event stream into text, tool calls, errors and the session id (every event carries `sessionID`). */
export function summarizeRun(stdout: string): RunSummary {
  const out: RunSummary = { text: "", tools: [], errors: [], sessionId: null, telemetryComplete: true };
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev: { type?: string; sessionID?: string; part?: Record<string, unknown>; error?: unknown; message?: string };
    try { ev = JSON.parse(line); } catch { out.telemetryComplete = false; continue; }
    if (typeof ev.sessionID === "string" && !out.sessionId) out.sessionId = ev.sessionID;
    if (ev.type === "text" && typeof ev.part?.text === "string") out.text += ev.part.text;
    else if (ev.type === "tool_use" && ev.part) {
      const state = (ev.part.state ?? {}) as { input?: unknown; output?: unknown; status?: string };
      out.tools.push({ tool: String(ev.part.tool ?? "?"), input: ev.part.input ?? state.input ?? ev.part.state ?? null, ...(state.output !== undefined ? { output: clipOutput(state.output) } : {}) });
    }
    else if (ev.type === "error") out.errors.push(typeof ev.error === "string" ? ev.error : ev.message ?? JSON.stringify(ev.error ?? ev));
    else if (!["step_start", "step_finish", "reasoning", "text"].includes(ev.type ?? "")) out.telemetryComplete = false;
  }
  return out;
}

/** A resume that OpenCode refused (session gone from its db, or a different directory): retry without it. */
export function resumeRefused(summary: RunSummary, exitCode: number | null, stderr: string, timedOut = false): boolean {
  return !timedOut && exitCode !== null && exitCode !== 0 && summary.telemetryComplete && !summary.text.trim() && summary.tools.length === 0
    && /session[^\n]*(?:not found|does not exist|unknown|invalid|expired)/i.test(`${summary.errors.join(" ")} ${stderr}`);
}

type RunResult = { readonly summary: RunSummary; readonly exitCode: number | null; readonly stderr: string; readonly timedOut: boolean };

/** One `opencode run` process: streams text/tool/agent events to the engine, honours the abort signal and the timeout. */
function runOnce(binary: string, prompt: string, resume: string | null, input: ExecutionInput, env: Record<string, string>, maxMs: number): Promise<RunResult> {
  return new Promise((done) => {
    if (resume) input.emit("text", { text: `(resuming OpenCode session ${resume})` });
    const child = spawnOwned(binary, ["run", "--standalone", "--format", "json", "-m", input.model, ...(resume ? ["--session", resume] : []), prompt], { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buffered = "";
    const stop = watchRunStop(input.signal, maxMs, () => void terminateProcess(child));
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d.toString();
      buffered += d.toString();
      let i;
      while ((i = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, i); buffered = buffered.slice(i + 1);
        const one = summarizeRun(line);
        if (one.text) input.emit("text", { text: one.text });
        for (const t of one.tools) {
          input.emit("tool_call", { tool: t.tool, input: clipInput(t.input), ...(t.output !== undefined ? { output: t.output } : {}) });
          if (SUBAGENT_TOOL.test(t.tool)) input.emit("agent", { harness: "opencode", agentId: "", status: "completed", description: String((t.input as { description?: string } | null)?.description ?? "sub-agent") });
        }
      }
    });
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => { stderr += e.message; });
    child.on("close", async (exitCode) => {
      stop.dispose();
      if (stop.timedOut || input.signal.aborted) await terminateProcess(child);
      done({ summary: summarizeRun(stdout), exitCode, stderr, timedOut: stop.timedOut });
    });
  });
}

/** The run's private dir: skills and the 0600 config, plus the env and prompt that go with them. The guidance
 *  (EXECUTOR.md, the gate's AGENTS.md) rides at the head of the prompt: OpenCode 2.0.8 ignores the config file's
 *  `instructions` key, so a config entry never reached the model. */
function prepareRun(dir: string, input: ExecutionInput, opts: OpenCodeExecutorOptions): { env: Record<string, string>; prompt: string } {
  const configPath = join(dir, "opencode.json");
  const ext = opts.extensions ?? NO_EXTENSIONS;
  const skillsDir = join(dir, "skills");
  const extras: OpenCodeExtras = {
    mcp: opencodeMcpFromRegistry(ext.mcpFor("opencode"), mcpServerEnv(opts.gate)),
    skillsDir: ext.skillsInto("opencode", skillsDir).length ? skillsDir : null,
    ...(opts.protected ? { protected: opts.protected } : {}),
  };
  const browser = (opts.browser ?? true) && input.browser;
  const run = gateRun(input, browser);
  writeFileSync(configPath, JSON.stringify(opencodeExecConfig(opts.gate, input.browserProfile ?? join(dir, "profile"), browser, extras, input.credentialRepair, run)), { mode: 0o600 });
  reportTransfer(input, run, "opencode", !!opts.gate, browser);
  // The shell tool inherits this env: its proxy URL carries the execution scope.
  const env = { ...stripProxy(withoutCredentialRepair(process.env)), ...(opts.gate ? gateEnv(opts.gate, run.scope) : {}), PWD: input.cwd, OPENCODE_CONFIG: configPath, GIT_EDITOR: "true" };
  return { env, prompt: withGuidanceHead(composePrompt({ ...input, transfer: opts.gate ? run.transfer ?? null : null })) };
}

export function opencodeExecutor(opts: OpenCodeExecutorOptions = {}): Executor {
  const binary = opts.binary ?? join(process.env.HOME ?? "", ".opencode", "bin", "opencode");
  const log = opts.log ?? ((line: string) => console.error(line));
  return {
    harness: "opencode",
    async run(input: ExecutionInput): Promise<ExecutionOutcome> {
      if (opts.server) {
        const attempt = await runOnServer(opts.server, input, { ...opts, log });
        if (attempt.kind === "done") return attempt.outcome;
        log(`OpenCode executor for ${input.taskId}: ${attempt.reason}; running opencode run --standalone`);
        input.emit("text", { text: `(OpenCode resident server not used: ${attempt.reason}; running opencode run --standalone)` });
      }
      return runStandalone(binary, input, opts);
    },
  };
}

async function runStandalone(binary: string, input: ExecutionInput, opts: OpenCodeExecutorOptions): Promise<ExecutionOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-oc-"));
  try {
    const { env, prompt } = prepareRun(dir, input, opts);
    const maxMs = opts.maxMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
    // Native continuation: `--session <id>` picks the conversation up (sessions live in OpenCode's shared db, keyed by
    // directory, so the engine only offers a resume for the same cwd); a refused resume falls back to a fresh session.
    let r = await runOnce(binary, prompt, input.resume, input, env, maxMs);
    if (input.resume && !input.signal.aborted && resumeRefused(r.summary, r.exitCode, r.stderr, r.timedOut)) {
      input.emit("text", { text: `(OpenCode refused to resume ${input.resume}: ${r.stderr.trim().slice(0, RESUME_ERROR_CHARS)}; starting a new session)` });
      r = await runOnce(binary, prompt, null, input, env, maxMs);
    }
    const outcome = outcomeFromRun(r.summary, r.exitCode, r.stderr, r.timedOut);
    return input.signal.aborted ? interruptedOutcome(outcome) : outcome;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
