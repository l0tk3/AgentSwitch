/** app-v0 §2 end to end: a real HTTPS listener on an ephemeral port with a certificate from /usr/bin/openssl, a phone
 *  simulated with node:https that pins the fingerprint from the pairing payload. Echo router and executors only. */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { request, type RequestOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemon, startRemote, type Daemon, type DaemonConfig } from "../src/daemon.js";
import { QuotaService } from "../src/quota/index.js";
import { createRemoteApp, PAIR_FAILED, UNAUTHORIZED } from "../src/remote/app.js";
import { Presence, registerDevice } from "../src/remote/devices.js";
import { PAIR_LINK_PREFIX, PAIR_RATE_LIMIT, PairingDesk, PAIRING_TTL_MS, type PairPayload } from "../src/remote/pairing.js";
import { remoteRuntime, type RemoteRuntime } from "../src/remote/runtime.js";
import { listenRemote, type RemoteListener } from "../src/remote/server.js";
import { ensureTls, SYSTEM_OPENSSL, type TlsMaterial } from "../src/remote/tls.js";
import { TARGETS_PATH } from "./helpers.js";

const KEY = Buffer.alloc(32, 9).toString("base64url");
type Json = Record<string, unknown>;
type Reply = { readonly status: number; readonly body: Json; readonly text: string; readonly fingerprint: string };

/** One request on a fresh connection; the peer certificate's DER hash is returned so callers can check the pin. */
function call(port: number, method: string, path: string, opts: { token?: string; json?: unknown; raw?: { body: Buffer; type: string } } = {}): Promise<Reply> {
  const body = opts.raw?.body ?? (opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : undefined);
  const headers: Record<string, string> = {
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...(body ? { "content-type": opts.raw?.type ?? "application/json", "content-length": String(body.length) } : {}),
  };
  const options: RequestOptions = { host: "127.0.0.1", port, method, path, headers, rejectUnauthorized: false, agent: false };
  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      const der = (res.socket as TLSSocket).getPeerCertificate().raw;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: Json = {};
        try { parsed = JSON.parse(text) as Json; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, text, fingerprint: createHash("sha256").update(der).digest("hex") });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Follow an SSE stream; resolves with the event names when the server ends it or the connection drops. */
function events(port: number, path: string, token: string, onEvent: (type: string) => void = () => undefined): Promise<{ types: string[]; status: number }> {
  return new Promise((resolve, reject) => {
    const types: string[] = [];
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, rejectUnauthorized: false, agent: false }, (res) => {
      let buf = "";
      res.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) if (line.startsWith("event: ")) { const t = line.slice(7).trim(); types.push(t); onEvent(t); }
      });
      const done = () => resolve({ types, status: res.statusCode ?? 0 });
      res.on("end", done);
      res.on("close", done);
      res.on("error", done);
    });
    req.on("error", (e) => (types.length ? resolve({ types, status: 0 }) : reject(e)));
    req.end();
  });
}

let tlsCache: TlsMaterial | null = null;
const sharedTls = () => (tlsCache ??= ensureTls(join(mkdtempSync(join(tmpdir(), "agentswitch-rtls-")), "remote")));

type Setup = { d: Daemon; runtime: RemoteRuntime; port: number; listener: RemoteListener; local: (method: string, path: string, json?: unknown) => Promise<{ status: number; body: Json }> };
const open: Setup[] = [];

async function remoteDaemon(opts: { now?: () => number; gateKey?: RemoteRuntime["gateKey"] } = {}): Promise<Setup> {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-remote-"));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  const quota = new QuotaService([{ harness: "codex", read: async () => ({ remaining: 0.5, detail: {}, source: "fake", error: null }) }]);
  const runtime = remoteRuntime({
    home, port: 0, name: "Test Mac", gate: () => null, tls: sharedTls(),
    pairing: new PairingDesk(opts.now ? { now: opts.now } : {}),
    addresses: async () => ({ lan: ["192.168.1.5"], tailnet: ["100.101.102.103", "mac.tail1234.ts.net"] }),
    gateKey: opts.gateKey ?? (async () => ({ publicKey: KEY, keypair: "default" })),
  });
  const d = buildDaemon(cfg, { quota, remote: runtime });
  const listener = await startRemote(d, runtime, "127.0.0.1");
  const local = async (method: string, path: string, json?: unknown) => {
    const res = await d.app.request(path, { method, ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}) });
    return { status: res.status, body: await res.json().catch(() => ({})) as Json };
  };
  const setup = { d, runtime, port: listener.port, listener, local };
  open.push(setup);
  return setup;
}

