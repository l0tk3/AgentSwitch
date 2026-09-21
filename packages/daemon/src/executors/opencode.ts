/** OpenCode executor: `opencode run --standalone --format json -m <model>` in the task cwd.
 *
 *  Permissions are static (no interactive approvals): `opencode run` cannot surface permission
 *  prompts (design A.3), so edits inside cwd and shell are allowed, the gate home is unreadable
 *  and webfetch is denied. Dangerous-command review therefore relies on the router not sending
 *  such tasks here; Codex and Claude carry the approval protocol. */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Extensions, NO_EXTENSIONS } from "../extensions/index.js";
import { NO_SIDE_EFFECTS, type ExecutionOutcome } from "../router/failure.js";
import { opencodeMcpFromRegistry } from "./extensions.js";
import { gateEnv, mcpServerEnv, opencodeGateConfig, stripProxy, type GateOptions } from "./gate.js";
import { executorInstructions } from "./instructions.js";
import { NO_PROTECTED, type ProtectedPaths } from "./protected.js";
import type { ExecutionInput, Executor } from "./types.js";

export type OpenCodeExecutorOptions = {
  readonly binary?: string;
  readonly gate?: GateOptions | null;
  readonly maxMs?: number;
  readonly browser?: boolean;
  readonly extensions?: Pick<Extensions, "mcpFor" | "skillsInto">;
  readonly protected?: ProtectedPaths;
};

export type OpenCodeExtras = { readonly mcp?: Record<string, unknown>; readonly skillsDir?: string | null; readonly protected?: ProtectedPaths };

/** Static deny patterns for the protected roots: no edit under them, no shell command naming them. */
export function protectedDeny(prot: ProtectedPaths): { edit: Record<string, string>; bash: Record<string, string> } {
  const edit: Record<string, string> = {};
  const bash: Record<string, string> = {};
  for (const r of prot.roots) { edit[`${r}/*`] = "deny"; bash[`*${r}*`] = "deny"; }
  return { edit, bash };
}

export function opencodeExecConfig(gate: GateOptions | null | undefined, profile: string, browser: boolean, instructionsPath?: string, extras: OpenCodeExtras = {}): object {
  const g = gate ? opencodeGateConfig(gate, profile, browser) : { mcp: {}, readDeny: {} };
  const deny = protectedDeny(extras.protected ?? NO_PROTECTED);
  return {
    $schema: "https://opencode.ai/config.json",
    ...(instructionsPath ? { instructions: [instructionsPath] } : {}),
    ...(extras.skillsDir ? { skills: { paths: [extras.skillsDir] } } : {}),
    mcp: { ...g.mcp, ...(extras.mcp ?? {}) },
    permission: {
      read: { "*": "allow", ...g.readDeny, "**/.env": "deny", "**/*.pem": "deny", "**/*.key": "deny" },
      bash: { "*": "allow", "secret-gate keygen*": "deny", ...(gate ? { [`cat ${gate.home}/*`]: "deny" } : {}), ...deny.bash },
      edit: Object.keys(deny.edit).length ? { "*": "allow", ...deny.edit } : "allow",
      webfetch: "deny",
    },
  };
}

export type RunSummary = { text: string; tools: { tool: string; input: unknown }[]; errors: string[]; sessionId: string | null };

/** Fold the `--format json` event stream into text, tool calls, errors and the session id (every event carries `sessionID`). */
export function summarizeRun(stdout: string): RunSummary {
  const out: RunSummary = { text: "", tools: [], errors: [], sessionId: null };
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev: { type?: string; sessionID?: string; part?: Record<string, unknown>; error?: unknown; message?: string };
    try { ev = JSON.parse(line); } catch { continue; }
    if (typeof ev.sessionID === "string" && !out.sessionId) out.sessionId = ev.sessionID;
    if (ev.type === "text" && typeof ev.part?.text === "string") out.text += ev.part.text;
    else if (ev.type === "tool_use" && ev.part) out.tools.push({ tool: String(ev.part.tool ?? "?"), input: ev.part.input ?? ev.part.state ?? null });
    else if (ev.type === "error") out.errors.push(typeof ev.error === "string" ? ev.error : ev.message ?? JSON.stringify(ev.error ?? ev));
  }
  return out;
}

