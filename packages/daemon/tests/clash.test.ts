/** Clash Integration (docs/clash-v0.md §6): the user's subscription with AgentSwitch's groups, rule sets and rules in
 *  front; the rule sets' text; what is found of Clash Verge; the core's controller over its socket; the addresses
 *  Clash Verge fetches, held to their token. */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { parse } from "yaml";
import { mountClash } from "../src/api/clash.js";
import { LocalAuth } from "../src/api/localAuth.js";
import type { ApiDeps } from "../src/api/shared.js";
import { buildSubscription, ClashBuildError, directRule, EMPTY_SETTINGS, ruleSet, running, type ClashSettings } from "../src/clash/build.js";
import { ClashController } from "../src/clash/controller.js";
import { ClashStore } from "../src/clash/store.js";
import { vergeProfileText, vergeProfiles } from "../src/clash/verge.js";
import { markRemote } from "../src/core/caller.js";

const SOURCE = `mixed-port: 7897
proxies:
  - { name: "Inline SG", type: ss, server: sg.example, port: 443, cipher: aes-128-gcm, password: p }
proxy-providers:
  tgyun: { type: http, url: "https://sub.example/x?token=secret", path: ./providers/tgyun.yaml }
proxy-groups:
  - { name: Manual, type: select, use: [tgyun], proxies: ["Inline SG"] }
rules:
  - DOMAIN-KEYWORD,anthropic,Manual
  - MATCH,Manual
`;
const settings = (over: Partial<ClashSettings>): ClashSettings => ({ ...EMPTY_SETTINGS, ...over });
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

describe("the subscription AgentSwitch makes", () => {
  it("keeps the user's own and puts its groups, rule sets and rules in front", () => {
    const made = parse(buildSubscription(SOURCE, settings({ claude: { nodes: ["🇯🇵 Tokyo (1.5x)", "Inline SG"], mode: "auto" } }), "http://127.0.0.1:4711/clash", "tok")) as Record<string, any>;
    expect(made["mixed-port"]).toBe(7897);
    expect(made.proxies).toHaveLength(1);
    expect(made["proxy-groups"].map((g: { name: string }) => g.name)).toEqual(["AgentSwitch Claude", "AgentSwitch Claude Auto", "AS · 🇯🇵 Tokyo (1.5x)", "Manual"]);
    // A node of a provider is reached through a group that picks it out by its exact name; one of the list, as it is.
    expect(made["proxy-groups"][2]).toEqual({ name: "AS · 🇯🇵 Tokyo (1.5x)", type: "select", use: ["tgyun"], filter: "^🇯🇵 Tokyo \\(1\\.5x\\)$" });
    expect(made["proxy-groups"][1]).toMatchObject({ type: "fallback", proxies: ["AS · 🇯🇵 Tokyo (1.5x)", "Inline SG"] });
    expect(made["proxy-groups"][0].proxies).toEqual(["AgentSwitch Claude Auto", "AS · 🇯🇵 Tokyo (1.5x)", "Inline SG"]);
    expect(made.rules).toEqual(["RULE-SET,as-direct,DIRECT", "RULE-SET,as-claude,AgentSwitch Claude", "DOMAIN-KEYWORD,anthropic,Manual", "MATCH,Manual"]);
    expect(made["rule-providers"]["as-direct"]).toEqual({ type: "http", behavior: "classical", format: "yaml", url: "http://127.0.0.1:4711/clash/rules/as-direct.yaml?k=tok", path: "./ruleset/as-direct.yaml", interval: 86400, proxy: "DIRECT" });
    // With nothing asked for, only the direct set is in front.
    const plain = parse(buildSubscription(SOURCE, EMPTY_SETTINGS, "http://127.0.0.1:1/clash", "t")) as Record<string, any>;
    expect(plain["proxy-groups"]).toHaveLength(1);
    expect(plain.rules.slice(0, 2)).toEqual(["RULE-SET,as-direct,DIRECT", "DOMAIN-KEYWORD,anthropic,Manual"]);
    expect(() => buildSubscription("proxies: [", EMPTY_SETTINGS, "x", "t")).toThrow(ClashBuildError);
    expect(() => buildSubscription("proxies: []\n", settings({ openai: { nodes: ["nowhere"], mode: "auto" } }), "x", "t")).toThrow(/没有节点/);
  });

  it("writes a rule set as the core reads it; an address is an IP or a name, nothing else", () => {
    expect(parse(ruleSet("as-direct", settings({ direct: ["5.102.107.254", "Proxy.Example.com", "not an address", "2001:db8::1"] }))!)).toEqual({ payload: ["IP-CIDR,5.102.107.254/32,no-resolve", "DOMAIN,proxy.example.com", "IP-CIDR6,2001:db8::1/128,no-resolve"] });
    expect(parse(ruleSet("as-direct", EMPTY_SETTINGS)!).payload).toHaveLength(1);
    expect(parse(ruleSet("as-claude", EMPTY_SETTINGS)!).payload).toContain("DOMAIN-SUFFIX,claude.ai");
    expect(ruleSet("something-else", EMPTY_SETTINGS)).toBeNull();
    expect(directRule("999.1.1.1")).toEqual([]);
  });

  it("says whether the core runs it, and whether its groups are the ones asked for now", () => {
    const want = settings({ claude: { nodes: ["A", "B"], mode: "auto" } });
    expect(running(want, { ruleSets: {}, groups: [] })).toEqual({ active: false, current: false });
    expect(running(want, { ruleSets: { "as-direct": 1 }, groups: [{ name: "AgentSwitch Claude Auto", members: ["AS · A", "B"] }] })).toEqual({ active: true, current: true });
    expect(running(want, { ruleSets: { "as-direct": 1 }, groups: [{ name: "AgentSwitch Claude Auto", members: ["B", "AS · A"] }] })).toEqual({ active: true, current: false });
    expect(running(EMPTY_SETTINGS, { ruleSets: { "as-direct": 1 }, groups: [] })).toEqual({ active: true, current: true });
  });
});

