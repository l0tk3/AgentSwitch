/** The executors' resident OpenCode server (tech debt #8): one `opencode serve --stdio` owned by the daemon, separate
 *  from the router's (router/routers/opencodeServe.ts), whose agents deny shell and edit and whose sessions run in task
 *  directories too. Everything that belongs to one execution (shell env, MCP servers, permissions, instructions)
 *  is set per session or per location by opencodeServeRun.ts; this module only runs the process and talks to it.
 *
 *  The process is `opencode serve --stdio --port 0` (harness/opencodeStdio.ts, shared with the router's server): a free
 *  loopback port, a password that never reaches the server's children, and an exit when the daemon goes away. Its env
 *  has no proxy: OpenCode's own model calls go direct, only the shell env of each session carries the gate proxy. */

import type { ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Extensions } from "../extensions/index.js";
import { withoutCredentialRepair, type GateOptions } from "./gate.js";
import { stripProxy } from "../util/env.js";
import { opencodeExecConfig } from "./opencodeShared.js";
import { basicAuth, startStdioServe, stopStdioServe } from "../harness/opencodeStdio.js";
import { canonicalPath, type ProtectedPaths } from "./protected.js";

export type Json = Record<string, unknown>;

const RESTART_COOLDOWN_MS = 60_000;
const CALL_TIMEOUT_MS = 15_000;
/** `--port 0`: the server picks a free loopback port and reports it. */
const ANY_PORT = 0;

/** OPENCODE_CONFIG of the executor server: the same static permission rules every execution gets (a backstop for
 *  sessions without their own ruleset) and the shared skills dir. No MCP servers and no secrets: those are per
 *  execution. `instructions` is left out on purpose: OpenCode 2.0.8 ignores it (verified for both `run` and `serve`),
 *  so the executor guidance goes in as a session instruction entry. */
export function opencodeServeConfig(gate: GateOptions | null, prot: ProtectedPaths, skillsDir: string): object {
  const { permission } = opencodeExecConfig(gate, "", false, { protected: prot, skillsDir }) as { permission: object };
  return { $schema: "https://opencode.ai/config.json", skills: { paths: [skillsDir] }, permission };
}

