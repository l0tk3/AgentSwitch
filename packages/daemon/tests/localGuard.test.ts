/** The 127.0.0.1 listener refuses what a web page can make a browser send: a foreign Origin, a rebinding Host, a
 *  non-JSON body. The web UI (same origin), the CLI and the Mac app (no Origin) keep working (security review 2026-09-24). */

import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localRefusal, type LocalRequest } from "../src/api/localGuard.js";
import { Client } from "../src/client.js";
import { buildDaemon, listenLocal, type Daemon, type DaemonConfig } from "../src/daemon.js";
import { QuotaService } from "../src/quota/index.js";
import { TARGETS_PATH } from "./helpers.js";

const PORT = 4711;
const base: LocalRequest = { method: "GET", path: "/tasks", host: `127.0.0.1:${PORT}`, origin: undefined, contentType: undefined, hasBody: false };
const refusal = (over: Partial<LocalRequest>) => localRefusal({ ...base, ...over }, PORT)?.status ?? null;

describe("localRefusal", () => {
  it("Host must name this listener on its own port", () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `LocalHost:${PORT}`, `[::1]:${PORT}`]) expect(refusal({ host }), host).toBeNull();
    for (const host of ["127.0.0.1", `127.0.0.1:${PORT + 1}`, `rebind.evil.example:${PORT}`, `localhost.evil.example:${PORT}`, "", undefined]) expect(refusal({ host }), String(host)).toBe(403);
    expect(localRefusal(base, undefined)?.status).toBe(403);   // no socket port: nothing to compare Host with
  });

  it("an Origin, when present, must be the web UI's own", () => {
    for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]) expect(refusal({ origin }), origin).toBeNull();
    for (const origin of ["https://evil.example", "null", "http://localhost:3000", `https://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}.evil.example`, `http://127.0.0.1:${PORT}, https://evil.example`]) {
      expect(refusal({ origin }), origin).toBe(403);
    }
  });

  it("a state-changing body must be JSON; multipart only for POST /uploads", () => {
    const post = { method: "POST", hasBody: true };
    expect(refusal({ ...post, contentType: "application/json" })).toBeNull();
    expect(refusal({ ...post, contentType: "Application/JSON; charset=utf-8" })).toBeNull();
    for (const contentType of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", undefined]) {
      expect(refusal({ ...post, contentType }), String(contentType)).toBe(415);
    }
    expect(refusal({ ...post, path: "/uploads", contentType: "multipart/form-data; boundary=x" })).toBeNull();
    expect(refusal({ ...post, path: "/uploads", contentType: "text/plain" })).toBe(415);
    expect(refusal({ method: "PUT", hasBody: true, contentType: "text/plain" })).toBe(415);
    expect(refusal({ method: "DELETE", hasBody: true, contentType: "application/x-www-form-urlencoded" })).toBe(415);
    expect(refusal({ method: "POST", hasBody: false, contentType: "text/plain" })).toBeNull();   // POST /pairing, /tasks/:id/cancel
    expect(refusal({ method: "GET", hasBody: true, contentType: "text/plain" })).toBeNull();
  });
});

type Reply = { status: number; body: Record<string, unknown> };
const open: { d: Daemon; close: () => Promise<void> }[] = [];
afterEach(async () => { for (const s of open.splice(0)) { await s.close(); s.d.close(); } });

async function local(): Promise<{ d: Daemon; port: number; send: (method: string, path: string, opts?: { headers?: Record<string, string>; body?: string | Buffer }) => Promise<Reply> }> {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-guard-"));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  const d = buildDaemon(cfg, { quota: new QuotaService([]) });
  const server = await new Promise<ReturnType<typeof listenLocal>>((ok) => { const s = listenLocal(d, 0, () => ok(s)); });
  const port = (server.address() as AddressInfo).port;
  open.push({ d, close: () => new Promise<void>((ok) => { server.close(() => ok()); (server as import("node:http").Server).closeAllConnections(); }) });
  const send = (method: string, path: string, opts: { headers?: Record<string, string>; body?: string | Buffer } = {}) => new Promise<Reply>((resolve, reject) => {
    const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
    const headers = { host: `127.0.0.1:${port}`, ...(body ? { "content-length": String(body.length) } : {}), ...opts.headers };
    const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
  return { d, port, send };
}

const MULTIPART = { type: "multipart/form-data; boundary=b", body: '--b\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b--\r\n' };

describe("the 127.0.0.1 listener", () => {
  it("refuses a cross-site task with an approval override, a text/plain body and a rebinding Host", async () => {
    const { d, port, send } = await local();
    const attack = JSON.stringify({ task: "x", approval: { mode: "auto" } });
    const crossSite = await send("POST", "/tasks", { headers: { origin: "https://evil.example", "content-type": "text/plain;charset=UTF-8" }, body: attack });
    expect(crossSite.status).toBe(403);
    expect((await send("POST", "/tasks", { headers: { origin: "https://evil.example", "content-type": "application/json" }, body: attack })).status).toBe(403);
    expect((await send("POST", "/tasks", { headers: { "content-type": "text/plain" }, body: attack })).status).toBe(415);
    expect((await send("POST", "/tasks", { body: attack })).status).toBe(415);
    expect((await send("POST", "/pairing", { headers: { host: `rebind.evil.example:${port}` } })).status).toBe(403);
    expect((await send("GET", "/tasks", { headers: { host: `rebind.evil.example:${port}` } })).status).toBe(403);
    expect((await send("POST", "/uploads", { headers: { origin: "https://evil.example", "content-type": MULTIPART.type }, body: MULTIPART.body })).status).toBe(403);
    expect((await send("POST", "/tasks", { headers: { "content-type": MULTIPART.type }, body: MULTIPART.body })).status).toBe(415);
    expect(d.store.listTasks(10)).toEqual([]);
  });

  it("serves the web UI's same-origin requests, uploads included", async () => {
    const { port, send } = await local();
    expect((await send("GET", "/ui", { headers: { host: `localhost:${port}` } })).status).toBe(200);
    const same = { origin: `http://127.0.0.1:${port}` };
    const created = await send("POST", "/tasks", { headers: { ...same, "content-type": "application/json" }, body: JSON.stringify({ task: 'hi @echo {"result":"ok"}' }) });
    expect(created.status).toBe(201);
    const upload = await send("POST", "/uploads", { headers: { ...same, "content-type": MULTIPART.type }, body: MULTIPART.body });
    expect(upload.status).toBe(200);
    expect((await send("GET", `/tasks/${String(created.body.id)}`, { headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` } })).status).toBe(200);
    expect((await send("POST", "/pairing", { headers: same })).status).toBe(409);   // reached the route: remote access is off here
  });

  it("serves the CLI (and the Mac app's URLSession): no Origin, JSON bodies", async () => {
    const { d, port } = await local();
    const client = new Client(`http://127.0.0.1:${port}`);
    expect((await client.health()).ok).toBe(true);
    const t = await client.submit('cli @echo {"result":"ok"}', undefined);
    await d.engine.idle();
    expect((await client.task(t.id)).status).toBe("done");
    expect((await client.cancel(t.id)).id).toBe(t.id);
  });
});
