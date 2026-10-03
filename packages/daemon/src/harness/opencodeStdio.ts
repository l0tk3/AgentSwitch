/** One resident `opencode serve --stdio` process, as both OpenCode servers run it: the router's
 *  (router/routers/opencodeServe.ts) and the executors' (executors/opencodeServer.ts). Verified with 2.0.8: `--stdio`
 *  takes the password from OPENCODE_PASSWORD and deletes it from the server's own environment before starting, so the
 *  shells and MCP servers it spawns never see it (plain `serve` keeps OPENCODE_SERVER_PASSWORD in every child's env);
 *  it binds the given loopback port (0 = any free one, a fixed port is honoured) and reports the address as one JSON
 *  line on stdout; it exits when its stdin closes, i.e. when the daemon goes away. The process leads its own group
 *  (spawnOwned), so stopping it reaches whatever it started. */

import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { spawnOwned, terminateProcess } from "./processes.js";

const PASSWORD_BYTES = 24;
/** What is kept of the server's output: enough stderr for an exit message, enough stdout to find the address line. */
const STDERR_KEEP_CHARS = 2_000;
const STDOUT_SCAN_CHARS = 4_000;
/** Stderr quoted in an error or log line. */
const STDERR_QUOTE_CHARS = 300;
/** Start-up (spawn to address line) and the grace between stdin EOF and the kill when stopping. */
const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 1_000;
/** A server that failed to come up is not waited for long. */
const FAILED_START_GRACE_MS = 200;

export type StdioServeOptions = {
  readonly binary: string;
  readonly cwd: string;
  /** The server's environment. Any OPENCODE_SERVER_PASSWORD / OPENCODE_PASSWORD in it is dropped; the password is ours. */
  readonly env: Readonly<Record<string, string>>;
  /** Loopback port; 0 lets the server pick a free one. */
  readonly port: number;
  readonly startTimeoutMs?: number | undefined;
};

/** The ports of the servers running now, of either kind and the terminals' (docs/browser-v0.md §2 安全: AgentSwitch's
 *  own ports, never opened in the shared browser). */
const livePorts = new Set<number>();

/** The loopback ports of every `opencode serve --stdio` this daemon runs now. */
export function stdioServePorts(): number[] {
  return [...livePorts];
}

const portOfUrl = (url: string): number | null => {
  try { const port = Number(new URL(url).port); return Number.isInteger(port) && port > 0 ? port : null; } catch { return null; }
};

export type StdioServe = {
  readonly child: ChildProcess;
  readonly url: string;
  readonly password: string;
  /** The end of the server's stderr so far, for exit messages. */
  stderrTail(): string;
};

/** Spawn and wait for the `{"url": …}` line. Rejects (and reaps the process) when the binary cannot start, exits first,
 *  or reports nothing within `startTimeoutMs`. */
export async function startStdioServe(opts: StdioServeOptions): Promise<StdioServe> {
  const startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS;
  const password = randomBytes(PASSWORD_BYTES).toString("base64url");
  const { OPENCODE_SERVER_PASSWORD: _server, OPENCODE_PASSWORD: _stdio, ...base } = opts.env;
  const child = spawnOwned(opts.binary, ["serve", "--stdio", "--port", String(opts.port), "--hostname", "127.0.0.1"], { cwd: opts.cwd, env: { ...base, OPENCODE_PASSWORD: password }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  let ready = false;
  const stderrTail = (): string => stderr.trim().slice(-STDERR_QUOTE_CHARS);
  child.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-STDERR_KEEP_CHARS); });
  const url = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`opencode serve --stdio did not report its address within ${startTimeoutMs} ms: ${stderrTail()}`)), startTimeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      if (ready) return;   // keep draining the pipe, keep nothing
      stdout = (stdout + d.toString()).slice(-STDOUT_SCAN_CHARS);
      const line = stdout.split("\n").find((l) => l.trim().startsWith("{") && l.includes("\"url\""));
      if (!line) return;
      ready = true;
      clearTimeout(timer);
      try { ok(String((JSON.parse(line) as { url: unknown }).url)); } catch (e) { fail(e as Error); }
    });
    child.on("error", (e) => { clearTimeout(timer); fail(new Error(`opencode serve --stdio failed to start: ${e.message}`)); });
    child.on("exit", (code) => { clearTimeout(timer); fail(new Error(`opencode serve --stdio exited (${code}) before it was ready: ${stderrTail()}`)); });
  }).catch(async (err: Error) => { await terminateProcess(child, FAILED_START_GRACE_MS); throw err; });
  const port = portOfUrl(url);
  if (port !== null && child.exitCode === null && child.signalCode === null) {
    livePorts.add(port);
    child.once("exit", () => livePorts.delete(port));
  }
  return { child, url, password, stderrTail };
}

/** EOF on stdin is the server's shutdown signal; the group is terminated after `graceMs` either way. */
export async function stopStdioServe(child: ChildProcess, graceMs = STOP_GRACE_MS): Promise<void> {
  child.stdin?.end();
  await terminateProcess(child, graceMs);
}

/** The `authorization` header for the server's API (the user name is fixed). */
export function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}