function verge() {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-verge-"));
  mkdirSync(join(dir, "profiles"));
  writeFileSync(join(dir, "profiles.yaml"), `current: Lbw7BJYzpand\nitems:\n- uid: Merge\n  type: merge\n  file: Merge.yaml\n- uid: Lbw7BJYzpand\n  type: local\n  name: mine.yaml\n  file: Lbw7BJYzpand.yaml\n- uid: Ro3yUVdr9kT1\n  type: remote\n  name: Other\n  file: Ro3yUVdr9kT1.yaml\n  url: https://sub.example/get?token=secret\n`);
  writeFileSync(join(dir, "profiles", "Lbw7BJYzpand.yaml"), SOURCE);
  return dir;
}

describe("Clash Verge as it is found", () => {
  it("lists its subscriptions without their tokens and reads one's text", () => {
    const dir = verge();
    expect(vergeProfiles(dir)).toEqual({ current: "Lbw7BJYzpand", profiles: [{ uid: "Lbw7BJYzpand", name: "mine.yaml", type: "local", file: "Lbw7BJYzpand.yaml" }, { uid: "Ro3yUVdr9kT1", name: "Other", type: "remote", file: "Ro3yUVdr9kT1.yaml", from: "https://sub.example" }] });
    expect(vergeProfileText("Lbw7BJYzpand", dir)).toBe(SOURCE);
    expect(vergeProfileText("Merge", dir)).toBeNull();
    expect(vergeProfiles(join(dir, "nowhere"))).toBeNull();
  });
});

/** A core's controller on a unix socket: the answers the real one gave on 2026-10-08, cut down. */
async function core() {
  const calls: string[] = [];
  const state = { now: "AgentSwitch Claude Auto" };
  const server: Server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(`${req.method} ${decodeURIComponent(req.url ?? "")} ${body}`.trim());
      const send = (o: unknown, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(o === null ? "" : JSON.stringify(o)); };
      if (req.method === "PUT" && req.url!.startsWith("/proxies/")) { state.now = JSON.parse(body).name; return send(null, 204); }
      if (req.method === "PUT") return send(null, 204);
      if (req.url === "/version") return send({ meta: true, version: "v1.19.31" });
      if (req.url === "/configs") return send({ mode: "rule", tun: { enable: true } });
      if (req.url === "/providers/rules") return send({ providers: { "as-direct": { ruleCount: 2 } } });
      if (req.url === "/providers/proxies") return send({ providers: {
        default: { vehicleType: "Compatible", proxies: [{ name: "DIRECT", type: "Direct" }, { name: "AgentSwitch Claude", type: "Selector", all: [] }] },
        tgyun: { vehicleType: "HTTP", proxies: [{ name: "🇯🇵 Tokyo (1.5x)", type: "Trojan" }] } } });
      if (req.url === "/proxies") return send({ proxies: { DIRECT: { type: "Direct" }, COMPATIBLE: { type: "Compatible" }, "Inline SG": { type: "Shadowsocks" },
        "AgentSwitch Claude": { type: "Selector", now: state.now, all: ["AgentSwitch Claude Auto", "AS · 🇯🇵 Tokyo (1.5x)", "Inline SG"] },
        "AgentSwitch Claude Auto": { type: "Fallback", now: "Inline SG", all: ["AS · 🇯🇵 Tokyo (1.5x)", "Inline SG"] } } });
      send({}, 404);
    });
  });
  const socket = join(mkdtempSync(join(tmpdir(), "as-clash-")), "c.sock");
  await new Promise<void>((ok) => server.listen(socket, ok));
  closers.push(() => server.close());
  return { socket, calls, state };
}

