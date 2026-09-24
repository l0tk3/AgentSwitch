/** Minimal JSON-RPC client for `codex app-server` over a pair of streams (stdio in production,
 *  PassThrough in tests). Server→client requests are answered by a callback; notifications go to
 *  a listener. Verified protocol facts: packages/secret-gate/scripts/codex_appserver_e2e.py.
 *  Shared by the Codex executor, the Codex planner router, quota and model discovery (`appServerRequest`). */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { stripProxy } from "../util/env.js";

/** One JSON-RPC request when the caller names no deadline. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Stderr of a disposable app-server: what is kept, and what an exit error quotes. */
const STDERR_KEEP_CHARS = 2_000;
const STDERR_QUOTE_CHARS = 200;

export type Json = Record<string, unknown>;
export type ServerRequestHandler = (method: string, params: Json) => Promise<Json>;
export type NotificationHandler = (method: string, params: Json) => void;

/** The server answered a request with a JSON-RPC error (message: the error object as JSON). Every other rejection
 *  (closed streams, no response in time, `fail`) is a plain Error, so callers can tell the server's answer apart. */
export class RpcError extends Error {
  constructor(readonly error: unknown) { super(JSON.stringify(error)); }
}

export class AppServerClient {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (r: Json) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly onServerRequest: ServerRequestHandler,
    private readonly onNotification: NotificationHandler,
  ) {
    createInterface({ input: output }).on("line", (line) => this.handle(line));
    input.on("error", (err) => this.fail(err));
    output.on("error", (err) => this.fail(err));
    output.on("close", () => this.fail(new Error("app-server closed")));
  }

  private send(msg: Json): void {
    if (!this.closed) this.input.write(JSON.stringify(msg) + "\n");
  }

  private handle(line: string): void {
    let msg: Json;
    try { msg = JSON.parse(line) as Json; } catch { return; }
    if (typeof msg.method === "string" && msg.id !== undefined) {
      void this.onServerRequest(msg.method, (msg.params as Json) ?? {}).then(
        (result) => this.send({ jsonrpc: "2.0", id: msg.id, result }),
        (err: Error) => this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err.message } }),
      );
      return;
    }
    if (typeof msg.method === "string") { this.onNotification(msg.method, (msg.params as Json) ?? {}); return; }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error));
      else p.resolve((msg.result as Json) ?? {});
    }
  }

  request(method: string, params: Json = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("app-server closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no response in ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Json = {}): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  fail(err: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

/** One JSON-RPC call on a disposable `codex app-server` over the shared AppServerClient: initialize, the call, SIGKILL.
 *  Server→client requests are answered with accept; proxy variables never reach the child. One deadline covers the whole
 *  exchange. A JSON-RPC error rejects at once; every other failure (spawn or stdin error, exit, deadline, abort) is
 *  reported by the process-level handlers, so an exit keeps its code and stderr tail. */
export function appServerRequest(binary: string, method: string, params: Json, timeoutMs: number, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<Json> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("cancelled")); return; }
    const child = spawn(binary, ["app-server"], { env: stripProxy(env), stdio: ["pipe", "pipe", "pipe"] });
    const client = new AppServerClient(child.stdin, child.stdout, async () => ({ decision: "accept" }), () => undefined);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      client.fail(new Error("app-server request finished"));
      child.kill("SIGKILL");  // disposable read-only process: a hung child must not outlive the refresh
      fn();
    };
    const onAbort = () => finish(() => reject(signal?.reason ?? new Error("cancelled")));
    const timer = setTimeout(() => finish(() => reject(new Error(`${method}: timed out after ${timeoutMs} ms`))), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + String(d)).slice(-STDERR_KEEP_CHARS)));
    child.stdin.on("error", (e) => finish(() => reject(e)));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => finish(() => reject(new Error(`app-server exited ${code}: ${stderr.slice(0, STDERR_QUOTE_CHARS)}`))));
    // Only the server's own error answer settles here: a closed stream or a per-request timeout rejects the request too,
    // but the exit, error and deadline handlers above report those with better detail.
    const refused = (name: string) => (err: unknown) => { if (err instanceof RpcError) finish(() => reject(new Error(`${name} failed: ${err.message}`))); };
    client.request("initialize", { clientInfo: { name: "agentswitch", version: "0.1.0" } }, timeoutMs).then(() => {
      client.notify("initialized");
      client.request(method, params, timeoutMs).then((result) => finish(() => resolve(result)), refused(method));
    }, refused("initialize"));
  });
}
