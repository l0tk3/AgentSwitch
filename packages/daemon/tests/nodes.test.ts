/** docs/mesh-v0.md end to end: two nodes, each a daemon with its own certificate and a real HTTPS listener on
 *  127.0.0.1, paired through a link as two Macs would be. Echo router and executors only. */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NODE_ERROR_HEADER, NODE_HEADER } from "../src/api/nodes.js";
import { localRefusal } from "../src/api/localGuard.js";
import { buildDaemon, startRemote, type Daemon, type DaemonConfig } from "../src/daemon.js";
import { NodeBook, NODES_KEY_HEADER, rememberLan, type Peer } from "../src/nodes/book.js";
import { dialable, Dialer, PinMismatch } from "../src/nodes/dial.js";
import { nodePlatform } from "../src/nodes/nodes.js";
import { PAIR_LINK_PREFIX, PairingDesk, parsePairLink, type PairPayload } from "../src/remote/pairing.js";
import { remoteRuntime, type RemoteRuntime } from "../src/remote/runtime.js";
import type { RemoteListener } from "../src/remote/server.js";
import { ensureTls, SYSTEM_OPENSSL } from "../src/remote/tls.js";
import type { Launcher } from "../src/terminals/host.js";
import { TARGETS_PATH, workDir } from "./helpers.js";

const KEY = Buffer.alloc(32, 9).toString("base64url");
type Json = Record<string, unknown>;
type Answer = { readonly status: number; readonly body: Json; readonly headers: Headers };

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
});

type TestNode = {
  readonly name: string; readonly home: string; readonly d: Daemon; readonly runtime: RemoteRuntime; readonly listener: RemoteListener;
  /** A request on this node's own listener, as its Mac app would make it (the nodes key shown unless `key: false`). */
  readonly local: (method: string, path: string, json?: unknown, opts?: { key?: boolean }) => Promise<Answer>;
  readonly raw: (method: string, path: string, init?: RequestInit) => Promise<Response>;
};
const open: TestNode[] = [];

/** A terminal's program that prints a line and waits (no agent). */
const fakeLauncher: Launcher = () => ({ file: process.execPath, args: ["-e", "console.log('hi from studio'); setInterval(() => {}, 1000)"], env: process.env as Record<string, string>, hooks: false });