export function outcomeFromRun(summary: RunSummary, exitCode: number | null, stderr: string, timedOut: boolean): ExecutionOutcome {
  const edits = summary.tools.filter((t) => /^(edit|write|patch|multiedit)$/i.test(t.tool)).length;
  const shells = summary.tools.filter((t) => /^bash$/i.test(t.tool)).length;
  const sideEffects = { ...NO_SIDE_EFFECTS, filesChanged: edits, commandsRun: shells };
  const errText = [...summary.errors, stderr.trim()].filter(Boolean).join("\n");
  const ok = !timedOut && exitCode === 0 && summary.errors.length === 0 && summary.text.trim().length > 0;
  return { ok, exitCode, stderr: errText, lastText: summary.text.trim(), timedOut, sideEffects, ...(summary.sessionId ? { sessionId: summary.sessionId } : {}) };
}

/** A resume that OpenCode refused (session gone from its db, or a different directory): retry without it. */
export function resumeRefused(summary: RunSummary, exitCode: number | null, stderr: string): boolean {
  return exitCode !== 0 && !summary.text.trim() && /session/i.test(`${summary.errors.join(" ")} ${stderr}`);
}

export function opencodeExecutor(opts: OpenCodeExecutorOptions = {}): Executor {
  const binary = opts.binary ?? join(process.env.HOME ?? "", ".opencode", "bin", "opencode");
  return {
    harness: "opencode",
    async run(input: ExecutionInput): Promise<ExecutionOutcome> {
      const dir = mkdtempSync(join(tmpdir(), "agentswitch-oc-"));
      const configPath = join(dir, "opencode.json");
      const instructionsPath = join(dir, "AGENTS.md");
      writeFileSync(instructionsPath, executorInstructions());
      const ext = opts.extensions ?? NO_EXTENSIONS;
      const skillsDir = join(dir, "skills");
      const extras: OpenCodeExtras = {
        mcp: opencodeMcpFromRegistry(ext.mcpFor("opencode"), mcpServerEnv(opts.gate)),
        skillsDir: ext.skillsInto("opencode", skillsDir).length ? skillsDir : null,
        ...(opts.protected ? { protected: opts.protected } : {}),
      };
      writeFileSync(configPath, JSON.stringify(opencodeExecConfig(opts.gate, join(dir, "profile"), (opts.browser ?? true) && input.browser, instructionsPath, extras)));
      const env = { ...stripProxy(process.env), ...(opts.gate ? gateEnv(opts.gate) : {}), PWD: input.cwd, OPENCODE_CONFIG: configPath, GIT_EDITOR: "true" };
      const prompt = input.handoffNote ? `${input.brief}\n\nHandoff from a previous attempt:\n${input.handoffNote}` : input.brief;
      // Native continuation (verified: `--session <id>` in a later `run --standalone` process picks the conversation up;
      // sessions live in OpenCode's shared db, keyed by directory, so the engine only offers a resume for the same cwd).
      const once = (resume: string | null) => new Promise<{ summary: RunSummary; exitCode: number | null; stderr: string; timedOut: boolean }>((done) => {
        if (resume) input.emit("text", { text: `(resuming OpenCode session ${resume})` });
        const child = spawn(binary, ["run", "--standalone", "--format", "json", "-m", input.model, ...(resume ? ["--session", resume] : []), prompt], { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, opts.maxMs ?? 30 * 60_000);
        const onAbort = () => child.kill("SIGTERM");
        input.signal.addEventListener("abort", onAbort, { once: true });
        let buffered = "";
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString();
          buffered += d.toString();
          let i;
          while ((i = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, i); buffered = buffered.slice(i + 1);
            const one = summarizeRun(line);
            if (one.text) input.emit("text", { text: one.text });
            for (const t of one.tools) input.emit("tool_call", { tool: t.tool, input: t.input });
          }
        });
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("error", (e) => { stderr += e.message; });
        child.on("close", (exitCode) => {
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onAbort);
          done({ summary: summarizeRun(stdout), exitCode, stderr, timedOut });
        });
      });
      try {
        let r = await once(input.resume);
        if (input.resume && !input.signal.aborted && resumeRefused(r.summary, r.exitCode, r.stderr)) {
          input.emit("text", { text: `(OpenCode refused to resume ${input.resume}: ${r.stderr.trim().slice(0, 120)}; starting a new session)` });
          r = await once(null);
        }
        return outcomeFromRun(r.summary, r.exitCode, r.stderr, r.timedOut);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