async function pair(s: Setup, name = "iPhone"): Promise<{ token: string; deviceId: string; payload: PairPayload }> {
  const pairing = await s.local("POST", "/pairing");
  const payload = pairing.body.payload as PairPayload;
  const r = await call(s.port, "POST", "/pair", { json: { code: payload.code, name, platform: "ios" } });
  expect(r.status).toBe(200);
  expect(r.fingerprint).toBe(payload.fp);   // the phone pins this
  return { token: String(r.body.token), deviceId: String(r.body.deviceId), payload };
}

afterEach(async () => {
  for (const s of open.splice(0)) { await s.listener.close(); s.d.close(); }
});

describe.runIf(existsSync(SYSTEM_OPENSSL))("remote HTTPS listener", () => {
  it("GET /healthz needs no token and says only ok; the certificate is the pinned one", async () => {
    const s = await remoteDaemon();
    const r = await call(s.port, "GET", "/healthz");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.fingerprint).toBe(s.runtime.tls.fingerprint);
  });

  it("401 without a token, with a wrong one and after revocation, always the same body", async () => {
    const s = await remoteDaemon();
    for (const token of [undefined, "wrong-token-wrong-token-wrong-token-wrong-t", "x"]) {
      const r = await call(s.port, "GET", "/tasks", token ? { token } : {});
      expect(r.status).toBe(401);
      expect(r.body).toEqual(UNAUTHORIZED);
    }
    const { token, deviceId } = await pair(s);
    expect((await call(s.port, "GET", "/tasks", { token })).status).toBe(200);
    expect((await s.local("DELETE", `/devices/${deviceId}`)).body).toMatchObject({ ok: true, device: { id: deviceId } });
    const revoked = await call(s.port, "GET", "/tasks", { token });
    expect(revoked.status).toBe(401);
    expect(revoked.body).toEqual(UNAUTHORIZED);
    expect((await s.local("DELETE", "/devices/nope")).status).toBe(404);
  });

  it("pairing: local code and payload, remote /pair gives a token, /me knows the device, the code works once", async () => {
    const s = await remoteDaemon();
    const pairing = await s.local("POST", "/pairing");
    expect(pairing.status).toBe(200);
    const { code, expiresAt, link, payload } = pairing.body as { code: string; expiresAt: number; link: string; payload: PairPayload };
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(expiresAt).toBeGreaterThan(Date.now() + PAIRING_TTL_MS - 5_000);
    expect(payload).toEqual({ v: 1, name: "Test Mac", port: 0, fp: s.runtime.tls.fingerprint, code, lan: ["192.168.1.5"], tailnet: ["100.101.102.103", "mac.tail1234.ts.net"], bonjour: "AgentSwitch on Test Mac", gate: { publicKey: KEY, keypair: "default" } });
    expect(JSON.parse(Buffer.from(link.slice(PAIR_LINK_PREFIX.length), "base64url").toString())).toEqual(payload);

    const ok = await call(s.port, "POST", "/pair", { json: { code: code.toLowerCase(), name: " Ada's iPhone ", platform: "ios" } });
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(["deviceId", "token"]);
    const token = String(ok.body.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call(s.port, "GET", "/me", { token })).body).toEqual({ deviceId: ok.body.deviceId, name: "Ada's iPhone", platform: "ios" });
    expect((await call(s.port, "GET", "/gate/pubkey", { token })).body).toEqual({ publicKey: KEY, keypair: "default" });

    const reuse = await call(s.port, "POST", "/pair", { json: { code, name: "thief", platform: "ios" } });
    expect(reuse.status).toBe(401);
    expect(reuse.body).toEqual(PAIR_FAILED);

    const devices = await s.local("GET", "/devices");
    expect(devices.body).toEqual([expect.objectContaining({ id: ok.body.deviceId, name: "Ada's iPhone", platform: "ios", revokedAt: null, online: true })]);
    expect(JSON.stringify(devices.body)).not.toContain(token);
    expect((await s.local("GET", "/remote/info")).body).toEqual({ enabled: true, port: 0, fingerprint: s.runtime.tls.fingerprint, name: "Test Mac", bonjour: "AgentSwitch on Test Mac", lan: ["192.168.1.5"], tailnet: ["100.101.102.103", "mac.tail1234.ts.net"], onlineDevices: 1 });
  });

  it("wrong, expired, voided or malformed: the same 401; too many attempts from one source: 429", async () => {
    let t = 1_000_000;
    const s = await remoteDaemon({ now: () => t });
    const bad = async (json: unknown) => {
      const r = await call(s.port, "POST", "/pair", { json });
      expect(r.status).toBe(401);
      expect(r.body).toEqual(PAIR_FAILED);
    };
    await bad({ code: "0000-0000", name: "x", platform: "ios" });   // no code issued yet
    const first = (await s.local("POST", "/pairing")).body.code as string;
    t += PAIRING_TTL_MS;
    await bad({ code: first, name: "x", platform: "ios" });           // expired
    const second = (await s.local("POST", "/pairing")).body.code as string;
    await bad({ code: second, platform: "ios" });                      // no name: nothing consumed, no strike
    await bad({ code: second, name: "\u0007bell", platform: "ios" });
    for (let i = 0; i < 4; i++) await bad({ code: second === "ZZZZ-ZZZZ" ? "YYYY-YYYY" : "ZZZZ-ZZZZ", name: "x", platform: "ios" });
    t += 61_000;   // new rate window; the code has 4 strikes and 1 attempt left
    await bad({ code: "not a code", name: "x", platform: "ios" });    // fifth wrong attempt voids it
    await bad({ code: second, name: "x", platform: "ios" });
    const bigName = await call(s.port, "POST", "/pair", { raw: { body: Buffer.alloc(8192, 97), type: "application/json" } });
    expect(bigName.status).toBe(401);

    t += 61_000;
    const third = (await s.local("POST", "/pairing")).body.code as string;
    for (let i = 0; i < PAIR_RATE_LIMIT; i++) await bad({ name: "x" });
    const limited = await call(s.port, "POST", "/pair", { json: { code: third, name: "x", platform: "ios" } });
    expect(limited.status).toBe(429);
    t += 61_000;
    expect((await call(s.port, "POST", "/pair", { json: { code: third, name: "late", platform: "ios" } })).status).toBe(200);   // the limit did not burn the code
  });

  it("only the allowlisted routes exist remotely; management routes exist only locally", async () => {
    const s = await remoteDaemon();
    const { token } = await pair(s);
    for (const [method, path] of [["GET", "/mcp"], ["GET", "/skills"], ["PUT", "/memory"], ["GET", "/memory"], ["GET", "/records"], ["GET", "/routing/log"], ["GET", "/approvals/policy"],
      ["POST", "/pairing"], ["GET", "/devices"], ["GET", "/remote/info"], ["GET", "/settings/models"], ["GET", "/ui"], ["GET", "/ui/app.js"], ["GET", "/"], ["POST", "/route/preview"],
      ["DELETE", "/mcp/x"], ["DELETE", "/platform-memory/x"], ["GET", "/platform-memory"], ["GET", "/tasks/%2e%2e/mcp"]] as const) {
      const withToken = await call(s.port, method, path, { token });
      expect(withToken.status, `${method} ${path}`).toBe(404);
      expect((await call(s.port, method, path)).status, `${method} ${path} without token`).toBe(404);
    }
    for (const path of ["/tasks", "/approvals", "/threads", "/quota", "/targets", "/context"]) expect((await call(s.port, "GET", path, { token })).status, path).toBe(200);
    expect((await call(s.port, "POST", "/quota/refresh", { token })).status).toBe(200);
    const upload = await call(s.port, "POST", "/uploads", { token, raw: { type: "multipart/form-data; boundary=b", body: Buffer.from('--b\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b--\r\n') } });
    expect(upload.status).toBe(200);
    expect((upload.body.files as unknown[]).length).toBe(1);
    // and the other way round: the phone's own routes are not on the local listener
    for (const [method, path] of [["POST", "/pair"], ["GET", "/me"], ["GET", "/gate/pubkey"]] as const) expect((await s.local(method, path)).status, `local ${method} ${path}`).toBe(404);
  });

  it("tasks over TLS: create, follow the SSE stream with the bearer header, read, rate, threads", async () => {
    const s = await remoteDaemon();
    const { token } = await pair(s);
    const created = await call(s.port, "POST", "/tasks", { token, json: { task: 'hello @echo {"delayMs":100,"result":"hi"}' } });
    expect(created.status).toBe(201);
    const id = String(created.body.id);
    const stream = await events(s.port, `/tasks/${id}/events`, token);
    expect(stream.status).toBe(200);
    expect(stream.types[0]).toBe("queued");
    expect(stream.types).toContain("done");
    const task = await call(s.port, "GET", `/tasks/${id}`, { token });
    expect(task.body).toMatchObject({ id, status: "done", result: "hi" });
    expect((await call(s.port, "POST", `/tasks/${id}/rate`, { token, json: { rating: 1 } })).body).toEqual({ ok: true });
    const threadId = String(task.body.threadId);
    expect((await call(s.port, "GET", `/threads/${threadId}`, { token })).status).toBe(200);
    expect((await call(s.port, "PATCH", `/threads/${threadId}`, { token, json: { title: "from the phone" } })).body).toMatchObject({ title: "from the phone" });
    expect((await call(s.port, "GET", `/tasks/${id}/files`, { token })).status).toBe(200);
    const replay = await events(s.port, `/tasks/${id}/events?after=2`, token);
    expect(replay.types).not.toContain("queued");
    expect((await events(s.port, `/tasks/${id}/events`, "bad-token-bad-token-bad")).status).toBe(401);
  });

  it("the phone edits CONTEXT.md under the same lint as the Mac", async () => {
    const s = await remoteDaemon();
    const { token } = await pair(s);
    const example = await call(s.port, "GET", "/context/example", { token });
    expect(example.status).toBe(200);
    expect(String(example.body.text).length).toBeGreaterThan(0);
    const text = "# 站点\n- 财务系统 https://fin.example.test\n  - 密码: FICTIONAL-plain-pass\n  - token: enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA\n";
    const saved = await call(s.port, "PUT", "/context", { token, json: { text } });
    expect(saved.status).toBe(200);
    expect((saved.body.warnings as string[]).join("\n")).toMatch(/line 3: "密码" value is not an enc:v1: token/);
    const read = await call(s.port, "GET", "/context", { token });
    expect(String(read.body.text)).toContain("https://fin.example.test");
    expect(String(read.body.text)).toContain("enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(read.text).not.toContain("FICTIONAL-plain-pass");
    expect((await call(s.port, "PUT", "/context", { token, json: {} })).status).toBe(400);
    expect((await call(s.port, "PUT", "/context", { json: { text: "x" } })).status).toBe(401);
  });

  it("the phone deletes tasks and threads with the Mac's semantics: finished only, gone afterwards", async () => {
    const s = await remoteDaemon();
    const { token } = await pair(s);
    const slow = await call(s.port, "POST", "/tasks", { token, json: { task: 'slow @echo {"delayMs":20000}' } });
    const slowId = String(slow.body.id);
    expect((await call(s.port, "DELETE", `/tasks/${slowId}`, { token })).status).toBe(409);   // still running
    await call(s.port, "POST", `/tasks/${slowId}/cancel`, { token });

    const first = await call(s.port, "POST", "/tasks", { token, json: { task: 'one @echo {"result":"a"}' } });
    await s.d.engine.idle();
    const firstId = String(first.body.id);
    const threadId = String((await call(s.port, "GET", `/tasks/${firstId}`, { token })).body.threadId);
    expect((await call(s.port, "DELETE", `/tasks/${firstId}`, { token })).body).toEqual({ ok: true });
    expect((await call(s.port, "GET", `/tasks/${firstId}`, { token })).status).toBe(404);
    expect((await call(s.port, "DELETE", `/tasks/${firstId}`, { token })).status).toBe(404);

    const second = await call(s.port, "POST", "/tasks", { token, json: { task: 'two @echo {"result":"b"}' } });
    await s.d.engine.idle();
    const secondThread = String((await call(s.port, "GET", `/tasks/${String(second.body.id)}`, { token })).body.threadId);
    expect((await call(s.port, "DELETE", `/threads/${secondThread}`, { token })).body).toEqual({ ok: true });
    expect((await call(s.port, "GET", `/threads/${secondThread}`, { token })).status).toBe(404);
    expect((await call(s.port, "GET", `/tasks/${String(second.body.id)}`, { token })).status).toBe(404);
    expect((await call(s.port, "DELETE", "/threads/nope", { token })).status).toBe(404);
    expect((await call(s.port, "DELETE", `/threads/${threadId}`)).status).toBe(401);
  });

  it("a phone cannot weaken the Mac's decisions: no approval override, cwd or ephemeral; PATCH /threads only renames", async () => {
    const s = await remoteDaemon();
    const { token } = await pair(s);
    const project = mkdtempSync(join(tmpdir(), "agentswitch-remote-proj-"));
    const refused = await call(s.port, "POST", "/tasks", { token, json: { task: "x", approval: { mode: "auto" } } });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toMatch(/approval cannot be set from a paired device/);
    expect((await call(s.port, "POST", "/tasks", { token, json: { task: "x", approval: {} } })).status).toBe(400);
    const cwd = await call(s.port, "POST", "/tasks", { token, json: { task: "x", cwd: project } });
    expect(cwd.status).toBe(400);
    expect(String(cwd.body.error)).toMatch(/cwd cannot be set from a paired device/);
    expect((await call(s.port, "POST", "/tasks", { token, json: { task: "x", ephemeral: true } })).status).toBe(400);
    expect(s.d.store.listTasks(10)).toEqual([]);

    const created = await call(s.port, "POST", "/tasks", { token, json: { task: 'hi @echo {"result":"hi"}' } });
    expect(created.status).toBe(201);
    await s.d.engine.idle();
    const threadId = String((await call(s.port, "GET", `/tasks/${String(created.body.id)}`, { token })).body.threadId);
    for (const patch of [{ expires_at: 0 }, { expires_at: null }, { title: "t", expires_at: Date.now() - 1 }]) {
      const res = await call(s.port, "PATCH", `/threads/${threadId}`, { token, json: patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(String(res.body.error)).toMatch(/expires_at cannot be set from a paired device/);
    }
    expect(s.d.store.getThread(threadId)).toMatchObject({ title: null, expiresAt: null });
    expect((await call(s.port, "PATCH", `/threads/${threadId}`, { token, json: { title: "renamed" } })).body).toMatchObject({ title: "renamed" });

    // The Mac itself is unchanged: its own requests may override approvals, pick a cwd and set an expiry.
    expect((await s.local("POST", "/tasks", { task: 'local @echo {"result":"ok"}', cwd: project, approval: { mode: "auto" } })).status).toBe(201);
    expect((await s.local("PATCH", `/threads/${threadId}`, { expires_at: 5 })).body).toMatchObject({ expiresAt: 5 });
    await s.d.engine.idle();
  });

  it("revoking a device cuts its open event stream at once", async () => {
    const s = await remoteDaemon();
    const { token, deviceId } = await pair(s);
    const created = await call(s.port, "POST", "/tasks", { token, json: { task: 'slow @echo {"delayMs":20000}' } });
    const id = String(created.body.id);
    let revokedAt = 0;
    const started = Date.now();
    const stream = events(s.port, `/tasks/${id}/events`, token, (type) => {
      if (type === "dispatched" && !revokedAt) { revokedAt = Date.now(); void s.local("DELETE", `/devices/${deviceId}`); }
    });
    const result = await stream;
    expect(revokedAt).toBeGreaterThan(0);
    expect(result.types).not.toContain("done");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await s.local("POST", `/tasks/${id}/cancel`)).status).toBe(200);
  });

  it("GET /gate/pubkey is 503 and the payload's gate is null when the gate key cannot be read", async () => {
    const s = await remoteDaemon({ gateKey: async () => null });
    const pairing = await s.local("POST", "/pairing");
    expect((pairing.body.payload as PairPayload).gate).toBeNull();
    const { token } = await pair(s);
    const r = await call(s.port, "GET", "/gate/pubkey", { token });
    expect(r.status).toBe(503);
  });

  it("the connection hook drops a socket from a refused source before any TLS", async () => {
    const listener = await listenRemote({ fetch: () => new Response("never"), tls: sharedTls(), port: 0, host: "127.0.0.1", allowSource: () => false });
    try {
      await expect(call(listener.port, "GET", "/healthz")).rejects.toThrow(/ECONNRESET|socket hang up|disconnected/);
    } finally {
      await listener.close();
    }
  });

  it("a taken port fails start-up with the port in the message", async () => {
    const s = await remoteDaemon();
    const clash = { ...s.runtime, port: s.port };
    await expect(startRemote(s.d, clash, "127.0.0.1")).rejects.toThrow(new RegExp(`remote listener on port ${s.port}: .*EADDRINUSE`));
  });
});