async function node(name: string, terminals = false): Promise<TestNode> {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-node-"));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, opencodeBinary: "" };
  const runtime = remoteRuntime({
    home, port: await freePort(), name, gate: () => null, tls: ensureTls(join(home, "remote")),
    addresses: async () => ({ lan: ["127.0.0.1"], tailnet: [] }), gateKey: async () => ({ publicKey: KEY, keypair: "default" }),
  });
  const d = buildDaemon(cfg, { remote: runtime, ...(terminals ? { terminalLauncher: fakeLauncher } : {}) });
  const listener = await startRemote(d, runtime, "127.0.0.1");
  const key = readFileSync(join(home, "nodes", "key"), "utf8").trim();
  const raw = async (method: string, path: string, init: RequestInit = {}): Promise<Response> => d.app.request(path, { method, ...init, headers: { [NODES_KEY_HEADER]: key, ...(init.headers as Record<string, string> | undefined) } });
  const local = async (method: string, path: string, json?: unknown, opts: { key?: boolean } = {}): Promise<Answer> => {
    const res = await d.app.request(path, { method, headers: { ...(opts.key === false ? {} : { [NODES_KEY_HEADER]: key }), ...(json !== undefined ? { "content-type": "application/json" } : {}) }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
    return { status: res.status, body: await res.json().catch(() => ({})) as Json, headers: res.headers };
  };
  const made = { name, home, d, runtime, listener, local, raw };
  open.push(made);
  return made;
}

/** `to` shows a pairing code and `from` pastes its link: `from` uses `to`, and `to` uses `from` back unless told not. */
async function pair(from: TestNode, to: TestNode, opts: { issue?: unknown; back?: boolean } = {}): Promise<Answer> {
  const shown = await to.local("POST", "/pairing", opts.issue);
  expect(shown.status).toBe(200);
  return from.local("POST", "/nodes", { link: shown.body.link, ...(opts.back !== undefined ? { back: opts.back } : {}) });
}

const nodesOf = async (n: TestNode) => ((await n.local("GET", "/nodes")).body.nodes as (Json & { id: string })[]);
const devicesOf = async (n: TestNode) => (await (await n.d.app.request("/devices")).json()) as (Json & { id: string })[];

afterEach(async () => {
  for (const n of open.splice(0)) { await n.listener.close(); n.d.close(); }
});

describe.runIf(existsSync(SYSTEM_OPENSSL))("two nodes", () => {
  it("pair once and each uses the other: one pairing, two directions", async () => {
    const [a, b] = [await node("Studio"), await node("Laptop")];
    const paired = await pair(b, a);
    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({ ok: true, back: "paired", node: { name: "Studio", fingerprint: a.runtime.tls.fingerprint, port: a.runtime.port } });
    expect(JSON.stringify(paired.body)).not.toContain("token");

    // Each is a device in the other's list, and a node in its own book; the two directions name each other.
    const [inA, inB] = [await devicesOf(a), await devicesOf(b)];
    expect(inA).toMatchObject([{ name: "Laptop", platform: nodePlatform(), revokedAt: null }]);
    expect(inB).toMatchObject([{ name: "Studio", platform: nodePlatform(), revokedAt: null }]);
    const [fromB, fromA] = [await nodesOf(b), await nodesOf(a)];
    expect(fromB).toMatchObject([{ name: "Studio", state: "online", address: "127.0.0.1", waiting: 0, deviceId: inA[0]!.id, inbound: inB[0]!.id }]);
    expect(fromA).toMatchObject([{ name: "Laptop", state: "online", address: "127.0.0.1", deviceId: inB[0]!.id, inbound: inA[0]!.id }]);
    expect((await a.local("GET", "/nodes")).body.self).toMatchObject({ name: "Studio", kind: process.platform === "darwin" ? "mac" : "linux", fingerprint: a.runtime.tls.fingerprint, listening: true });
    // The tokens are on disk for this node alone, and never in an answer.
    const file = join(b.home, "nodes", "peers.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(b.home, "nodes")).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(fromB)).not.toContain((JSON.parse(readFileSync(file, "utf8")) as { peers: Peer[] }).peers[0]!.token);
    // The code on the first node's screen is used; the ticket for the way back is gone too.
    expect(a.runtime.pairing.current()).toBeNull();
    // Pairing again replaces: one node in each book, and the devices of the first pairing are removed on both sides.
    expect((await pair(b, a)).status).toBe(200);
    expect(await nodesOf(b)).toHaveLength(1);
    expect(await nodesOf(a)).toHaveLength(1);
    for (const n of [a, b]) expect((await devicesOf(n)).map((d) => d.revokedAt === null)).toEqual([true, false]);
  });

  it("`/nodes/<id>/<route>` is the other node's route: answers, an event stream, its own refusals", async () => {
    const [a, b] = [await node("Studio", true), await node("Laptop")];
    await pair(b, a);
    const id = (await nodesOf(b))[0]!.id;
    // Who the other node takes this one for, and what it says of itself.
    const me = await b.local("GET", `/nodes/${id}/me`);
    expect(me.body).toMatchObject({ name: "Laptop", platform: nodePlatform() });
    expect(me.headers.get(NODE_HEADER)).toBe(id);
    // Studio has terminals, and so the dispatch desk; Laptop has neither.
    expect((await b.local("GET", `/nodes/${id}/node`)).body).toMatchObject({ name: "Studio", has: expect.arrayContaining(["dispatch", "terminals", "keyboard", "files"]) });
    expect((await a.local("GET", `/nodes/${(await nodesOf(a))[0]!.id}/node`)).body.has).not.toContain("dispatch");
    expect((await b.local("GET", "/nodes/Studio/me")).status).toBe(200);   // by name, while one node has it
    expect((await b.local("GET", "/nodes/studio/sessions/folders?x=1")).status).toBe(404);   // the route and its query went through: the other node watches no sessions
    expect((await b.local("GET", "/nodes/studio/rooms")).body).toEqual({ rooms: [] });
    // A terminal started there from here, and its stream followed through this node.
    const created = await b.local("POST", `/nodes/${id}/terminals`, { harness: "claude-code", cwd: workDir() });
    expect(created.status).toBe(201);
    const terminalId = String((created.body.terminal as { id: string }).id);
    expect(a.d.terminals!.get(terminalId)).toBeDefined();
    expect(b.d.terminals).toBeNull();
    const stream = await b.raw("GET", `/nodes/${id}/terminals/${terminalId}/stream`, { headers: { accept: "text/event-stream" } });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    let text = "";
    while (!text.includes("\n\n")) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    await reader.cancel();
    expect(text).toMatch(/^(event|data|id): /m);
    a.d.terminals!.closeAll();
    // The local token of this node is not what the other one is shown.
    const seen = await b.raw("GET", `/nodes/${id}/me`, { headers: { authorization: "Bearer this-nodes-own-local-token-stays-here-0000" } });
    expect(seen.status).toBe(200);
    // What a paired node may not reach there, it may not reach through here: the other node's list says so.
    const off = await b.local("GET", `/nodes/${id}/devices`);
    expect(off.status).toBe(404);
    expect(off.headers.get(NODE_HEADER)).toBe(id);
    expect((await b.local("POST", `/nodes/${id}/pairing`)).status).toBe(404);
    expect((await b.local("GET", `/nodes/${id}/nodes`)).status).toBe(404);   // no going on to a third node
    expect((await b.local("GET", "/nodes/0000deadbeef/me")).status).toBe(404);
  });

  it("pairing, removing and using a node take the nodes key; listing does not", async () => {
    const [a, b] = [await node("Studio"), await node("Laptop")];
    const shown = await a.local("POST", "/pairing");
    expect((await b.local("POST", "/nodes", { link: shown.body.link }, { key: false })).status).toBe(403);
    expect(a.runtime.pairing.current()).not.toBeNull();   // nothing was sent
    expect((await b.local("POST", "/nodes", { link: shown.body.link })).status).toBe(200);
    const id = (await nodesOf(b))[0]!.id;
    expect((await b.local("GET", `/nodes/${id}/me`, undefined, { key: false })).status).toBe(403);
    expect((await b.local("DELETE", `/nodes/${id}`, undefined, { key: false })).status).toBe(403);
    expect((await b.local("GET", "/nodes", undefined, { key: false })).status).toBe(200);
    expect((await b.raw("GET", `/nodes/${id}/me`, { headers: { [NODES_KEY_HEADER]: "not-the-key-not-the-key-not-the-key-not-the" } })).status).toBe(403);
  });

  it("one way when either side says so", async () => {
    const [a, b, c] = [await node("Mac Studio"), await node("Laptop"), await node("Mini")];
    // The node that pastes the link does not offer itself.
    expect((await pair(b, a, { back: false })).body).toMatchObject({ ok: true, back: "none" });
    expect(await nodesOf(a)).toEqual([]);
    expect(await devicesOf(b)).toEqual([]);
    expect(await nodesOf(b)).toMatchObject([{ name: "Mac Studio", inbound: null }]);
    // A name with a space in it names the node in a path as well as its id does.
    expect((await b.local("GET", "/nodes/Mac%20Studio/me?x=1")).body).toMatchObject({ name: "Laptop" });
    // The node that shows the code does not take the way back.
    expect((await pair(c, a, { issue: { back: false } })).body).toMatchObject({ ok: true, back: "declined" });
    expect(await nodesOf(a)).toEqual([]);
    expect(await devicesOf(c)).toEqual([]);
    expect(c.runtime.pairing.take("0000-0000")).toBeNull();
  });

  it("removing a node tells it, so no device that will never come back stays in its list; the other direction is its own", async () => {
    const [a, b] = [await node("Studio"), await node("Laptop")];
    await pair(b, a);
    const id = (await nodesOf(b))[0]!.id;
    const removed = await b.local("DELETE", `/nodes/${id}`);
    expect(removed.body).toMatchObject({ ok: true, told: true, inboundRevoked: false, node: { name: "Studio" } });
    expect(await nodesOf(b)).toEqual([]);
    expect((await devicesOf(a))[0]!.revokedAt).not.toBeNull();
    // The first node still uses the second, and no longer shows it as using this one.
    expect(await nodesOf(a)).toMatchObject([{ name: "Laptop", state: "online", inbound: null }]);
    expect((await devicesOf(b))[0]!.revokedAt).toBeNull();
    // Both directions at once, from the other side.
    const aId = (await nodesOf(a))[0]!.id;
    await pair(b, a);
    expect((await a.local("DELETE", `/nodes/${aId}?both=1`)).body).toMatchObject({ ok: true, told: true, inboundRevoked: true });
    expect((await devicesOf(a)).every((d) => d.revokedAt !== null)).toBe(true);
    expect((await devicesOf(b)).every((d) => d.revokedAt !== null)).toBe(true);
    // The second node is told by the first answer it gets: the pair is over there.
    const left = (await nodesOf(b))[0]!;
    expect(left.state).toBe("revoked");
    const refused = await b.local("GET", `/nodes/${left.id}/me`);
    expect(refused.status).toBe(401);
    expect(refused.headers.get(NODE_ERROR_HEADER)).toBe("revoked");
    expect((await a.local("DELETE", "/nodes/nope")).status).toBe(404);
  });

  it("a device revoked in the list is a node that no longer uses this one", async () => {
    const [a, b] = [await node("Studio"), await node("Laptop")];
    await pair(b, a);
    const device = (await devicesOf(a))[0]!.id;
    expect((await a.d.app.request(`/devices/${device}`, { method: "DELETE" })).status).toBe(200);
    expect(await nodesOf(a)).toMatchObject([{ name: "Laptop", inbound: null, state: "online" }]);
    expect((await nodesOf(b))[0]!.state).toBe("revoked");
  });

  it("refuses what is not a link, its own link, a node it cannot reach and a certificate that is not the link's", async () => {
    const [a, b] = [await node("Studio"), await node("Laptop")];
    expect((await b.local("POST", "/nodes", { link: "https://example.com" })).status).toBe(400);
    expect((await b.local("POST", "/nodes", {})).status).toBe(400);
    const own = await b.local("POST", "/pairing");
    expect((await b.local("POST", "/nodes", { link: own.body.link })).body).toEqual({ error: "this is this node's own pairing link" });
    const shown = await a.local("POST", "/pairing");
    const payload = shown.body.payload as PairPayload;
    const link = (p: object) => PAIR_LINK_PREFIX + Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
    // Somebody else's certificate at the link's address: nothing is sent to it, the code stays good.
    const wrongPin = await b.local("POST", "/nodes", { link: link({ ...payload, fp: "ab".repeat(32) }) });
    expect(wrongPin.status).toBe(502);
    expect(String(wrongPin.body.error)).toContain("not the one this node was paired with");
    expect(a.runtime.pairing.current()).not.toBeNull();
    expect(await devicesOf(a)).toEqual([]);
    // Nowhere this node may dial, and nothing listening.
    expect((await b.local("POST", "/nodes", { link: link({ ...payload, lan: ["203.0.113.9"], tailnet: [] }) })).status).toBe(502);
    expect((await b.local("POST", "/nodes", { link: link({ ...payload, port: await freePort() }) })).status).toBe(502);
    // A wrong code is the other node's to refuse.
    const wrongCode = await b.local("POST", "/nodes", { link: link({ ...payload, code: "0000-0000" }) });
    expect(wrongCode.status).toBe(401);
    expect(await nodesOf(b)).toEqual([]);
    expect(b.runtime.pairing.take("0000-0000")).toBeNull();   // its ticket for the way back did not outlive the attempt
  });

  it("a node that stopped answering is offline, and a request to it says so", async () => {
    const [a, b] = [await node("Studio"), await node("Laptop")];
    await pair(b, a, { back: false });
    const id = (await nodesOf(b))[0]!.id;
    await a.listener.close();
    b.d.nodes.dialer.close();   // the kept sockets and the remembered address, as after a while
    const gone = await b.local("GET", `/nodes/${id}/me`);
    expect(gone.status).toBe(502);
    expect(gone.headers.get(NODE_ERROR_HEADER)).toBe("unreachable");
    expect(gone.body.node).toBe(id);
  });
});

describe("the pinned connection", () => {
  it.runIf(existsSync(SYSTEM_OPENSSL))("gives HTTP no socket whose certificate is not the pinned one", async () => {
    const a = await node("Studio");
    const dialer = new Dialer();
    const there = { host: "127.0.0.1", port: a.runtime.port };
    expect((await dialer.json({ ...there, fingerprint: a.runtime.tls.fingerprint }, "GET", "/healthz")).body).toEqual({ ok: true });
    await expect(dialer.json({ ...there, fingerprint: "cd".repeat(32) }, "POST", "/pair", { json: { code: "x", name: "n", platform: "p" } })).rejects.toBeInstanceOf(PinMismatch);
    await expect(dialer.send({ host: "203.0.113.9", port: 1, fingerprint: "cd".repeat(32) }, { method: "GET", path: "/" })).rejects.toThrow("not an address a node can be at");
    dialer.close();
  });

  // 2026-10-11, user: 粘贴图片有的时候卡半天. A file sent into a link that went quiet without closing waited the whole of
  // its 120 s (scripts/mesh_upload_probe.ts): what is sent may take as long as it keeps moving, and no longer.
  describe.runIf(existsSync(SYSTEM_OPENSSL))("a body sent as a stream", () => {
    type Handler = (req: IncomingMessage, res: ServerResponse) => void;
    const servers: HttpsServer[] = [];
    const folders: string[] = [];
    afterEach(() => {
      for (const s of servers.splice(0)) { s.close(); s.closeAllConnections(); }
      for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    async function listening(handler: Handler) {
      const dir = mkdtempSync(join(tmpdir(), "agentswitch-dial-"));
      folders.push(dir);
      const tls = ensureTls(dir);
      const server = createHttpsServer({ key: tls.key, cert: tls.cert }, handler);
      servers.push(server);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      return { host: "127.0.0.1", port: (server.address() as AddressInfo).port, fingerprint: tls.fingerprint };
    }
    const megabytes = (n: number) => Readable.from((function* () { const chunk = Buffer.alloc(1024 * 1024, 7); for (let i = 0; i < n; i++) yield chunk; })());

    it("is given up once the connection takes nothing more of it, long before the head's own wait", async () => {
      // The other side never reads: what the system will buffer goes, then nothing moves.
      const there = await listening(() => undefined);
      const dialer = new Dialer();
      const began = Date.now();
      await expect(dialer.send(there, { method: "POST", path: "/uploads", body: megabytes(2048), headTimeoutMs: 60_000, stallTimeoutMs: 400 })).rejects.toThrow("took nothing more of what was sent for 400 ms");
      expect(Date.now() - began).toBeLessThan(15_000);
      dialer.close();
    }, 30_000);

    it("has its answer's own wait from its last byte", async () => {
      const there = await listening((req) => { req.resume(); });   // all of it read, never answered
      const dialer = new Dialer();
      const began = Date.now();
      await expect(dialer.send(there, { method: "POST", path: "/uploads", body: megabytes(2), headTimeoutMs: 60_000, stallTimeoutMs: 5_000, answerTimeoutMs: 400 })).rejects.toThrow("within 400 ms of the last of what was sent");
      expect(Date.now() - began).toBeLessThan(10_000);
      dialer.close();
    }, 30_000);

    it("goes through while it keeps moving, however long the whole takes, and with an answer that takes its time", async () => {
      // Read in bursts with a pause after every 4 MB, answered half a second after the last byte: longer in all than
      // the wait for standing still, never standing still that long.
      let got = 0, burst = 0;
      const there = await listening((req, res) => {
        req.on("data", (chunk: Buffer) => {
          got += chunk.length;
          burst += chunk.length;
          if (burst >= 4 * 1024 * 1024) { burst = 0; req.pause(); setTimeout(() => req.resume(), 120); }
        });
        req.on("end", () => setTimeout(() => res.end(JSON.stringify({ got })), 500));
      });
      const dialer = new Dialer();
      const began = Date.now();
      const res = await dialer.send(there, { method: "POST", path: "/uploads", body: megabytes(48), headTimeoutMs: 60_000, stallTimeoutMs: 1_000, answerTimeoutMs: 5_000 });
      let said = "";
      for await (const chunk of res as AsyncIterable<Buffer>) said += chunk.toString("utf8");
      expect(JSON.parse(said)).toEqual({ got: 48 * 1024 * 1024 });
      expect(Date.now() - began).toBeGreaterThan(1_000);
      dialer.close();
    }, 30_000);
  });

  it("dials private, link-local, Tailscale and loopback addresses and Tailscale names, nothing else", () => {
    for (const ok of ["192.168.1.5", "10.0.0.2", "172.20.1.1", "100.101.102.103", "127.0.0.1", "169.254.1.2", "fd7a:115c:a1e0::1", "mac.tail1234.ts.net"]) expect(dialable(ok), ok).toBe(true);
    for (const no of ["8.8.8.8", "203.0.113.9", "example.com", "ts.net", "evil.ts.net.example.com", "localhost", "", "2001:db8::1"]) expect(dialable(no), no).toBe(false);
  });
});

describe("pairing between nodes: the desk and the link", () => {
  it("a ticket is redeemed beside the code on the screen, once, and does not void it", () => {
    let now = 1_000;
    const desk = new PairingDesk({ now: () => now });
    const shown = desk.issue();
    const ticket = desk.issueTicket();
    expect(ticket.code).not.toBe(shown.code);
    expect(desk.take(ticket.code)).toEqual({ kind: "ticket" });
    expect(desk.take(ticket.code)).toBeNull();           // once; and that was a strike against the code on the screen
    expect(desk.current()).toEqual(shown);
    expect(desk.take(shown.code)).toEqual({ kind: "code", back: true });
    expect(desk.issue({ back: false }).code).toBeTruthy();
    expect(desk.take(desk.current()!.code)).toEqual({ kind: "code", back: false });
    const late = desk.issueTicket();
    now += 5 * 60_000;
    expect(desk.take(late.code)).toBeNull();
    const voided = desk.issueTicket();
    desk.voidTicket(voided.code);
    expect(desk.redeem(voided.code)).toBe("rejected");
  });

  it("reads a pairing link, and nothing that only looks like one", () => {
    const payload = { v: 1, name: "Studio", port: 4713, fp: "ab".repeat(32), code: "K7QD-2M9F", lan: ["192.168.1.5"], tailnet: ["studio.tail1234.ts.net"], bonjour: "AgentSwitch on Studio", gate: { publicKey: KEY, keypair: "default" } };
    const link = (p: unknown) => PAIR_LINK_PREFIX + Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
    expect(parsePairLink(`  ${link(payload)}\n`)).toEqual(payload);
    expect(parsePairLink(link({ ...payload, gate: null }))).toMatchObject({ gate: null });
    for (const bad of [{ ...payload, v: 2 }, { ...payload, fp: "xyz" }, { ...payload, port: 0 }, { ...payload, lan: ["a b"] }, { ...payload, lan: ["-oProxyCommand=x"] }, { ...payload, name: "" }, "text"]) expect(parsePairLink(link(bad)), JSON.stringify(bad)).toBeNull();
    expect(parsePairLink("agentswitch://pair?p=%%%")).toBeNull();
    expect(parsePairLink("https://example.com/?p=abc")).toBeNull();
  });
});

describe("the book of nodes", () => {
  const peer = (fp: string, more: Partial<Peer> = {}): Omit<Peer, "id"> => ({ name: "Studio", kind: null, port: 4713, fingerprint: fp, lan: ["192.168.1.5"], tailnet: [], last: null, gate: null, deviceId: "d1", token: "t".repeat(43), pairedAt: 1, inbound: null, ...more });

  it("keeps a node by its certificate, survives a restart, and has one key", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "agentswitch-book-")), "nodes");
    const book = new NodeBook(dir);
    const first = book.put(peer("ab".repeat(32), { inbound: "dev-in" }));
    expect(first.id).toBe("abababababab");
    // The same certificate paired again: the same node, its new token, the other direction kept.
    const again = book.put(peer("ab".repeat(32), { token: "u".repeat(43), deviceId: "d2" }));
    expect(book.list()).toEqual([{ ...again, id: first.id, inbound: "dev-in" }]);
    // Another certificate that starts the same gets a longer name.
    expect(book.put(peer("abababababab" + "cd".repeat(26), { name: "Mini" })).id).toBe("ababababababcdcd");
    expect(book.get("studio")?.id).toBe(first.id);
    book.inboundGone("dev-in");
    expect(book.get(first.id)?.inbound).toBeNull();
    const reopened = new NodeBook(dir);
    expect(reopened.list()).toEqual(book.list());
    const key = readFileSync(join(dir, "key"), "utf8").trim();
    expect(reopened.holdsKey(key)).toBe(true);
    expect(reopened.holdsKey(`${key}x`)).toBe(false);
    expect(reopened.holdsKey(undefined)).toBe(false);
    expect(statSync(join(dir, "key")).mode & 0o777).toBe(0o600);
    expect(reopened.remove(first.id)?.name).toBe("Studio");
    expect(new NodeBook(dir).list().map((p) => p.name)).toEqual(["Mini"]);
  });

  it("remembers where a node was: its addresses now first, the earlier ones behind", () => {
    expect(rememberLan(["10.0.0.9"], ["192.168.1.5", "10.0.0.9"])).toEqual(["10.0.0.9", "192.168.1.5"]);
    expect(rememberLan([], ["192.168.1.5"])).toEqual(["192.168.1.5"]);
    expect(rememberLan(["a"], ["b", "c", "d", "e", "f", "g", "h", "i"])).toHaveLength(8);
  });
});

describe("the local guard", () => {
  it("lets a multipart upload through to another node's /uploads, and nowhere else", () => {
    const req = (path: string) => ({ method: "POST", path, host: "127.0.0.1:4711", origin: undefined, contentType: "multipart/form-data; boundary=x", hasBody: true });
    expect(localRefusal(req("/uploads"), 4711)).toBeNull();
    expect(localRefusal(req("/nodes/abababababab/uploads"), 4711)).toBeNull();
    expect(localRefusal(req("/nodes/abababababab/rooms"), 4711)?.status).toBe(415);
    expect(localRefusal(req("/nodes/a/b/uploads"), 4711)?.status).toBe(415);
  });
});
