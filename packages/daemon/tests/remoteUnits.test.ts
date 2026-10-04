/** app-v0 §2 building blocks without a listener: source predicate and connection hook, LAN and Tailscale discovery,
 *  pairing codes, payload and link, gate key parsing, device tokens and presence, the route allowlist. */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/engine/store.js";
import { guardConnection, isAllowedSource, lanAddresses, normalizeAddress } from "../src/remote/address.js";
import { authenticate, hashToken, LAST_SEEN_THROTTLE_MS, newToken, ONLINE_WINDOW_MS, Presence, registerDevice } from "../src/remote/devices.js";
import { currentKey, gateKeyReader } from "../src/remote/gateKey.js";
import { CROCKFORD, formatCode, MAX_WRONG_ATTEMPTS, normalizeCode, PAIR_LINK_PREFIX, PAIR_RATE_LIMIT, PAIR_RATE_WINDOW_MS, pairPayload, PairingDesk, PAIRING_TTL_MS } from "../src/remote/pairing.js";
import { REMOTE_ROUTES, remoteAllowed } from "../src/remote/routes.js";
import { macName } from "../src/remote/runtime.js";
import { parseIps, parseStatus, tailnetAddresses, tailscaleBin } from "../src/remote/tailscale.js";

const KEY = Buffer.alloc(32, 7).toString("base64url");

function memStore(now?: () => number): Store {
  return new Store({ dbPath: ":memory:", ...(now ? { now } : {}) });
}

describe("remote source addresses", () => {
  it("accepts loopback, private, link-local, Tailscale and ULA sources, in every spelling a socket reports", () => {
    for (const a of ["127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.5", "169.254.10.10", "100.64.0.1", "100.101.102.103", "100.127.255.255",
      "::1", "fd7a:115c:a1e0::d001:ef2d", "fc00::1", "FD00::ABCD", "fe80::1", "fe80::1%en0", "::ffff:192.168.1.5", "::FFFF:10.0.0.2", "::ffff:127.0.0.1"]) {
      expect(isAllowedSource(a), a).toBe(true);
    }
  });

  it("rejects public, CGNAT-adjacent, multicast and garbage sources", () => {
    for (const a of ["8.8.8.8", "172.32.0.1", "172.15.255.255", "192.169.0.1", "100.63.255.255", "100.128.0.1", "11.0.0.1", "1.1.1.1", "2001:db8::1", "2606:4700::1111",
      "::ffff:8.8.8.8", "ff02::1", "224.0.0.1", "0.0.0.0", "::", "", "not-an-ip", undefined, null]) {
      expect(isAllowedSource(a), String(a)).toBe(false);
    }
  });

  it("normalizes mapped IPv4 and zones, and gives up on nonsense", () => {
    expect(normalizeAddress("::ffff:10.0.0.2")).toEqual({ address: "10.0.0.2", type: "ipv4" });
    expect(normalizeAddress("FE80::1%utun3")).toEqual({ address: "fe80::1", type: "ipv6" });
    expect(normalizeAddress("999.1.1.1")).toBeNull();
    expect(normalizeAddress(undefined)).toBeNull();
  });

  it("the connection hook destroys a socket from outside and keeps one from inside", () => {
    const outside = { remoteAddress: "203.0.113.9", destroy: vi.fn() };
    const inside = { remoteAddress: "::ffff:192.168.1.20", destroy: vi.fn() };
    const unknown = { remoteAddress: undefined, destroy: vi.fn() };
    expect(guardConnection(outside)).toBe(false);
    expect(outside.destroy).toHaveBeenCalledOnce();
    expect(guardConnection(inside)).toBe(true);
    expect(inside.destroy).not.toHaveBeenCalled();
    expect(guardConnection(unknown)).toBe(false);
    expect(unknown.destroy).toHaveBeenCalledOnce();
    const narrowed = { remoteAddress: "127.0.0.1", destroy: vi.fn() };
    expect(guardConnection(narrowed, () => false)).toBe(false);
    expect(narrowed.destroy).toHaveBeenCalledOnce();
  });

  it("LAN addresses are the RFC 1918 IPv4 ones that are not internal, deduplicated", () => {
    const iface = (address: string, family: "IPv4" | "IPv6", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null }) as never;
    const table = {
      lo0: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
      en0: [iface("192.168.1.5", "IPv4"), iface("fe80::1", "IPv6")],
      en1: [iface("10.0.0.7", "IPv4"), iface("192.168.1.5", "IPv4")],
      utun4: [iface("100.101.102.103", "IPv4")],
      bridge: [iface("169.254.3.3", "IPv4"), iface("172.20.0.1", "IPv4"), iface("8.8.4.4", "IPv4")],
      none: undefined,
    };
    expect(lanAddresses(table)).toEqual(["192.168.1.5", "10.0.0.7", "172.20.0.1"]);
    expect(Array.isArray(lanAddresses())).toBe(true);
  });
});