describe("remote app, in process", () => {
  it("re-checks the source per request: a peer outside the allowed networks gets 403 even past the socket hook", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-rapp-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const d = buildDaemon(cfg, { remote: null });
    const app = createRemoteApp({ store: d.store, pairing: new PairingDesk(), presence: new Presence(), gateKey: async () => null, local: d.api, log: () => undefined });
    const env = (remoteAddress: string | undefined) => ({ incoming: { socket: { remoteAddress } }, outgoing: undefined }) as never;
    expect((await app.request("/healthz", {}, env("203.0.113.7"))).status).toBe(403);
    expect((await app.request("/healthz", {}, env(undefined))).status).toBe(403);
    expect((await app.request("/healthz")).status).toBe(403);
    expect(await (await app.request("/healthz", {}, env("::ffff:10.0.0.2"))).json()).toEqual({ ok: true });
    d.close();
  });

  it("every write from a phone leaves a log line with the device; reads do not", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-rlog-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const d = buildDaemon(cfg, { remote: null });
    const lines: string[] = [];
    const app = createRemoteApp({ store: d.store, pairing: new PairingDesk(), presence: new Presence(), gateKey: async () => null, local: d.api, log: (l) => lines.push(l) });
    const { device, token } = registerDevice(d.store, { name: "iPhone", platform: "ios" });
    const env = { incoming: { socket: { remoteAddress: "192.168.1.9" } }, outgoing: undefined } as never;
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.request("/context", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ text: "# x\n" }) }, env)).status).toBe(200);
    expect((await app.request("/tasks/nope", { method: "DELETE", headers: auth }, env)).status).toBe(404);
    expect((await app.request("/tasks", { headers: auth }, env)).status).toBe(200);
    expect(lines).toEqual([`remote: device ${device.id} PUT /context → 200`, `remote: device ${device.id} DELETE /tasks/nope → 404`]);
    d.close();
  });

  it("with remote access off the local routes say so and nothing can pair", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-roff-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const d = buildDaemon(cfg);
    expect(d.remote).toBeNull();
    expect(await (await d.app.request("/remote/info")).json()).toEqual({ enabled: false, port: null, fingerprint: null, name: null, bonjour: null, lan: [], tailnet: [], onlineDevices: 0 });
    const pairing = await d.app.request("/pairing", { method: "POST" });
    expect(pairing.status).toBe(409);
    expect(await (await d.app.request("/devices")).json()).toEqual([]);
    // the API itself is unchanged on the local listener
    expect(await (await d.app.request("/healthz")).json()).toMatchObject({ ok: true, version: "0.1.0" });
    expect((await d.app.request("/ui")).status).toBe(200);
    d.close();
  });
});
