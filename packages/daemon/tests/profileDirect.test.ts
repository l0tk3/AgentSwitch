/** A profile's `Direct` rules (docs/profiles-v0.md §4.3): what its browser — Chrome and Camoufox both go through its
 *  forwarder — and its terminals reach straight, past its proxy. NetBird by default; the person adds and removes. */

import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { mountProfiles } from "../src/api/profiles.js";
import type { ApiDeps } from "../src/api/shared.js";
import { DEFAULT_DIRECT, directMatch, directRule } from "../src/util/directRules.js";
import { ExitPool } from "../src/browser/exits.js";
import { Forwarder, type ForwarderAddress } from "../src/browser/forwarder.js";
import { ProfileStore } from "../src/profiles/store.js";

const open: (() => unknown)[] = [];
afterEach(async () => { for (const c of open.splice(0)) await c(); });

function listen(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => { hits.push(req.headers.host ?? ""); res.end("ok"); });
  open.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r(undefined)); }));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, hits })));
}

const proxyPort = (a: ForwarderAddress) => Number(new URL(a.server).port);
function get(a: ForwarderAddress, url: string): Promise<number> {
  const auth = `Basic ${Buffer.from(`${a.username}:${a.password}`).toString("base64")}`;
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: proxyPort(a), path: url, headers: { Host: new URL(url).host, "Proxy-Authorization": auth } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", () => resolve(0));
    req.end();
  });
}
async function forwarder(opts: ConstructorParameters<typeof Forwarder>[0]) {
  const f = new Forwarder(opts);
  open.push(() => f.stop());
  return { f, at: await f.start() };
}

describe("a profile's Direct rules", () => {
  it("are names, *. and a name, IPv4 addresses and CIDRs — anything else is refused", () => {
    expect(directRule(" NetBird.io. ")).toBe("netbird.io");
    expect(directRule("*.netbird.cloud")).toBe("*.netbird.cloud");
    expect(directRule("100.64.0.0/10")).toBe("100.64.0.0/10");
    expect(directRule("100.101.2.3")).toBe("100.101.2.3");
    for (const bad of ["", "netbird", "*netbird.io", "a.*.io", "http://netbird.io", "netbird.io:443", "300.1.1.1", "10.0.0.0/33", "-x.io", "a b.io"]) expect(directRule(bad), bad).toBeNull();
  });

  it("match a name itself, the names under a wildcard (not the name of it), and addresses inside a CIDR", () => {
    const rules = DEFAULT_DIRECT;
    for (const host of ["netbird.io", "api.netbird.io", "NETBIRD.IO.", "peer-1.netbird.cloud", "100.64.0.1", "100.127.255.254"]) expect(directMatch(host, rules), host).toBe(true);
    for (const host of ["netbird.cloud", "notnetbird.io", "netbird.io.evil.com", "100.128.0.1", "100.63.255.255", "example.com"]) expect(directMatch(host, rules), host).toBe(false);
    expect(directMatch("1.2.3.4", ["0.0.0.0/0"])).toBe(true);
    expect(directMatch("10.1.2.3", ["10.1.2.3"])).toBe(true);
  });

  it("send what they name straight, past the upstream; the rest to the upstream; a change counts at the next request", async () => {
    const site = await listen();
    const { f: outer, at: o } = await forwarder({ ownPorts: () => [] });
    let rules: readonly string[] = ["*.direct.test"];
    const { f, at } = await forwarder({ ownPorts: () => [], upstream: () => `http://${o.username}:${o.password}@127.0.0.1:${proxyPort(o)}`, direct: () => rules });
    // A name the rules give: straight (this name resolves nowhere, so the request fails here — but not at the upstream).
    await get(at, `http://peer.direct.test:${site.port}/a`);
    expect([f.stats().requests, outer.stats().requests]).toEqual([1, 0]);
    // One they do not: to the upstream.
    await get(at, `http://elsewhere.test:${site.port}/b`);
    expect(outer.stats().requests).toBe(1);
    rules = ["elsewhere.test"];
    await get(at, `http://elsewhere.test:${site.port}/c`);
    expect(outer.stats().requests).toBe(1);
  });

  it("are kept with the profile: NetBird until set, set and checked, back to the default with null; over HTTP too", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentswitch-direct-"));
    const store = new ProfileStore({ home: join(root, "as"), userHome: join(root, "user"), now: () => 1_000 });
    const exits = new ExitPool({ ownPorts: () => [], lookup: null, direct: (key) => store.directOf("claude-code", key.split(".")[1]!) });
    open.push(() => exits.stop());
    const app = new Hono();
    mountProfiles(app, { profiles: store, exits } as unknown as ApiDeps);
    const call = async (path: string, body: unknown) => { const res = await app.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, json: (await res.json()) as Record<string, any> }; };
    const id = store.create("claude-code", "Work", "subscription").id;
    expect(store.directOf("claude-code", id)).toEqual(DEFAULT_DIRECT);
    expect(store.all()["claude-code"].profiles.find((p) => p.id === id)!.direct).toEqual(DEFAULT_DIRECT);
    const set = await call(`/profiles/claude-code/${id}/direct`, { rules: ["*.netbird.io", "Git.Example.com", "git.example.com", "10.8.0.0/16"] });
    expect(set.status).toBe(200);
    expect(set.json.agents["claude-code"].profiles.find((p: { id: string }) => p.id === id).direct).toEqual(["*.netbird.io", "git.example.com", "10.8.0.0/16"]);
    expect(await call(`/profiles/claude-code/${id}/direct`, { rules: ["git.example.com", "not a rule"] })).toMatchObject({ status: 400, json: { error: expect.stringContaining("not a rule") } });
    expect(store.directOf("claude-code", id)).toEqual(["*.netbird.io", "git.example.com", "10.8.0.0/16"]);
    expect((await call(`/profiles/claude-code/${id}/direct`, { rules: [] })).json.agents["claude-code"].profiles.find((p: { id: string }) => p.id === id).direct).toEqual([]);
    expect((await call(`/profiles/claude-code/${id}/direct`, { rules: null })).json.agents["claude-code"].profiles.find((p: { id: string }) => p.id === id).direct).toEqual(DEFAULT_DIRECT);
    expect((await call(`/profiles/claude-code/nope/direct`, { rules: [] })).status).toBe(404);
    // Default of Claude Code can have rules too, as it can a proxy.
    expect((await call(`/profiles/claude-code/default/direct`, { rules: ["netbird.io"] })).json.agents["claude-code"].profiles[0].direct).toEqual(["netbird.io"]);
  });
});
