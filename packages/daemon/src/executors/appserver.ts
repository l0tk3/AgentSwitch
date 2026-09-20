/** Minimal JSON-RPC client for `codex app-server` over a pair of streams (stdio in production,
 *  PassThrough in tests). Server→client requests are answered by a callback; notifications go to
 *  a listener. Verified protocol facts: packages/secret-gate/scripts/codex_appserver_e2e.py. */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type Json = Record<string, unknown>;
export type ServerRequestHandler = (method: string, params: Json) => Promise<Json>;
export type NotificationHandler = (method: string, params: Json) => void;

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
      if (msg.error) p.reject(new Error(`${JSON.stringify(msg.error)}`));
      else p.resolve((msg.result as Json) ?? {});
    }
  }

  request(method: string, params: Json = {}, timeoutMs = 60_000): Promise<Json> {
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
