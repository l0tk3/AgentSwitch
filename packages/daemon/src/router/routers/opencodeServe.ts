/** The resident OpenCode server (router-v0 §2, decided 2026-09-22): one `opencode serve` process for the whole
 *  daemon; every router-type call (dispatch, summary, supervision) is a fresh session on it, ~1 s instead of a
 *  2-3 s cold start per `run --standalone`. The v2 API takes no per-call system prompt, so the instructions ride
 *  at the head of the user message and the configured agents carry only the tool policy.
 *
 *  The process is `opencode serve --stdio --port <AGENTSWITCH_OPENCODE_PORT>` (harness/opencodeStdio.ts, shared with
 *  the executors' server): its password never reaches the processes it spawns, and it exits with the daemon. */

import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { basicAuth, startStdioServe, stopStdioServe } from "../../harness/opencodeStdio.js";
import { stripProxy } from "../../util/env.js";
import { sleep } from "../../util/sleep.js";
import type { Router, RouterInput, RouterReply } from "../../core/modelCall.js";

export const DEFAULT_OPENCODE_PORT = 4712;
const POLL_MS = 250;
/** Response text quoted in an API error. */
const ERROR_BODY_CHARS = 200;
const AGENT_PROMPT = "You are an AgentSwitch service agent. Your full instructions come at the head of each message, followed by the material to act on. Follow the instructions exactly and reply only as they say.";

export type ServeAgent = "dispatcher" | "oracle";

/** Config injected via OPENCODE_CONFIG: a read-only dispatcher (can look at a repo) and a text-only oracle. */
export function serveConfig(gateHome: string): object {
  const noTools = { bash: false, edit: false, write: false, patch: false, webfetch: false, websearch: false, todowrite: false };
  const none = { ...noTools, read: false, glob: false, grep: false, list: false };
  return {
    $schema: "https://opencode.ai/config.json",
    agent: {
      dispatcher: { mode: "primary", description: "AgentSwitch dispatcher", prompt: AGENT_PROMPT, tools: noTools, steps: 12 },
      oracle: { mode: "primary", description: "AgentSwitch text-only agent", prompt: AGENT_PROMPT, tools: none, steps: 1 },
    },
    permission: { read: { "*": "allow", [`${gateHome}/*`]: "deny", "**/.env": "deny", "**/*.pem": "deny", "**/*.key": "deny" }, bash: "deny", edit: "deny", webfetch: "deny" },
  };
}

type Json = Record<string, unknown>;

export type OpenCodeServerOptions = {
  readonly binary: string;
  /** Loopback port (AGENTSWITCH_OPENCODE_PORT); 0 lets the server pick one. */
  readonly port?: number;
  readonly home: string;          // where the config file goes
  readonly gateHome: string;
  /** Tests and tools: an already running server instead of spawning one. */
  readonly endpoint?: { readonly url: string; readonly password: string };
  readonly startTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
};

export class OpenCodeServer {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private password = "";
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: OpenCodeServerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((l) => console.error(l));
  }

  /** Spawn and wait until the server reports its address. Throws when it does not come up in time. */
  async start(): Promise<void> {
    if (this.opts.endpoint) { this.url = this.opts.endpoint.url; this.password = this.opts.endpoint.password; return; }
    mkdirSync(this.opts.home, { recursive: true });
    const configPath = join(this.opts.home, "opencode.serve.json");
    writeFileSync(configPath, JSON.stringify(serveConfig(this.opts.gateHome)));
    const env = { ...stripProxy(process.env), OPENCODE_CONFIG: configPath, PWD: this.opts.home, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
    const { child, url, password, stderrTail } = await startStdioServe({ binary: this.opts.binary, cwd: this.opts.home, env, port: this.opts.port ?? DEFAULT_OPENCODE_PORT, startTimeoutMs: this.opts.startTimeoutMs });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.log(`opencode serve exited (${code}) ${stderrTail()}`);
      this.child = null; this.url = null;
    });
    this.child = child; this.url = url; this.password = password;
    this.log(`opencode serve ready on ${url}`);
  }

  get running(): boolean { return this.url !== null && (this.opts.endpoint !== undefined || this.child !== null); }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null; this.url = null;
    if (child) await stopStdioServe(child);
  }

  private headers(): Record<string, string> {
    return { authorization: basicAuth(this.password), "content-type": "application/json" };
  }

  private async call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Json> {
    if (!this.url) throw new Error(`opencode serve ${method} ${path}: the server is not running`);
    const res = await this.fetchImpl(`${this.url}${path}`, { method, headers: this.headers(), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode serve ${method} ${path}: HTTP ${res.status} ${text.slice(0, ERROR_BODY_CHARS)}`);
    return text ? (JSON.parse(text) as Json) : {};
  }

  /** One question, one answer: create a session for the agent/model, prompt, wait for the idle marker, read the text, delete. */
  async ask(agent: ServeAgent, model: string, text: string, cwd: string, signal: AbortSignal): Promise<string> {
    const [providerID, ...rest] = model.split("/");
    const created = await this.call("POST", "/api/session", { agent, model: { providerID, id: rest.join("/") || model }, location: { directory: cwd } }, signal);
    const sessionId = String((created.data as Json | undefined)?.id ?? "");
    if (!sessionId) throw new Error("opencode serve: session create returned no id");
    try {
      const sent = await this.call("POST", `/api/session/${sessionId}/prompt`, { text }, signal);
      const since = Number(((sent.data as Json | undefined)?.time as Json | undefined)?.created ?? Date.now());
      for (;;) {
        if (signal.aborted) throw signal.reason ?? new Error("cancelled");
        const list = await this.call("GET", `/api/session/${sessionId}/message`, undefined, signal);
        const messages = (list.data as Json[] | undefined) ?? [];
        const idle = messages.find((m) => m.type === "idle" && Number((m.time as Json | undefined)?.created ?? 0) >= since);
        if (idle) {
          if (idle.outcome && idle.outcome !== "succeeded") throw new Error(`opencode serve: turn ${String(idle.outcome)}`);
          return messages.filter((m) => m.type === "assistant" && Number((m.time as Json | undefined)?.created ?? 0) >= since)
            .flatMap((m) => ((m.content as Json[] | undefined) ?? []).filter((p) => p.type === "text").map((p) => String(p.text ?? ""))).join("");
        }
        await sleep(POLL_MS, signal);
      }
    } finally {
      this.call("DELETE", `/api/session/${sessionId}`).catch(() => undefined);
    }
  }
}

/** A Router on the resident server. `system` is prepended to the message (the API has no per-call system). */
export function serveRouter(server: OpenCodeServer, agent: ServeAgent, model: string): Router {
  return {
    name: `opencode-serve:${agent}`,
    async route(input: RouterInput, signal: AbortSignal): Promise<RouterReply> {
      const started = Date.now();
      const message = `${input.system}\n\n=====\n\n${input.task}${input.previousError ? `\n\n(previous reply rejected: ${input.previousError})` : ""}`;
      const text = await server.ask(agent, model, message, input.cwd, signal);
      return { text, elapsedMs: Date.now() - started };
    },
  };
}