/** `?location[directory]=…` (the API's deepObject style). */
export const locationQuery = (directory: string): string => `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;

/** A failed API call. The message names method, route and status only: request and response bodies can carry an
 *  execution's scope or repair key and never go into an error. */
export class OpenCodeApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly tag: string | null) { super(message); }
}

export type OpenCodeExecServerOptions = {
  readonly binary: string;
  /** Private dir: the 0600 config file and the shared skills dir (`<AGENTSWITCH_HOME>/opencode-exec`). */
  readonly home: string;
  /** OPENCODE_CONFIG content (`opencodeServeConfig`). */
  readonly config: object;
  /** Tests and tools: an already running server instead of spawning one. */
  readonly endpoint?: { readonly url: string; readonly password: string };
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
  readonly startTimeoutMs?: number;
  readonly restartCooldownMs?: number;
};

export type CallOptions = { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number };

export class OpenCodeExecServer {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private password = "";
  private lastStart = 0;
  private starting: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  /** Directories with an execution in flight; keyed by the literal and the canonical path. */
  private readonly leased = new Set<string>();
  /** location → runtime MCP servers an execution added and could not remove (removed first next time, or the run falls back). */
  private readonly stale = new Map<string, ReadonlySet<string>>();
  private skillsQueue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: OpenCodeExecServerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((l) => console.error(l));
  }

  get skillsDir(): string { return join(this.opts.home, "skills"); }

  get running(): boolean { return this.url !== null && (this.opts.endpoint !== undefined || this.child !== null); }

  /** Spawn and wait for the `{"url": …}` line. Throws when the server does not come up in time. */
  start(): Promise<void> {
    this.starting ??= this.spawn().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** Running, or restarted when the last attempt is older than the cooldown (a crashed server is not retried per run). */
  async ensureRunning(): Promise<boolean> {
    if (this.running) return true;
    if (this.starting) { await this.starting.catch(() => undefined); return this.running; }
    if (Date.now() - this.lastStart < (this.opts.restartCooldownMs ?? RESTART_COOLDOWN_MS)) return false;
    try { await this.start(); } catch (err) { this.log(`OpenCode executor server: ${(err as Error).message}`); }
    return this.running;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null; this.url = null;
    this.leased.clear(); this.stale.clear();
    if (!child) return;
    await stopStdioServe(child);
  }

  private async spawn(): Promise<void> {
    this.lastStart = Date.now();
    if (this.opts.endpoint) { this.url = this.opts.endpoint.url; this.password = this.opts.endpoint.password; return; }
    mkdirSync(this.skillsDir, { recursive: true, mode: 0o700 });
    const configPath = join(this.opts.home, "opencode.json");
    writeFileSync(configPath, JSON.stringify(this.opts.config), { mode: 0o600 });
    const env = { ...stripProxy(withoutCredentialRepair(process.env)), OPENCODE_CONFIG: configPath, PWD: this.opts.home };
    const { child, url, password, stderrTail } = await startStdioServe({ binary: this.opts.binary, cwd: this.opts.home, env, port: ANY_PORT, startTimeoutMs: this.opts.startTimeoutMs });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.log(`OpenCode executor server exited (${code}) ${stderrTail()}`);
      this.child = null; this.url = null; this.stale.clear();
    });
    this.child = child; this.url = url; this.password = password;
    this.log(`OpenCode executor server ready on ${url}`);
  }

  async call<T = Json>(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<T> {
    const route = `${method} ${path.split("?")[0]}`;
    if (!this.url) throw new OpenCodeApiError(`${route}: the OpenCode executor server is not running`, null, null);
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const headers = { authorization: basicAuth(this.password), "content-type": "application/json" };
    let res: Response;
    try { res = await this.fetchImpl(`${this.url}${path}`, { method, headers, signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch (err) { throw new OpenCodeApiError(`${route}: ${(err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message}`, null, null); }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let tag: string | null = null;
      try { const t = (JSON.parse(text) as { _tag?: unknown })._tag; tag = typeof t === "string" ? t : null; } catch { /* not JSON */ }
      throw new OpenCodeApiError(`${route}: HTTP ${res.status}${tag ? ` ${tag}` : ""}`, res.status, tag);
    }
    if (!text) return {} as T;
    try { return JSON.parse(text) as T; } catch { throw new OpenCodeApiError(`${route}: response is not JSON`, res.status, null); }
  }

  /** One execution per directory at a time on this server: runtime MCP servers are per location. Null when taken. */
  lease(directory: string): (() => void) | null {
    const keys = [...new Set([resolve(directory), canonicalPath(directory)])];
    if (keys.some((k) => this.leased.has(k))) return null;
    for (const k of keys) this.leased.add(k);
    let released = false;
    return () => { if (released) return; released = true; for (const k of keys) this.leased.delete(k); };
  }

  staleMcp(location: string): readonly string[] { return [...(this.stale.get(location) ?? [])]; }

  setStaleMcp(location: string, names: readonly string[]): void {
    if (names.length) this.stale.set(location, new Set(names)); else this.stale.delete(location);
  }

  /** Refresh the shared skills dir from the registry. Skills are the same for every execution, and OpenCode rescans the
   *  dir (verified), so a changed set is swapped in; refreshes are serialized. Errors reach the caller. */
  refreshSkills(ext: Pick<Extensions, "skillsInto">): Promise<void> {
    const next = this.skillsQueue.then(() => this.swapSkills(ext));
    this.skillsQueue = next.catch(() => undefined);
    return next;
  }

  private swapSkills(ext: Pick<Extensions, "skillsInto">): void {
    const fresh = `${this.skillsDir}.next-${randomBytes(4).toString("hex")}`;
    try {
      mkdirSync(fresh, { recursive: true, mode: 0o700 });
      ext.skillsInto("opencode", fresh);
      if (existsSync(this.skillsDir) && dirSignature(fresh) === dirSignature(this.skillsDir)) return;
      const old = `${this.skillsDir}.old-${randomBytes(4).toString("hex")}`;
      if (existsSync(this.skillsDir)) renameSync(this.skillsDir, old);
      renameSync(fresh, this.skillsDir);
      rmSync(old, { recursive: true, force: true });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  }
}

/** Content hash of a directory tree: relative paths and file bytes. */
function dirSignature(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      hash.update(`${relative(dir, p)}\0${st.isDirectory() ? "d" : "f"}\0`);
      if (st.isDirectory()) walk(p); else if (st.isFile()) hash.update(readFileSync(p));
    }
  };
  walk(dir);
  return hash.digest("hex");
}