describe("the core's controller", () => {
  it("says what runs, picks a node, and has one rule set read again", async () => {
    const { socket, calls } = await core();
    const ctl = new ClashController(socket);
    const status = await ctl.status();
    expect(status).toMatchObject({ version: "v1.19.31", mode: "rule", tun: true, nodes: ["Inline SG", "🇯🇵 Tokyo (1.5x)"], ruleSets: { "as-direct": 2 } });
    expect(status.groups.map((g) => [g.name, g.type, g.now])).toEqual([["AgentSwitch Claude", "Selector", "AgentSwitch Claude Auto"], ["AgentSwitch Claude Auto", "Fallback", "Inline SG"]]);
    await ctl.select("AgentSwitch Claude", "Inline SG");
    await ctl.refreshRuleSet("as-direct");
    expect(calls.slice(-2)).toEqual(['PUT /proxies/AgentSwitch Claude {"name":"Inline SG"}', "PUT /providers/rules/as-direct"]);
    await expect(new ClashController(join(tmpdir(), "no-such.sock")).status()).rejects.toThrow();
  });
});

describe("Clash Integration over HTTP", () => {
  async function served() {
    const dir = verge();
    const { socket, calls, state } = await core();
    const store = new ClashStore(mkdtempSync(join(tmpdir(), "agentswitch-clash-home-")));
    const app = new Hono();
    mountClash(app, { clash: { store, dir, socket: () => socket, base: () => "http://127.0.0.1:4711" } } as unknown as ApiDeps);
    const call = async (method: string, path: string, body?: unknown, env: object = {}) => {
      const res = await app.request(path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }, env);
      const text = await res.text();
      let json: any = null; try { json = JSON.parse(text); } catch { /* yaml */ }
      return { status: res.status, text, json, headers: res.headers };
    };
    return { call, store, calls, state };
  }

  it("shows what was found and what runs; saved settings take effect in the rule sets and the pick at once", async () => {
    const { call, calls, state } = await served();
    const seen = (await call("GET", "/clash")).json;
    expect(seen).toMatchObject({ found: true, running: true, version: "v1.19.31", tun: true, currentProfile: "Lbw7BJYzpand", active: true, settings: { source: null } });
    expect(seen.install).toMatch(/^clash:\/\/install-config\?url=http%3A%2F%2F127\.0\.0\.1%3A4711%2Fclash%2Fsub\.yaml%3Fk%3D[\w-]+&name=AgentSwitch$/);
    expect((await call("GET", "/clash", undefined, markRemote({}, { deviceId: "phone" }))).status).toBe(403);
    const next = { source: "Lbw7BJYzpand", claude: { nodes: ["🇯🇵 Tokyo (1.5x)", "Inline SG"], mode: "manual", picked: "Inline SG" }, openai: { nodes: [], mode: "auto" }, direct: ["5.102.107.254"] };
    const saved = await call("PUT", "/clash/settings", next);
    expect(saved.json).toMatchObject({ settings: next, active: true, upToDate: true });
    expect(calls.filter((c) => c.startsWith("PUT /providers/rules/")).map((c) => c.split("/").pop())).toEqual(expect.arrayContaining(["as-direct", "as-claude", "as-openai"]));
    expect(state.now).toBe("Inline SG");
    // A node the subscription cannot give, a subscription Clash Verge does not have: refused, nothing kept.
    expect((await call("PUT", "/clash/settings", { ...next, source: "Nope1234" })).status).toBe(400);
    expect((await call("GET", "/clash")).json.settings.source).toBe("Lbw7BJYzpand");
  });

  it("hands Clash Verge the subscription and the core its rule sets, to whoever holds the token and nobody else", async () => {
    const { call, store } = await served();
    const k = store.token();
    expect((await call("GET", `/clash/sub.yaml?k=${k}`)).status).toBe(503);   // nothing chosen to work from yet
    await call("PUT", "/clash/settings", { source: "Lbw7BJYzpand", claude: { nodes: ["Inline SG"], mode: "auto" }, openai: { nodes: [], mode: "auto" }, direct: ["proxy.example.com"] });
    const sub = await call("GET", `/clash/sub.yaml?k=${k}&name=AgentSwitch`);   // Clash Verge adds a parameter of its own
    expect(sub.status).toBe(200);
    expect((parse(sub.text) as Record<string, any>).rules[0]).toBe("RULE-SET,as-direct,DIRECT");
    expect(sub.text).toContain(`/clash/rules/as-claude.yaml?k=${k}`);
    expect(parse((await call("GET", `/clash/rules/as-direct.yaml?k=${k}`)).text)).toEqual({ payload: ["DOMAIN,proxy.example.com"] });
    for (const path of ["/clash/sub.yaml", "/clash/sub.yaml?k=wrong", "/clash/rules/as-direct.yaml", `/clash/rules/unknown.yaml?k=${k}`]) expect((await call("GET", path)).status, path).toBe(404);
    expect((await call("GET", `/clash/sub.yaml?k=${k}`, undefined, markRemote({}, { deviceId: "phone" }))).status).toBe(404);
    // The local listener lets exactly these two kinds of address through without its own token.
    const auth = new LocalAuth("local-token-0123456789abcdefghijklmnopqrstuv");
    const open = (path: string) => auth.check(new Request(`http://127.0.0.1:4711${path}`)) === null;
    expect([open("/clash/sub.yaml?k=x"), open("/clash/rules/as-direct.yaml?k=x"), open("/clash"), open("/clash/settings"), open("/clash/rules/../../x")]).toEqual([true, true, false, false, false]);
  });
});
