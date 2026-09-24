/** The real router: `opencode run` with a read-only `router` agent, config injected via OPENCODE_CONFIG.
 *
 * Runs in the task's cwd so the agent can look at the repository. The agent gets no bash/edit/web
 * tools; the gate home and key files are denied for read as a belt-and-braces measure.
 * OpenCode picks its session directory from $PWD, so PWD is set explicitly (see design A.3).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripProxy } from "../../util/env.js";
import type { Router, RouterInput, RouterReply } from "../../core/modelCall.js";

/** Stderr quoted when `opencode run` fails. */
const STDERR_QUOTE_CHARS = 400;

export type OpenCodeRouterOptions = {
  readonly binary?: string;
  readonly model: string;
  readonly agentName?: string;
  readonly gateHome?: string;
  /** "read-only" (default): read/glob/grep/list so the dispatcher can look at the repo. "none": text only, one step (the summarizer). */
  readonly tools?: "read-only" | "none";
  /** Directory the agent runs in; default: the request's cwd. The summarizer uses a scratch dir so it cannot wander. */
  readonly runIn?: string;
};

export function routerConfig(system: string, model: string, gateHome: string, agentName = "router", tools: "read-only" | "none" = "read-only"): object {
  const noTools = { bash: false, edit: false, write: false, patch: false, webfetch: false, websearch: false, todowrite: false };
  const none = { ...noTools, read: false, glob: false, grep: false, list: false };
  return {
    $schema: "https://opencode.ai/config.json",
    agent: {
      [agentName]: { mode: "primary", description: "AgentSwitch dispatcher", model, prompt: system, tools: tools === "none" ? none : noTools, steps: tools === "none" ? 1 : 12 },
    },
    permission: {
      read: { "*": "allow", [`${gateHome}/*`]: "deny", "**/.env": "deny", "**/*.pem": "deny", "**/*.key": "deny" },
      bash: "deny",
      edit: "deny",
      webfetch: "deny",
    },
  };
}

/** Text parts of `opencode run --format json` output; unknown lines are ignored. */
export function textFromEvents(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; part?: { text?: string } };
      if (ev.type === "text" && typeof ev.part?.text === "string") parts.push(ev.part.text);
    } catch {
      /* not an event line */
    }
  }
  return parts.join("");
}

export function opencodeRouter(opts: OpenCodeRouterOptions): Router {
  const binary = opts.binary ?? join(process.env.HOME ?? "", ".opencode", "bin", "opencode");
  const agent = opts.agentName ?? "router";
  const gateHome = opts.gateHome ?? join(process.env.HOME ?? "", ".secret-gate");
  return {
    name: "opencode",
    async route(input: RouterInput, signal: AbortSignal): Promise<RouterReply> {
      const dir = mkdtempSync(join(tmpdir(), "agentswitch-router-"));
      const configPath = join(dir, "opencode.json");
      writeFileSync(configPath, JSON.stringify(routerConfig(input.system, opts.model, gateHome, agent, opts.tools ?? "read-only")));
      const message = input.previousError ? `${input.task}\n\n(previous reply rejected: ${input.previousError})` : input.task;
      const cwd = opts.runIn ?? input.cwd;
      const env = { ...stripProxy(process.env), PWD: cwd, OPENCODE_CONFIG: configPath, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
      const started = Date.now();
      try {
        const stdout = await run(binary, ["run", "--standalone", "--format", "json", "--agent", agent, "-m", opts.model, message], cwd, env, signal);
        return { text: textFromEvents(stdout), elapsedMs: Date.now() - started };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}


function run(cmd: string, args: string[], cwd: string, env: Record<string, string>, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], signal });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(signal.aborted ? new Error("router timed out") : e));
    child.on("close", (code) => (code === 0 || out.length > 0 ? resolve(out) : reject(new Error(`opencode exited ${code}: ${err.slice(0, STDERR_QUOTE_CHARS)}`))));
  });
}