describe("Tailscale discovery", () => {
  const status = (state: string, dns: string) => JSON.stringify({ BackendState: state, Self: { DNSName: dns, TailscaleIPs: ["100.101.102.103"] } });

  it("parses status and ip output", () => {
    expect(parseStatus(status("Running", "mac.tail1234.ts.net."))).toEqual({ running: true, dnsName: "mac.tail1234.ts.net" });
    expect(parseStatus(status("NeedsLogin", "mac.tail1234.ts.net."))).toEqual({ running: false, dnsName: null });
    expect(parseStatus(status("Running", ""))).toEqual({ running: true, dnsName: null });
    expect(parseStatus("not json")).toEqual({ running: false, dnsName: null });
    expect(parseIps("100.101.102.103\n\nfd7a::1\n")).toEqual(["100.101.102.103"]);
  });

  it("IPs then the MagicDNS name while logged in; [] when absent, logged out or failing", async () => {
    const running = async (_bin: string, args: readonly string[]) => (args[0] === "status" ? status("Running", "mac.tail1234.ts.net.") : "100.101.102.103\n");
    expect(await tailnetAddresses("/x/tailscale", running)).toEqual(["100.101.102.103", "mac.tail1234.ts.net"]);
    expect(await tailnetAddresses(null, running)).toEqual([]);
    expect(await tailnetAddresses("/x/tailscale", async () => status("Stopped", ""))).toEqual([]);
    expect(await tailnetAddresses("/x/tailscale", async () => { throw new Error("not logged in"); })).toEqual([]);
    const ipFails = async (_bin: string, args: readonly string[]) => { if (args[0] === "ip") throw new Error("exit 1"); return status("Running", "m.ts.net."); };
    expect(await tailnetAddresses("/x/tailscale", ipFails)).toEqual(["m.ts.net"]);
  });

  it("finds the CLI on PATH first, else the app bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-ts-"));
    const bin = join(dir, "tailscale");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(tailscaleBin({ PATH: dir }, "/nowhere", () => true)).toBe(bin);
    expect(tailscaleBin({ PATH: "/nonexistent" }, "/Apps/Tailscale", (p) => p === "/Apps/Tailscale")).toBe("/Apps/Tailscale");
    expect(tailscaleBin({ PATH: "/nonexistent" }, "/Apps/Tailscale", () => false)).toBeNull();
  });
});

