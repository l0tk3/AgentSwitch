/** Lines of JSON over a WebSocket, as `codex app-server --listen ws://…` speaks them: one text frame a message. Node's
 *  own WebSocket cannot send the `Authorization` header a capability token needs, so the little of RFC 6455 a client
 *  needs is here: the upgrade, masked text frames out, text frames in (fragments joined), ping answered, close. The
 *  two streams fit `AppServerClient`: a line written goes out as a frame, a frame comes in as a line. */

import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Socket } from "node:net";
import { PassThrough, Writable } from "node:stream";

export type WsLines = { readonly input: Writable; readonly output: PassThrough; close(): void };

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** One message at most: a model list or a thread's history, not more. */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 0xff])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  const mask = randomBytes(4);
  const body = Buffer.alloc(n);
  for (let i = 0; i < n; i++) body[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([head, mask, body]);
}

/** Connects to `url` (`ws://host:port`), with `token` as its bearer where the server asks for one. Rejects when the
 *  server refuses the upgrade (no or a wrong token: 401) or does not answer in `timeoutMs`. */
export function connectWsLines(url: string, o: { token?: string; timeoutMs?: number } = {}): Promise<WsLines> {
  const target = new URL(url);
  const key = randomBytes(16).toString("base64");
  return new Promise<WsLines>((ok, fail) => {
    const req = request({
      host: target.hostname, port: Number(target.port), path: target.pathname || "/", method: "GET",
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13", ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    });
    const timer = setTimeout(() => { req.destroy(); fail(new Error("no answer to the WebSocket upgrade")); }, o.timeoutMs ?? 10_000);
    req.on("error", (err) => { clearTimeout(timer); fail(err); });
    req.on("response", (res) => { clearTimeout(timer); res.resume(); fail(new Error(`the WebSocket upgrade was refused: HTTP ${res.statusCode}`)); });
    req.on("upgrade", (res, socket: Socket, head) => {
      clearTimeout(timer);
      const accept = createHash("sha1").update(key + GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== accept) { socket.destroy(); fail(new Error("not a WebSocket server")); return; }
      ok(lines(socket, head));
    });
    req.end();
  });
}

function lines(socket: Socket, head: Buffer): WsLines {
  const output = new PassThrough();
  let closed = false;
  const close = () => { if (closed) return; closed = true; try { socket.write(frame(0x8, Buffer.alloc(0))); } catch { /* gone */ } socket.destroy(); output.end(); };
  let pending: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts: Buffer[] = [], size = 0;
  const read = () => {
    for (;;) {
      if (pending.length < 2) return;
      const fin = (pending[0]! & 0x80) !== 0, opcode = pending[0]! & 0x0f, masked = (pending[1]! & 0x80) !== 0;
      let n = pending[1]! & 0x7f, at = 2;
      if (n === 126) { if (pending.length < 4) return; n = pending.readUInt16BE(2); at = 4; }
      else if (n === 127) { if (pending.length < 10) return; const big = pending.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE_BYTES)) return close(); n = Number(big); at = 10; }
      const mask = masked ? pending.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (pending.length < at + n) return;
      let payload: Buffer = pending.subarray(at, at + n);
      if (mask) { payload = Buffer.from(payload); for (let i = 0; i < n; i++) payload[i] = payload[i]! ^ mask[i & 3]!; }
      pending = pending.subarray(at + n);
      if (opcode === 0x8) return close();
      if (opcode === 0x9) { socket.write(frame(0xA, Buffer.from(payload))); continue; }
      if (opcode === 0xA) continue;
      parts.push(Buffer.from(payload)); size += n;
      if (size > MAX_MESSAGE_BYTES) return close();
      if (fin) { output.write(Buffer.concat(parts).toString("utf8").replace(/\n/g, " ") + "\n"); parts = []; size = 0; }
    }
  };
  socket.on("data", (d: Buffer) => { pending = pending.length ? Buffer.concat([pending, d]) : d; read(); });
  socket.on("close", () => { closed = true; output.end(); });
  socket.on("error", () => { closed = true; output.end(); });
  let rest = "";
  const input = new Writable({
    write(chunk: Buffer | string, _enc, done) {
      rest += chunk.toString();
      let cut: number;
      while ((cut = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, cut); rest = rest.slice(cut + 1);
        if (line.trim() && !closed) socket.write(frame(0x1, Buffer.from(line, "utf8")));
      }
      done();
    },
  });
  if (pending.length) read();
  return { input, output, close };
}