describe("pairing codes", () => {
  const clock = (start = 1_000_000) => { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

  it("8 Crockford symbols shown as XXXX-XXXX; input is normalized the Crockford way", () => {
    const desk = new PairingDesk();
    const { code, expiresAt } = desk.issue();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(expiresAt).toBeGreaterThan(Date.now() + PAIRING_TTL_MS - 5_000);
    expect(CROCKFORD).toHaveLength(32);
    expect(formatCode("ABCD1234")).toBe("ABCD-1234");
    expect(normalizeCode("abcd-o1il")).toBe("ABCD0111");
    expect(normalizeCode(" ab cd 12 34 ")).toBe("ABCD1234");
    expect(normalizeCode("ABCD-123")).toBeNull();
    expect(normalizeCode("ABCD-123U")).toBeNull();   // U is not in the alphabet
  });

  it("single use, entered in any case or spacing", () => {
    const desk = new PairingDesk();
    const { code } = desk.issue();
    expect(desk.current()?.code).toBe(code);
    expect(desk.redeem(code.toLowerCase().replace("-", " "))).toBe("ok");
    expect(desk.current()).toBeNull();
    expect(desk.redeem(code)).toBe("rejected");
  });

  it("expires after 5 minutes", () => {
    const c = clock();
    const desk = new PairingDesk({ now: c.now });
    const { code, expiresAt } = desk.issue();
    expect(expiresAt).toBe(c.now() + PAIRING_TTL_MS);
    c.advance(PAIRING_TTL_MS);
    expect(desk.current()).toBeNull();
    expect(desk.redeem(code)).toBe("rejected");
  });

  it("the fifth wrong attempt voids the code; a new code starts over and voids the old one", () => {
    const desk = new PairingDesk({ random: (n) => Buffer.alloc(n, 1) });   // every symbol is "1"
    const { code } = desk.issue();
    expect(code).toBe("1111-1111");
    for (let i = 0; i < MAX_WRONG_ATTEMPTS - 1; i++) expect(desk.redeem("2222-2222")).toBe("rejected");
    expect(desk.current()).not.toBeNull();
    expect(desk.redeem("nonsense")).toBe("rejected");        // malformed counts as wrong too
    expect(desk.current()).toBeNull();
    expect(desk.redeem(code)).toBe("rejected");
    const fresh = desk.issue();
    for (let i = 0; i < MAX_WRONG_ATTEMPTS - 1; i++) desk.redeem("2222-2222");
    expect(desk.redeem(fresh.code)).toBe("ok");   // strikes belong to a code, not to the desk
  });

  it("issuing a new code voids the previous one", () => {
    let n = 0;
    const desk = new PairingDesk({ random: (len) => Buffer.alloc(len, n++) });
    const first = desk.issue();
    const second = desk.issue();
    expect(first.code).not.toBe(second.code);
    expect(desk.redeem(first.code)).toBe("rejected");
    expect(desk.redeem(second.code)).toBe("ok");
  });

  it("rate limit per source: the eleventh attempt within a minute is refused, others are unaffected, the window slides", () => {
    const c = clock();
    const desk = new PairingDesk({ now: c.now });
    for (let i = 0; i < PAIR_RATE_LIMIT; i++) expect(desk.limited("192.168.1.9")).toBe(false);
    expect(desk.limited("192.168.1.9")).toBe(true);
    expect(desk.limited("192.168.1.10")).toBe(false);
    c.advance(PAIR_RATE_WINDOW_MS);
    expect(desk.limited("192.168.1.9")).toBe(false);
  });

  it("payload in the doc's shape and key order; the link carries it as unpadded base64url", () => {
    const { payload, link } = pairPayload({ name: "Mac", port: 4713, fp: "ab".repeat(32), code: "ABCD-EFGH", lan: ["192.168.1.5"], tailnet: ["100.101.102.103", "mac.tail1234.ts.net"], gate: { publicKey: KEY, keypair: "default" } });
    expect(Object.keys(payload)).toEqual(["v", "name", "port", "fp", "code", "lan", "tailnet", "bonjour", "gate"]);
    expect(payload.bonjour).toBe("AgentSwitch on Mac");
    expect(link.startsWith(PAIR_LINK_PREFIX)).toBe(true);
    const encoded = link.slice(PAIR_LINK_PREFIX.length);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual(payload);
  });
});

describe("gate public key", () => {
  it("takes the current row with a 32-byte base64url key", () => {
    expect(currentKey(JSON.stringify([{ name: "old", public: KEY, current: false }, { name: "demo01", public: KEY, current: true }]))).toEqual({ publicKey: KEY, keypair: "demo01" });
    expect(currentKey(JSON.stringify([{ name: "old", public: KEY, current: false }]))).toBeNull();
    expect(currentKey(JSON.stringify([{ name: "short", public: "AAAA", current: true }]))).toBeNull();
    expect(currentKey(JSON.stringify([{ name: "bad", public: "not base64url!", current: true }]))).toBeNull();
    expect(currentKey(JSON.stringify({ name: "x" }))).toBeNull();
    expect(currentKey("garbage")).toBeNull();
  });

  it("runs `<bin> keys --json` with the gate home; failures are null with a logged reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-gatekey-"));
    const bin = join(dir, "secret-gate");
    writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "keys --json" ] || exit 3\nprintf '[{"name":"%s","public":"${KEY}","current":true}]' "$(basename "$SECRET_GATE_HOME")"\n`);
    chmodSync(bin, 0o755);
    const warn = vi.fn();
    expect(await gateKeyReader(() => ({ bin, home: join(dir, "gatehome") }), { warn })()).toEqual({ publicKey: KEY, keypair: "gatehome" });
    expect(warn).not.toHaveBeenCalled();
    expect(await gateKeyReader(() => null, { warn })()).toBeNull();
    expect(await gateKeyReader(() => ({ bin: join(dir, "missing"), home: dir }), { warn })()).toBeNull();
    const empty = join(dir, "empty-gate");
    writeFileSync(empty, "#!/bin/sh\necho '[]'\n");
    chmodSync(empty, 0o755);
    expect(await gateKeyReader(() => ({ bin: empty, home: dir }), { warn })()).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("secret-gate not found"),
      expect.stringContaining("keys --json failed"),
      expect.stringContaining("no current keypair"),
    ]);
  });
});

describe("device tokens", () => {
  it("32 random bytes as base64url, stored only as SHA-256", () => {
    const store = memStore();
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { device, token: issued } = registerDevice(store, { name: "iPhone", platform: "ios" });
    expect(store.deviceTokenHashes()).toEqual([{ id: device.id, tokenHash: hashToken(issued) }]);
    expect(JSON.stringify(store.listDevices())).not.toContain(issued);
    store.close();
  });

  it("authenticates by bearer header, rejects wrong, malformed and revoked tokens", () => {
    const store = memStore();
    const a = registerDevice(store, { name: "A", platform: "ios" });
    const b = registerDevice(store, { name: "B", platform: "ipados" });
    expect(authenticate(store, `Bearer ${a.token}`)?.id).toBe(a.device.id);
    expect(authenticate(store, `Bearer ${b.token}`)?.name).toBe("B");
    expect(authenticate(store, undefined)).toBeNull();
    expect(authenticate(store, a.token)).toBeNull();
    expect(authenticate(store, `Basic ${a.token}`)).toBeNull();
    expect(authenticate(store, `Bearer ${newToken()}`)).toBeNull();
    expect(authenticate(store, "Bearer short")).toBeNull();
    store.revokeDevice(a.device.id);
    expect(authenticate(store, `Bearer ${a.token}`)).toBeNull();
    expect(authenticate(store, `Bearer ${b.token}`)?.id).toBe(b.device.id);
    expect(store.revokeDevice("nope")).toBeUndefined();
    store.close();
  });

  it("last_seen_at is written at most once per throttle window", () => {
    let t = 5_000_000;
    const store = memStore(() => t);
    const { device, token } = registerDevice(store, { name: "A", platform: "ios" });
    expect(device.lastSeenAt).toBeNull();
    expect(authenticate(store, `Bearer ${token}`, t)?.lastSeenAt).toBe(t);
    const first = t;
    t += LAST_SEEN_THROTTLE_MS - 1;
    authenticate(store, `Bearer ${token}`, t);
    expect(store.getDevice(device.id)?.lastSeenAt).toBe(first);
    t += 1;
    authenticate(store, `Bearer ${token}`, t);
    expect(store.getDevice(device.id)?.lastSeenAt).toBe(t);
    store.close();
  });

  it("presence: open requests and recent sightings count as online; revocation cuts open requests", () => {
    let t = 9_000_000;
    const store = memStore(() => t);
    const a = registerDevice(store, { name: "A", platform: "ios" }).device;
    const b = registerDevice(store, { name: "B", platform: "ios" }).device;
    const presence = new Presence();
    expect(presence.online(store.listDevices(), t)).toEqual([]);
    const cut = vi.fn();
    const leave = presence.enter(a.id, cut);
    presence.enter(a.id);
    expect(presence.online(store.listDevices(), t).map((d) => d.id)).toEqual([a.id]);
    leave();
    leave();
    expect(presence.connected(a.id)).toBe(true);
    store.touchDevice(b.id, t);
    t += ONLINE_WINDOW_MS + 1;
    expect(presence.online(store.listDevices(), t).map((d) => d.id)).toEqual([a.id]);
    const endB = presence.enter(b.id, () => { throw new Error("socket already gone"); });
    expect(presence.disconnect(b.id)).toBe(1);
    endB();
    expect(presence.disconnect(a.id)).toBe(1);
    expect(cut).not.toHaveBeenCalled();   // the first entry had left already; the second has no cut
    const again = vi.fn();
    presence.enter(a.id, again);
    store.revokeDevice(a.id);
    expect(presence.disconnect(a.id)).toBe(1);
    expect(again).toHaveBeenCalledOnce();
    expect(presence.online(store.listDevices(), t)).toEqual([]);
    store.close();
  });
});

describe("remote route allowlist", () => {
  it("lists exactly the doc's routes", () => {
    expect(REMOTE_ROUTES.map(([m, p]) => `${m} ${p}`)).toEqual([
      "GET /healthz", "POST /pair", "GET /me", "GET /addresses", "GET /gate/pubkey", "GET /tasks", "POST /tasks", "GET /tasks/:id", "GET /tasks/:id/events",
      "POST /tasks/:id/answer", "POST /tasks/:id/approve", "POST /tasks/:id/cancel", "POST /tasks/:id/handoff", "POST /tasks/:id/rate",
      "POST /tasks/:id/ack", "GET /search", "GET /tasks/:id/files", "GET /tasks/:id/files/*", "GET /approvals", "GET /threads", "GET /threads/:id", "PATCH /threads/:id",
      "POST /threads/:id/archive", "POST /threads/:id/reopen", "DELETE /tasks/:id", "DELETE /threads/:id", "GET /quota", "POST /quota/refresh",
      "GET /targets", "POST /uploads", "GET /context", "PUT /context", "GET /context/example", "POST /assistant", "GET /assistant", "DELETE /assistant/:seq", "DELETE /history",
      "GET /sessions", "GET /sessions/:harness/:id", "GET /sessions/search", "DELETE /sessions/:harness/:id",
      "GET /terminals", "GET /terminals/style", "POST /terminals", "POST /terminals/resume", "GET /terminals/:id", "PATCH /terminals/:id", "GET /terminals/:id/stream", "GET /terminals/:id/commands", "POST /terminals/:id/input",
      "POST /terminals/:id/attach", "POST /terminals/:id/keys", "POST /terminals/:id/resize", "POST /terminals/:id/redraw", "POST /terminals/:id/permissions/:pid", "POST /terminals/:id/kill", "DELETE /terminals/:id", "GET /folders/git",
      "GET /browser/tabs", "POST /browser/tabs", "GET /browser/tabs/:id", "DELETE /browser/tabs/:id", "GET /browser/tabs/:id/stream", "POST /browser/tabs/:id/input",
      "POST /browser/tabs/:id/navigate", "POST /browser/tabs/:id/take", "POST /browser/tabs/:id/release", "POST /browser/tabs/:id/viewport", "POST /browser/tabs/:id/fill", "GET /browser/servers", "GET /browser/speed",
      "GET /approvals/policy", "GET /settings/workdir", "GET /update", "POST /update/install",
    ]);
  });

  it("every listed route is reachable with real values in its parameters (e.g. /sessions/claude-code/<id>)", () => {
    for (const [method, pattern] of REMOTE_ROUTES) {
      const path = pattern.split("/").map((seg) => (seg.startsWith(":") ? "abc" : seg === "*" ? "a/b.png" : seg)).join("/");
      expect(remoteAllowed(method, path), `${method} ${path}`).toBe(true);
    }
    expect(remoteAllowed("GET", "/sessions/claude-code/0e3e5e94-d0e2-4f5b-b869-85d7a3bb725b")).toBe(true);
    expect(remoteAllowed("GET", "/sessions/claude-code")).toBe(false);
    expect(remoteAllowed("GET", "/sessions/claude-code/x/y")).toBe(false);
  });

  it("matches methods and single path segments exactly", () => {
    for (const [m, p] of [["GET", "/tasks/abc"], ["GET", "/tasks/abc/files/out/a.png"], ["PATCH", "/threads/t1"], ["POST", "/tasks/abc/rate"], ["GET", "/context"],
      ["PUT", "/context"], ["GET", "/context/example"], ["DELETE", "/tasks/abc"], ["DELETE", "/threads/t1"]] as const) expect(remoteAllowed(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of [["PUT", "/memory"], ["DELETE", "/platform-memory/x"], ["DELETE", "/mcp/x"], ["DELETE", "/skills/x"], ["DELETE", "/tasks/a/b"], ["DELETE", "/threads/"],
      ["POST", "/context"], ["DELETE", "/context"], ["GET", "/mcp"], ["GET", "/skills"], ["GET", "/memory"], ["GET", "/records"],
      ["GET", "/routing/log"], ["PUT", "/approvals/policy"], ["PUT", "/settings/workdir"], ["POST", "/pairing"], ["GET", "/devices"], ["DELETE", "/devices/x"], ["GET", "/remote/info"],
      ["GET", "/settings/models"], ["GET", "/ui"], ["GET", "/"], ["HEAD", "/healthz"], ["GET", "/tasks/"], ["GET", "/tasks/a/b"], ["GET", "/tasks/a/files/"], ["POST", "/route/preview"],
      ["GET", "/platform-memory"], ["POST", "/tasks/a/delete"], ["PUT", "/projects"], ["POST", "/update"]] as const) expect(remoteAllowed(m, p), `${m} ${p}`).toBe(false);
  });
});

describe("Mac name", () => {
  it("ComputerName when scutil answers, else the host name", () => {
    expect(macName(() => "Studio\n")).toBe("Studio");
    expect(macName(() => { throw new Error("no scutil"); })).not.toMatch(/\.local$/);
    expect(macName(() => "  ")).toBeTruthy();
  });
});
