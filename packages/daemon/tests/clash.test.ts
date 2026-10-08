/** Clash Integration (docs/clash-v0.md §7): the subscription AgentSwitch works from and keeps; the one it makes of it
 *  — a node set and two groups for each of Claude and OpenAI, its rules in front; what is found of Clash Verge; the
 *  core's controller over its socket; the addresses Clash Verge and its core fetch, held to their token. */

import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { parse } from "yaml";
import { mountClash } from "../src/api/clash.js";
import { LocalAuth } from "../src/api/localAuth.js";
import type { ApiDeps } from "../src/api/shared.js";
import { BUILT_IN, buildSubscription, defaultGroup, directRule, dnsSection, dnsText, EMPTY_SETTINGS, groupNames, nodeSet, RULE_SETS, ruleSet, running, type ClashSettings } from "../src/clash/build.js";
import { looksUp, ruleLine, rulesFrom } from "../src/clash/rules.js";
import { ClashController } from "../src/clash/controller.js";
import { ClashIntegration, parseTraffic } from "../src/clash/integration.js";
import { ClashSource, ClashSourceError, providerSlug, type Fetched, type SourceNode } from "../src/clash/source.js";
import { ClashStore } from "../src/clash/store.js";
import { vergeOwnDns, vergeProfileLink, vergeProfileText, vergeProfiles } from "../src/clash/verge.js";
import { markRemote } from "../src/core/caller.js";
import { listenLocal } from "../src/daemon.js";

/** The user's own file of 2026-10-08, cut down: its nodes come in a node set fetched by link, and it has groups for
 *  Claude and OpenAI already, written with filters. */
const OWN = `mixed-port: 7897
proxy-providers:
  tgyun:
    type: http
    url: "https://sub.example:9888/get?token=secret"
    path: ./providers/tgyun.yaml
    interval: 3600
    health-check: { enable: true, url: "https://www.gstatic.com/generate_204", interval: 300 }
proxy-groups:
  - { name: Claude自动选择, type: fallback, use: [tgyun], filter: "日本家宽-02\`日本家宽-01", url: "https://api.anthropic.com/", interval: 180 }
  - { name: Claude, type: select, proxies: [Claude自动选择, Manual], use: [tgyun], filter: "家宽|住宅" }
  - { name: OpenAI自动选择, type: fallback, use: [tgyun], filter: "美国\`新加坡" }
  - { name: OpenAI, type: select, proxies: [OpenAI自动选择, Manual], use: [tgyun] }
  - { name: Manual, type: select, proxies: [Auto, Claude自动选择], use: [tgyun] }
  - { name: Auto, type: fallback, use: [tgyun] }
rules:
  - DOMAIN-KEYWORD,anthropic,Claude
  - DOMAIN-KEYWORD,openai,OpenAI
  - MATCH,Manual
`;
const node = (name: string, server = "n.example") => ({ name, type: "vless", server, port: 443, uuid: "0000-secret" });
/** What the node set's link answers: a whole Clash configuration, as subscription services give. */
const PROVIDED = `mixed-port: 7890
proxies:
  - ${JSON.stringify(node("🇯🇵 日本家宽-01"))}
  - ${JSON.stringify(node("🇯🇵 日本家宽-02"))}
  - ${JSON.stringify(node("🇺🇸 美国-01"))}
proxy-groups:
  - { name: Proxy, type: select, proxies: ["🇯🇵 日本家宽-01"] }
rules: [ "MATCH,Proxy" ]
`;
/** A subscription service's plain answer: nodes of its own, no groups for Claude or OpenAI. */
const PLAIN = `proxies:
  - ${JSON.stringify(node("HK 01"))}
  - ${JSON.stringify(node("SG 01"))}
proxy-groups:
  - { name: Proxy, type: select, proxies: [HK 01, SG 01] }
rules:
  - DOMAIN-SUFFIX,claude.ai,Proxy
  - MATCH,Proxy
`;
const NODES: SourceNode[] = ["🇯🇵 日本家宽-01", "🇯🇵 日本家宽-02", "🇺🇸 美国-01"].map((name) => ({ name, from: "tgyun", definition: node(name) }));
const settings = (over: Partial<ClashSettings>): ClashSettings => ({ ...EMPTY_SETTINGS, ...over });
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

describe("the subscription AgentSwitch makes", () => {
  const made = (source: string, nodes: SourceNode[], held: string[], chosen: Partial<ClashSettings>) =>
    parse(buildSubscription(parse(source) as Record<string, unknown>, nodes, held, settings(chosen), "http://127.0.0.1:4711/clash", "tok")) as Record<string, any>;

  it("takes the place of the groups the subscription has by those names, and serves their nodes as a set", () => {
    const out = made(OWN, NODES, ["tgyun"], { claude: { nodes: ["🇯🇵 日本家宽-02", "🇯🇵 日本家宽-01"] } });
    expect(out["mixed-port"]).toBe(7897);
    // Claude's two groups are AgentSwitch's, where they stood; OpenAI's (no node chosen) and the rest are as they were.
    expect(out["proxy-groups"].map((g: { name: string }) => g.name)).toEqual(["Claude自动选择", "Claude", "OpenAI自动选择", "OpenAI", "Manual", "Auto"]);
    expect(out["proxy-groups"][0]).toEqual({ name: "Claude自动选择", type: "fallback", use: ["as-claude"], url: "https://api.anthropic.com/", interval: 180 });
    expect(out["proxy-groups"][1]).toEqual({ name: "Claude", type: "select", proxies: ["Claude自动选择"], use: ["as-claude"] });
    expect(out["proxy-groups"][3]).toEqual({ name: "OpenAI", type: "select", proxies: ["OpenAI自动选择", "Manual"], use: ["tgyun"] });
    expect(out["proxy-groups"][4].proxies).toEqual(["Auto", "Claude自动选择"]);
    // Its rules first, so they win over the subscription's own for the same traffic.
    // The templates' rule sets are always named: what a name decides in front; blocking and what needs a lookup
    // after the subscription's own rules, before the one it ends on.
    expect(out.rules).toEqual(["RULE-SET,as-direct,DIRECT", "RULE-SET,as-claude,Claude", "RULE-SET,as-domestic,DIRECT,no-resolve",
      "DOMAIN-KEYWORD,anthropic,Claude", "DOMAIN-KEYWORD,openai,OpenAI", "RULE-SET,as-block,REJECT", "RULE-SET,as-domestic-ip,DIRECT", "MATCH,Manual"]);
    expect(Object.keys(out["proxy-providers"])).toEqual(["tgyun", "as-claude"]);
    expect(out["proxy-providers"]["as-claude"]).toEqual({ type: "http", url: "http://127.0.0.1:4711/clash/nodes/as-claude.yaml?k=tok", path: "./proxy_providers/as-claude.yaml",
      interval: 86400, proxy: "DIRECT", "health-check": { enable: true, url: "https://api.anthropic.com/", interval: 180 } });
    // The node set it named by link is fetched from AgentSwitch's copy; the rest of it is as written.
    expect(out["proxy-providers"].tgyun).toEqual({ type: "http", url: `http://127.0.0.1:4711/clash/providers/${providerSlug("tgyun")}.yaml?k=tok`, path: "./providers/tgyun.yaml",
      interval: 3600, "health-check": { enable: true, url: "https://www.gstatic.com/generate_204", interval: 300 }, proxy: "DIRECT" });
    expect(Object.keys(out["rule-providers"])).toEqual(["as-direct", "as-claude", "as-openai", "as-domestic", "as-block", "as-domestic-ip"]);
    expect(Object.keys(out["rule-providers"])).toEqual(RULE_SETS);
    expect(out["rule-providers"]["as-direct"]).toEqual({ type: "http", behavior: "classical", format: "yaml", url: "http://127.0.0.1:4711/clash/rules/as-direct.yaml?k=tok", path: "./ruleset/as-direct.yaml", interval: 86400, proxy: "DIRECT" });
    // No group by a made-up name anywhere.
    expect(JSON.stringify(out)).not.toMatch(/AS · |AgentSwitch/);
  });

  it("puts its groups in front where the subscription has none; a node set it holds no copy of is left as written", () => {
    const plain: SourceNode[] = ["HK 01", "SG 01"].map((name) => ({ name, from: null, definition: node(name) }));
    const out = made(PLAIN, plain, [], { claude: { nodes: ["SG 01"] }, openai: { nodes: ["HK 01", "SG 01"] } });
    expect(out["proxy-groups"].map((g: { name: string }) => g.name)).toEqual(["Claude", "Claude自动选择", "OpenAI", "OpenAI自动选择", "Proxy"]);
    expect(out["proxy-groups"][3]).toEqual({ name: "OpenAI自动选择", type: "fallback", use: ["as-openai"], url: "https://api.openai.com/", interval: 180 });
    expect(out.rules).toEqual(["RULE-SET,as-direct,DIRECT", "RULE-SET,as-claude,Claude", "RULE-SET,as-openai,OpenAI", "RULE-SET,as-domestic,DIRECT,no-resolve",
      "DOMAIN-SUFFIX,claude.ai,Proxy", "RULE-SET,as-block,REJECT", "RULE-SET,as-domestic-ip,DIRECT", "MATCH,Proxy"]);
    expect(out.proxies).toHaveLength(2);
    expect(Object.keys(out["proxy-providers"])).toEqual(["as-claude", "as-openai"]);
    expect(made(OWN, NODES, [], {})["proxy-providers"].tgyun.url).toBe("https://sub.example:9888/get?token=secret");
    // With nothing chosen: only the direct rule in front, no group touched, no node set of its own.
    const none = made(PLAIN, plain, [], {});
    expect(none["proxy-groups"]).toHaveLength(1);
    expect(none.rules[0]).toBe("RULE-SET,as-direct,DIRECT");
    expect(none["proxy-providers"]).toBeUndefined();
    // A chosen node the subscription no longer has does not make a group.
    expect(made(PLAIN, plain, [], { claude: { nodes: ["gone"] } })["proxy-groups"]).toHaveLength(1);
  });

  it("takes a group's name as the subscription spells it", () => {
    const spaced = parse(OWN.replace("name: Claude自动选择,", "name: Claude 自动选择,").replace("proxies: [Claude自动选择, Manual]", "proxies: [Claude 自动选择, Manual]")) as Record<string, unknown>;
    expect(groupNames(spaced, "claude")).toEqual({ group: "Claude", auto: "Claude 自动选择" });
    expect(groupNames(parse(PLAIN) as Record<string, unknown>, "openai")).toEqual({ group: "OpenAI", auto: "OpenAI自动选择" });
    const out = parse(buildSubscription(spaced, NODES, [], settings({ claude: { nodes: ["🇺🇸 美国-01"] } }), "http://x/clash", "t")) as Record<string, any>;
    expect(out["proxy-groups"].slice(0, 2)).toEqual([
      { name: "Claude 自动选择", type: "fallback", use: ["as-claude"], url: "https://api.anthropic.com/", interval: 180 },
      { name: "Claude", type: "select", proxies: ["Claude 自动选择"], use: ["as-claude"] }]);
  });

  it("writes a node set in the chosen order with all a node needs, and no empty one", () => {
    const chosen = settings({ claude: { nodes: ["🇺🇸 美国-01", "gone", "🇯🇵 日本家宽-01"] } });
    expect(parse(nodeSet("claude", chosen, NODES)!)).toEqual({ proxies: [node("🇺🇸 美国-01"), node("🇯🇵 日本家宽-01")] });
    expect(nodeSet("openai", chosen, NODES)).toBeNull();
    expect(nodeSet("claude", settings({ claude: { nodes: ["gone"] } }), NODES)).toBeNull();
  });

  it("writes a rule set as the core reads it; a service with no node has an empty one", () => {
    const chosen = settings({ claude: { nodes: ["🇺🇸 美国-01"] }, direct: ["5.102.107.254", "Proxy.Example.com", "not an address", "2001:db8::1"] });
    expect(parse(ruleSet("as-direct", chosen, NODES)!)).toEqual({ payload: ["IP-CIDR,5.102.107.254/32,no-resolve", "DOMAIN,proxy.example.com", "IP-CIDR6,2001:db8::1/128,no-resolve"] });
    expect(parse(ruleSet("as-direct", EMPTY_SETTINGS, NODES)!).payload).toHaveLength(1);
    expect(parse(ruleSet("as-claude", chosen, NODES)!).payload).toContain("DOMAIN-SUFFIX,claude.ai");
    expect(parse(ruleSet("as-openai", chosen, NODES)!).payload).toEqual(["DOMAIN,agentswitch-nothing.invalid"]);
    expect(ruleSet("something-else", chosen, NODES)).toBeNull();
    expect(directRule("999.1.1.1")).toEqual([]);
  });

  it("says whether the core runs it, and whether it is the one made now", () => {
    const want = { enabled: { claude: true, openai: false }, groups: ["Claude", "Manual"] };
    const all = Object.fromEntries(RULE_SETS.map((name) => [name, 1]));
    const groups = [{ name: "GLOBAL" }, { name: "Claude" }, { name: "Manual" }, { name: "One of Clash Verge's own" }];
    expect(running(want, { ruleSets: {}, nodeSets: {}, groups })).toEqual({ active: false, current: false });
    expect(running(want, { ruleSets: all, nodeSets: { tgyun: [], "as-claude": ["a"] }, groups })).toEqual({ active: true, current: true });
    // A node set that should be there and is not, one that should not be and is; a rule set of a newer AgentSwitch
    // the core has not been handed yet; a group it does not have by the name it would get (a rename not fetched).
    expect(running(want, { ruleSets: all, nodeSets: { tgyun: [] }, groups })).toEqual({ active: true, current: false });
    expect(running(want, { ruleSets: all, nodeSets: { "as-claude": ["a"], "as-openai": ["b"] }, groups })).toEqual({ active: true, current: false });
    expect(running(want, { ruleSets: { "as-direct": 1, "as-claude": 4, "as-openai": 6 }, nodeSets: { "as-claude": ["a"] }, groups })).toEqual({ active: true, current: false });
    expect(running(want, { ruleSets: all, nodeSets: { "as-claude": ["a"] }, groups: [{ name: "Claude" }, { name: "Proxy" }] })).toEqual({ active: true, current: false });
  });

  it("reads a template's rule as the user writes it, and says which line is not one", () => {
    expect(["DOMAIN-SUFFIX,cn", "  - DOMAIN-SUFFIX,qq.com,DIRECT   # 腾讯", "- 'IP-CIDR,47.82.219.124/32,DIRECT,no-resolve'", "process-name,WeChatAppEx Helper", "PROCESS-NAME-WILDCARD,*QQ Helper*",
      "GEOIP,CN,DIRECT", "DOMAIN-REGEX,^ad[0-9]{1,3}\\.example\\.com$", "", "   ", "# 注释"].map(ruleLine))
      .toEqual(["DOMAIN-SUFFIX,cn", "DOMAIN-SUFFIX,qq.com", "IP-CIDR,47.82.219.124/32,no-resolve", "PROCESS-NAME,WeChatAppEx Helper", "PROCESS-NAME-WILDCARD,*QQ Helper*",
        "GEOIP,CN", "DOMAIN-REGEX,^ad[0-9]{1,3}\\.example\\.com$", null, null, null]);
    for (const bad of ["MATCH,Manual", "RULE-SET,x,DIRECT", "AND,((DOMAIN,a.com),(NETWORK,UDP)),REJECT", "DOMAIN-SUFFIX", "DOMAIN-SUFFIX,", "qq.com", "DOMIAN,qq.com"]) expect(ruleLine(bad), bad).toHaveProperty("error");
    expect(rulesFrom(["DOMAIN,a.com", "", "DOMAIN,a.com,DIRECT", "# x", "DOMAIN-KEYWORD,b"])).toEqual({ rules: ["DOMAIN,a.com", "DOMAIN-KEYWORD,b"] });
    expect(rulesFrom(["DOMAIN,a.com", "", "qq.com"])).toEqual({ error: "第 3 行不是一条规则（不认识的规则类型 QQ.COM）：qq.com" });
    expect(["IP-CIDR,10.0.0.0/8", "IP-CIDR,10.0.0.0/8,no-resolve", "IP-CIDR6,fe80::/10", "GEOIP,CN", "DOMAIN-SUFFIX,cn", "PROCESS-NAME,QQ"].map(looksUp)).toEqual([true, false, true, true, false, false]);
    // The built-in templates are rules to the letter, each once.
    for (const name of ["domestic", "block"] as const) expect(rulesFrom(BUILT_IN[name])).toEqual({ rules: BUILT_IN[name] });
    expect([BUILT_IN.domestic.length, BUILT_IN.block.length]).toEqual([169, 27]);
    expect(BUILT_IN.domestic.join("\n")).not.toMatch(/47\.82\.|38\.38\./);
  });

  it("serves a template that is on in its rule sets — what needs a lookup apart — and an empty set for one that is off", () => {
    const count = (name: string, s: ClashSettings): string[] => parse(ruleSet(name, s, NODES)!).payload;
    const off = settings({});
    for (const name of ["as-domestic", "as-domestic-ip", "as-block"]) expect(count(name, off), name).toEqual(["DOMAIN,agentswitch-nothing.invalid"]);
    const on = settings({ templates: { domestic: { on: true, rules: null }, block: { on: true, rules: null } } });
    const front = count("as-domestic", on), back = count("as-domestic-ip", on);
    expect(front.length + back.length).toBe(169);
    expect(back).toEqual(["IP-CIDR,127.0.0.0/8", "IP-CIDR,172.16.0.0/12", "IP-CIDR,192.168.0.0/16", "IP-CIDR,10.0.0.0/8", "IP-CIDR,17.0.0.0/8", "IP-CIDR,100.64.0.0/10", "IP-CIDR,224.0.0.0/4", "IP-CIDR6,fe80::/10", "GEOIP,CN"]);
    expect(front).toEqual(expect.arrayContaining(["DOMAIN-SUFFIX,cn", "DOMAIN-KEYWORD,doubao", "PROCESS-NAME,WeChat", "PROCESS-NAME-WILDCARD,*DingTalk*"]));
    expect(front.some(looksUp)).toBe(false);
    expect(count("as-block", on)).toHaveLength(27);
    expect(count("as-block", on)).toContain("DOMAIN-SUFFIX,doubleclick.net");
    // The user's own rules take the built-in ones' place.
    const own = settings({ templates: { domestic: { on: true, rules: ["DOMAIN-SUFFIX,example.cn", "IP-CIDR,10.0.0.0/8", "IP-CIDR,203.0.113.0/24,no-resolve"] }, block: { on: false, rules: ["DOMAIN,ads.example"] } } });
    expect([count("as-domestic", own), count("as-domestic-ip", own), count("as-block", own)]).toEqual([["DOMAIN-SUFFIX,example.cn", "IP-CIDR,203.0.113.0/24,no-resolve"], ["IP-CIDR,10.0.0.0/8"], ["DOMAIN,agentswitch-nothing.invalid"]]);
  });

  it("puts blocking and what needs a lookup before the rules a subscription ends on", () => {
    const ending = PLAIN.replace("  - MATCH,Proxy\n", "  - GEOIP,LAN,DIRECT\n  - GEOIP,CN,DIRECT\n  - MATCH,Proxy\n");
    expect((parse(buildSubscription(parse(ending) as Record<string, unknown>, [], [], EMPTY_SETTINGS, "http://x/clash", "t")) as Record<string, any>).rules).toEqual([
      "RULE-SET,as-direct,DIRECT", "RULE-SET,as-domestic,DIRECT,no-resolve", "DOMAIN-SUFFIX,claude.ai,Proxy",
      "RULE-SET,as-block,REJECT", "RULE-SET,as-domestic-ip,DIRECT", "GEOIP,LAN,DIRECT", "GEOIP,CN,DIRECT", "MATCH,Proxy"]);
    // A subscription with no rules of its own still gets them, in that order.
    expect((parse(buildSubscription({ proxies: [node("a")] }, [], [], EMPTY_SETTINGS, "http://x/clash", "t")) as Record<string, any>).rules)
      .toEqual(["RULE-SET,as-direct,DIRECT", "RULE-SET,as-domestic,DIRECT,no-resolve", "RULE-SET,as-block,REJECT", "RULE-SET,as-domestic-ip,DIRECT"]);
  });

  it("puts the DNS template under dns: in place of the subscription's own when it is on", () => {
    const source = "dns: { enable: true, nameserver: [ 8.8.8.8 ] }\n" + PLAIN;
    const dnsOf = (s: ClashSettings) => (parse(buildSubscription(parse(source) as Record<string, unknown>, [], [], s, "http://x/clash", "t")) as Record<string, any>).dns;
    expect(dnsOf(EMPTY_SETTINGS)).toEqual({ enable: true, nameserver: ["8.8.8.8"] });
    const built = dnsOf(settings({ dns: { on: true, text: null } }));
    // The built-in one: names in China by DNS servers in China, Claude's only by the answer from abroad, real
    // addresses for the listed names — and nothing of the subscription's own left.
    expect(built).toMatchObject({ enable: true, "enhanced-mode": "fake-ip", "respect-rules": true, nameserver: ["https://1.1.1.1/dns-query", "https://dns.google/dns-query"],
      "nameserver-policy": { "geosite:cn,private": ["223.5.5.5", "119.29.29.29"] }, "fallback-filter": { domain: expect.arrayContaining(["+.claude.ai"]) } });
    expect(built["fake-ip-filter"]).toEqual(expect.arrayContaining(["*.lan", "+.qq.com", "+.apple.com"]));
    expect(dnsText(EMPTY_SETTINGS)).toContain("# 国内域名用国内 DNS 解析");
    expect(dnsText(EMPTY_SETTINGS)).not.toMatch(/cworkspace|netbird/);
    // The user's own text takes its place; a subscription with no dns of its own gets one all the same.
    expect(dnsOf(settings({ dns: { on: true, text: "enable: true\nnameserver:\n  - 223.5.5.5\n" } }))).toEqual({ enable: true, nameserver: ["223.5.5.5"] });
    expect((parse(buildSubscription(parse(PLAIN) as Record<string, unknown>, [], [], settings({ dns: { on: true, text: "enable: false\n" } }), "http://x/clash", "t")) as Record<string, any>).dns).toEqual({ enable: false });
    // What is not a section is said, with where.
    expect(dnsSection("enable: true\nnameserver:\n  - 1.1.1.1\n")).toEqual({ section: { enable: true, nameserver: ["1.1.1.1"] } });
    expect(dnsSection("- a\n- b\n")).toEqual({ error: "DNS 这一段要是一组“键: 值”（dns: 下面的内容）" });
    expect(dnsSection("dns:\n  enable: true\n")).toEqual({ error: "不用写 dns: 这一行，只写它下面的内容" });
    expect(dnsSection("enable: true\nnameserver: [1.1.1.1\n")).toEqual({ error: expect.stringMatching(/^DNS 这一段不是合法的 YAML（第 \d+ 行附近）$/) });
  });

  it("calls the subscription's default group Manual when asked, everywhere it is named", () => {
    const airport = `proxies:
  - ${JSON.stringify(node("HK 01"))}
proxy-groups:
  - { name: 糖果, type: select, proxies: [自动选择, HK 01] }
  - { name: 自动选择, type: url-test, proxies: [HK 01] }
  - { name: 流媒体, type: select, proxies: [糖果, 自动选择, HK 01] }
rules:
  - DOMAIN-SUFFIX,google.com,糖果
  - IP-CIDR,91.108.4.0/22,糖果,no-resolve
  - DOMAIN-SUFFIX,netflix.com,流媒体
  - AND,((DOMAIN,a.com),(NETWORK,UDP)),糖果
  - GEOIP,CN,DIRECT
  - MATCH,糖果
`;
    const doc = () => parse(airport) as Record<string, unknown>;
    expect(defaultGroup(doc())).toBe("糖果");
    const kept = parse(buildSubscription(doc(), [], [], EMPTY_SETTINGS, "http://x/clash", "t")) as Record<string, any>;
    expect(kept["proxy-groups"].map((g: { name: string }) => g.name)).toEqual(["糖果", "自动选择", "流媒体"]);
    const out = parse(buildSubscription(doc(), [], [], settings({ renameDefault: true }), "http://x/clash", "t")) as Record<string, any>;
    expect(out["proxy-groups"]).toEqual([{ name: "Manual", type: "select", proxies: ["自动选择", "HK 01"] }, { name: "自动选择", type: "url-test", proxies: ["HK 01"] },
      { name: "流媒体", type: "select", proxies: ["Manual", "自动选择", "HK 01"] }]);
    expect(out.rules.filter((r: string) => !r.startsWith("RULE-SET"))).toEqual(["DOMAIN-SUFFIX,google.com,Manual", "IP-CIDR,91.108.4.0/22,Manual,no-resolve", "DOMAIN-SUFFIX,netflix.com,流媒体",
      "AND,((DOMAIN,a.com),(NETWORK,UDP)),糖果", "GEOIP,CN,DIRECT", "MATCH,Manual"]);
    // Nothing to rename: a subscription that has a Manual already, one whose last rule goes to a group that picks by
    // itself, one that ends direct.
    expect([defaultGroup(parse(OWN) as Record<string, unknown>), defaultGroup(parse(airport.replace("MATCH,糖果", "MATCH,自动选择")) as Record<string, unknown>),
      defaultGroup(parse(airport.replace("MATCH,糖果", "MATCH,DIRECT")) as Record<string, unknown>), defaultGroup({})]).toEqual([null, null, null, null]);
    expect((parse(buildSubscription(parse(OWN) as Record<string, unknown>, NODES, [], settings({ renameDefault: true }), "http://x/clash", "t")) as Record<string, any>)["proxy-groups"].map((g: { name: string }) => g.name))
      .toEqual(["Claude自动选择", "Claude", "OpenAI自动选择", "OpenAI", "Manual", "Auto"]);
  });
});

/** A subscription service: what each address answers, and what was asked of it. */
function service(answers: Record<string, Partial<Fetched> | (() => Partial<Fetched>)>) {
  const asked: string[] = [];
  const fetcher = async (url: string, agent: string): Promise<Fetched> => {
    asked.push(`${agent} ${url}`);
    const a = answers[url];
    if (!a) throw new Error("unreachable");
    return { status: 200, body: "", headers: {}, ...(typeof a === "function" ? a() : a) };
  };
  return { fetcher, asked };
}
const LINK = "https://sub.example:9888/get?token=secret";
const home = () => mkdtempSync(join(tmpdir(), "agentswitch-clash-home-"));

describe("the subscription AgentSwitch works from", () => {
  it("keeps a file and fetches the node sets it names, as Clash would ask", async () => {
    const { fetcher, asked } = service({ [LINK]: { body: PROVIDED, headers: { "Subscription-Userinfo": "upload=1; download=2; total=100; expire=1893456000" } } });
    const dir = home();
    const source = new ClashSource(dir, fetcher, () => 1_000, () => "clash.meta/v1.19.31");
    expect(source.info()).toBeNull();
    const info = await source.setFile(OWN, "tgyun_config.yaml");
    expect(asked).toEqual([`clash.meta/v1.19.31 ${LINK}`]);
    expect(info).toEqual({ kind: "file", name: "tgyun_config.yaml", updatedAt: 1_000, nodes: 3, userinfo: "upload=1; download=2; total=100; expire=1893456000",
      providers: [{ name: "tgyun", host: "sub.example:9888", updatedAt: 1_000, nodes: 3 }] });
    expect(source.nodes().map((n) => [n.name, n.from])).toEqual([["🇯🇵 日本家宽-01", "tgyun"], ["🇯🇵 日本家宽-02", "tgyun"], ["🇺🇸 美国-01", "tgyun"]]);
    expect(source.nodes()[0]!.definition).toEqual(node("🇯🇵 日本家宽-01"));
    expect(source.held()).toEqual(["tgyun"]);
    expect(source.provider(providerSlug("tgyun"))).toEqual({ text: PROVIDED, userinfo: "upload=1; download=2; total=100; expire=1893456000" });
    expect(source.provider("nope")).toBeNull();
    // Only the user reads what is kept; what the screens are told has no link in it.
    for (const file of ["main.yaml", "meta.json", `provider-${providerSlug("tgyun")}.yaml`]) expect(statSync(join(dir, "clash", "source", file)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "clash", "source")).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(info)).not.toContain("secret");
    // A second one over the same folder reads what the first kept.
    expect(new ClashSource(dir, fetcher).info()?.nodes).toBe(3);
    source.remove();
    expect(source.info()).toBeNull();
    expect(source.nodes()).toEqual([]);
  });

  it("works from a link, fetched again when asked or due; a fetch that fails leaves what was kept", async () => {
    let body = PLAIN, status = 200, t = 1_000;
    const { fetcher } = service({ [LINK]: () => ({ status, body, headers: { "subscription-userinfo": "upload=0; download=5; total=10" } }) });
    const source = new ClashSource(home(), fetcher, () => t);
    expect(await source.setLink(` ${LINK} `)).toMatchObject({ kind: "link", name: "sub.example:9888", host: "sub.example:9888", nodes: 2, providers: [] });
    expect(source.due(1)).toBe(false);
    t += 3_600_000;
    expect([source.due(1), source.due(6), source.due(0)]).toEqual([true, false, false]);
    body = PLAIN.replace("SG 01", "SG 02");
    expect((await source.refresh())?.updatedAt).toBe(t);
    expect(source.nodes().map((n) => n.name)).toEqual(["HK 01", "SG 02"]);
    status = 502;
    const failed = await source.refresh();
    expect(failed?.error).toBe("sub.example:9888 回了 502");
    expect(source.nodes().map((n) => n.name)).toEqual(["HK 01", "SG 02"]);
    status = 200; body = "dm1lc3M6Ly9ub3QtY2xhc2g=";
    expect((await source.refresh())?.error).toMatch(/不是 Clash 格式/);
    expect(source.nodes()).toHaveLength(2);
  });

  it("refuses what is not a Clash subscription, and says where a fetch failed without its link", async () => {
    const { fetcher } = service({ "https://ok.example/a?token=secret": { body: "dm1lc3M6Ly9ub3QtY2xhc2g=" }, "https://down.example/a?token=secret": { status: 403 } });
    const source = new ClashSource(home(), fetcher);
    await expect(source.setLink("ftp://x/y")).rejects.toThrow(/http/);
    await expect(source.setLink("https://ok.example/a?token=secret")).rejects.toThrow(ClashSourceError);
    await expect(source.setLink("https://down.example/a?token=secret")).rejects.toThrow("down.example 回了 403");
    await expect(source.setLink("https://nowhere.example/a?token=secret")).rejects.toThrow("连不上 nowhere.example");
    await expect(source.setFile("rules: [ 'MATCH,DIRECT' ]\n", "x.yaml")).rejects.toThrow(/没有节点/);
    expect(source.info()).toBeNull();
    // A node set that cannot be fetched: the file is kept, that set is said to have failed and is not held.
    const kept = await source.setFile(OWN, "own.yaml");
    expect(kept).toMatchObject({ nodes: 0, providers: [{ name: "tgyun", updatedAt: null, nodes: 0, error: "连不上 sub.example:9888" }] });
    expect(source.held()).toEqual([]);
  });
});

function verge() {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-verge-"));
  mkdirSync(join(dir, "profiles"));
  writeFileSync(join(dir, "profiles.yaml"), `current: Lbw7BJYzpand\nitems:\n- uid: Merge\n  type: merge\n  file: Merge.yaml\n- uid: Lbw7BJYzpand\n  type: local\n  name: mine.yaml\n  file: Lbw7BJYzpand.yaml\n- uid: Ro3yUVdr9kT1\n  type: remote\n  name: Other\n  file: Ro3yUVdr9kT1.yaml\n  url: ${LINK}\n- uid: Own1234567\n  type: remote\n  name: AgentSwitch\n  file: Own1234567.yaml\n  url: http://127.0.0.1:4711/clash/sub.yaml?k=x\n`);
  writeFileSync(join(dir, "profiles", "Lbw7BJYzpand.yaml"), OWN);
  return dir;
}

describe("Clash Verge as it is found", () => {
  it("lists its subscriptions without their tokens, reads one's text, and gives one's link only to import it", () => {
    const dir = verge();
    expect(vergeProfiles(dir)).toEqual({ current: "Lbw7BJYzpand", profiles: [{ uid: "Lbw7BJYzpand", name: "mine.yaml", type: "local", file: "Lbw7BJYzpand.yaml" },
      { uid: "Ro3yUVdr9kT1", name: "Other", type: "remote", file: "Ro3yUVdr9kT1.yaml", from: "https://sub.example:9888" },
      { uid: "Own1234567", name: "AgentSwitch", type: "remote", file: "Own1234567.yaml", from: "http://127.0.0.1:4711" }] });
    expect(vergeProfileText("Lbw7BJYzpand", dir)).toBe(OWN);
    expect(vergeProfileText("Merge", dir)).toBeNull();
    expect([vergeProfileLink("Ro3yUVdr9kT1", dir), vergeProfileLink("Lbw7BJYzpand", dir), vergeProfileLink("Merge", dir)]).toEqual([LINK, null, null]);
    expect(vergeProfiles(join(dir, "nowhere"))).toBeNull();
    // Its own DNS settings: off unless its settings say they are on.
    expect(vergeOwnDns(dir)).toBe(false);
    writeFileSync(join(dir, "verge.yaml"), "enable_tun_mode: true\nenable_dns_settings: true\n");
    expect(vergeOwnDns(dir)).toBe(true);
  });
});

/** A core's controller on a unix socket: the answers the real one gave on 2026-10-08, cut down. `state` is what it
 *  runs: the member each group uses, its node sets, its rule sets. */
async function core(start: { nodeSets?: Record<string, string[]>; ruleSets?: string[]; groups?: string[] } = {}) {
  const calls: string[] = [];
  const state = { now: { Claude: "Claude自动选择", "Claude自动选择": "🇯🇵 日本家宽-02" } as Record<string, string>,
    nodeSets: start.nodeSets ?? { tgyun: NODES.map((n) => n.name), "as-claude": ["🇯🇵 日本家宽-02", "🇯🇵 日本家宽-01"] },
    ruleSets: start.ruleSets ?? [...RULE_SETS], groups: start.groups ?? ["OpenAI自动选择", "OpenAI", "Manual", "Auto"], delays: { "🇯🇵 日本家宽-01": 392, "🇯🇵 日本家宽-02": 428 } as Record<string, number> };
  const server: Server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = decodeURIComponent(req.url ?? "");
      calls.push(`${req.method} ${url} ${body}`.trim());
      const send = (o: unknown, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(o === null ? "" : JSON.stringify(o)); };
      const members = (group: string): string[] => (group === "Claude" ? ["Claude自动选择", ...(state.nodeSets["as-claude"] ?? [])] : state.nodeSets["as-claude"] ?? []);
      if (req.method === "PUT" && url.startsWith("/proxies/")) {
        const group = url.slice("/proxies/".length), name = JSON.parse(body).name as string;
        if (!members(group).includes(name)) return send({ message: "Proxy does not exist" }, 400);
        state.now[group] = name; return send(null, 204);
      }
      if (req.method === "PUT") return send(null, 204);
      if (url === "/version") return send({ meta: true, version: "v1.19.31" });
      if (url === "/configs") return send({ mode: "rule", tun: { enable: true } });
      if (url === "/providers/rules") return send({ providers: Object.fromEntries(state.ruleSets.map((n) => [n, { ruleCount: 2 }])) });
      const check = /^\/providers\/proxies\/([^/]+)\/([^/]+)\/healthcheck\?url=(.+)&timeout=5000$/.exec(url);
      if (check) return state.nodeSets[check[1]!]?.includes(check[2]!) && state.delays[check[2]!] ? send({ delay: state.delays[check[2]!] }) : send({ message: "Timeout" }, 504);
      if (url === "/providers/proxies") return send({ providers: {
        default: { vehicleType: "Compatible", proxies: [{ name: "DIRECT", type: "Direct" }, { name: "Claude", type: "Selector", all: [] }] },
        ...Object.fromEntries(Object.entries(state.nodeSets).map(([set, names]) => [set, { vehicleType: "HTTP", proxies: names.map((name) => ({ name, type: "Vless" })) }])) } });
      if (url === "/proxies") return send({ proxies: { DIRECT: { type: "Direct" }, COMPATIBLE: { type: "Compatible" }, "Inline SG": { type: "Shadowsocks" },
        Claude: { type: "Selector", now: state.now.Claude, all: members("Claude") },
        "Claude自动选择": { type: "Fallback", now: state.now["Claude自动选择"], all: members("Claude自动选择") },
        ...Object.fromEntries(state.groups.map((name) => [name, { type: "Selector", now: "DIRECT", all: ["DIRECT"] }])) } });
      send({}, 404);
    });
  });
  const socket = join(mkdtempSync(join(tmpdir(), "as-clash-")), "c.sock");
  await new Promise<void>((ok) => server.listen(socket, ok));
  closers.push(() => server.close());
  return { socket, calls, state };
}

describe("the core's controller", () => {
  it("says what runs, picks a member, has one set read again, and asks how long a node takes", async () => {
    const { socket, calls } = await core();
    const ctl = new ClashController(socket);
    const status = await ctl.status();
    expect(status).toMatchObject({ version: "v1.19.31", mode: "rule", tun: true, ruleSets: { "as-direct": 2 },
      nodes: ["Inline SG", "🇯🇵 日本家宽-01", "🇯🇵 日本家宽-02", "🇺🇸 美国-01"],
      nodeSets: { tgyun: ["🇯🇵 日本家宽-01", "🇯🇵 日本家宽-02", "🇺🇸 美国-01"], "as-claude": ["🇯🇵 日本家宽-02", "🇯🇵 日本家宽-01"] } });
    expect(status.groups.slice(0, 2).map((g) => [g.name, g.type, g.now])).toEqual([["Claude", "Selector", "Claude自动选择"], ["Claude自动选择", "Fallback", "🇯🇵 日本家宽-02"]]);
    expect(status.groups.map((g) => g.name)).toEqual(["Claude", "Claude自动选择", "OpenAI自动选择", "OpenAI", "Manual", "Auto"]);
    await ctl.select("Claude", "🇯🇵 日本家宽-01");
    await ctl.refreshRuleSet("as-direct");
    await ctl.refreshNodeSet("as-claude");
    expect(calls.slice(-3)).toEqual(['PUT /proxies/Claude {"name":"🇯🇵 日本家宽-01"}', "PUT /providers/rules/as-direct", "PUT /providers/proxies/as-claude"]);
    expect(await ctl.delay("as-claude", "🇯🇵 日本家宽-02", "https://api.anthropic.com/", 5000)).toBe(428);
    expect(calls.at(-1)).toBe("GET /providers/proxies/as-claude/🇯🇵 日本家宽-02/healthcheck?url=https://api.anthropic.com/&timeout=5000");
    expect(await ctl.delay("as-claude", "🇺🇸 美国-01", "https://api.anthropic.com/", 5000)).toBeNull();
    await expect(new ClashController(join(tmpdir(), "no-such.sock")).status()).rejects.toThrow();
  });
});

describe("Clash Integration over HTTP", () => {
  async function served(start?: Parameters<typeof core>[0]) {
    const dir = verge();
    const running = await core(start);
    let body = PROVIDED, t = 1_000;
    const upstream = service({ [LINK]: () => ({ body, headers: { "subscription-userinfo": "upload=1; download=2; total=100; expire=1893456000" } }) });
    const at = home();
    const clash = new ClashIntegration({ store: new ClashStore(at), source: new ClashSource(at, upstream.fetcher, () => t), dir, socket: () => running.socket, base: () => "http://127.0.0.1:4711", now: () => t });
    const app = new Hono();
    mountClash(app, { clash } as unknown as ApiDeps);
    const call = async (method: string, path: string, json?: unknown, env: object = {}) => {
      const res = await app.request(path, { method, ...(json ? { headers: { "content-type": "application/json" }, body: JSON.stringify(json) } : {}) }, env);
      const text = await res.text();
      let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* yaml */ }
      return { status: res.status, text, json: parsed, headers: res.headers };
    };
    return { call, clash, ...running, asked: upstream.asked, upstream: { set body(v: string) { body = v; } }, clock: { add(ms: number) { t += ms; } } };
  }
  const chosen = { claude: { nodes: ["🇯🇵 日本家宽-02", "🇯🇵 日本家宽-01"] }, openai: { nodes: [] }, direct: ["5.102.107.254"], autoUpdateHours: 6,
    templates: { domestic: { on: false, rules: null as string[] | null }, block: { on: false, rules: null as string[] | null } }, renameDefault: false,
    dns: { on: false, text: null as string | null } };

  it("shows what was found; takes a subscription of Clash Verge's in; what is saved is the core's at once", async () => {
    const { call, calls, asked } = await served();
    const first = (await call("GET", "/clash")).json;
    expect(first).toMatchObject({ found: true, running: true, version: "v1.19.31", tun: true, source: null, nodes: [], active: true, fetchedAt: null,
      settings: { claude: { nodes: [] }, openai: { nodes: [] }, direct: [], autoUpdateHours: 24, templates: { domestic: { on: false, rules: null }, block: { on: false, rules: null } }, renameDefault: false, dns: { on: false, text: null } },
      dns: { on: false, custom: false, overridden: false },
      templates: { domestic: { on: false, custom: false, count: 169 }, block: { on: false, custom: false, count: 27 } }, defaultGroup: null });
    // Clash Verge's own subscriptions to import; the one that is AgentSwitch's is not among them.
    expect(first.profiles.map((p: { name: string }) => p.name)).toEqual(["mine.yaml", "Other"]);
    expect(first.install).toMatch(/^clash:\/\/install-config\?url=http%3A%2F%2F127\.0\.0\.1%3A4711%2Fclash%2Fsub\.yaml%3Fk%3D[\w-]+&name=AgentSwitch$/);
    expect((await call("GET", "/clash", undefined, markRemote({}, { deviceId: "phone" }))).status).toBe(403);

    const imported = await call("POST", "/clash/source", { verge: "Lbw7BJYzpand" });
    expect(imported.json).toMatchObject({ source: { kind: "file", name: "mine.yaml", nodes: 3, traffic: { used: 3, total: 100, expire: 1893456000000 }, providers: [{ name: "tgyun", host: "sub.example:9888", nodes: 3 }] },
      nodes: ["🇯🇵 日本家宽-01", "🇯🇵 日本家宽-02", "🇺🇸 美国-01"] });
    expect(asked).toEqual([`clash.meta/v1.19.0 ${LINK}`]);
    expect(imported.text).not.toContain("secret");
    // A core that runs AgentSwitch's subscription is told to take the node set again from AgentSwitch's copy.
    expect(calls).toContain("PUT /providers/proxies/tgyun");

    calls.length = 0;
    const saved = await call("PUT", "/clash/settings", chosen);
    expect(saved.json).toMatchObject({ settings: chosen, active: true, upToDate: true,
      services: { claude: { group: "Claude", auto: "Claude自动选择", live: true, now: "Claude自动选择", autoNow: "🇯🇵 日本家宽-02", missing: [] },
        openai: { group: "OpenAI", auto: "OpenAI自动选择", live: false, now: null, autoNow: null } } });
    const puts = calls.filter((c) => c.startsWith("PUT "));
    expect(puts.sort()).toEqual(["PUT /providers/proxies/as-claude", ...[...RULE_SETS].sort().map((name) => `PUT /providers/rules/${name}`)]);
    // A node for OpenAI: a group has to appear, so Clash Verge has to fetch the subscription again — and no node set
    // the core does not have is asked of it.
    calls.length = 0;
    const more = await call("PUT", "/clash/settings", { ...chosen, openai: { nodes: ["🇺🇸 美国-01"] } });
    expect(more.json).toMatchObject({ active: true, upToDate: false, services: { openai: { live: false } } });
    expect(calls.filter((c) => c.includes("as-openai") && c.includes("/providers/proxies/"))).toEqual([]);
    expect((await call("PUT", "/clash/settings", { ...chosen, autoUpdateHours: 5 })).status).toBe(400);
  });

  it("picks what a service's group uses and asks the core how long its nodes take", async () => {
    const { call, calls, state } = await served();
    await call("POST", "/clash/source", { verge: "Lbw7BJYzpand" });
    await call("PUT", "/clash/settings", chosen);
    const picked = await call("POST", "/clash/select", { service: "claude", node: "🇯🇵 日本家宽-01" });
    expect(picked.json.services.claude).toMatchObject({ now: "🇯🇵 日本家宽-01", autoNow: "🇯🇵 日本家宽-02" });
    expect(state.now.Claude).toBe("🇯🇵 日本家宽-01");
    expect((await call("POST", "/clash/select", { service: "claude", node: null })).json.services.claude.now).toBe("Claude自动选择");
    expect(calls.filter((c) => c.startsWith("PUT /proxies/"))).toEqual(['PUT /proxies/Claude {"name":"🇯🇵 日本家宽-01"}', 'PUT /proxies/Claude {"name":"Claude自动选择"}']);
    // A node that is not of the group, a service whose groups the core does not have: said, nothing changed.
    expect(await call("POST", "/clash/select", { service: "claude", node: "🇺🇸 美国-01" })).toMatchObject({ status: 400, json: { error: "这一组里没有这个节点" } });
    expect((await call("POST", "/clash/select", { service: "openai", node: null })).status).toBe(400);

    expect((await call("POST", "/clash/delays", { service: "claude", scope: "chosen" })).json).toEqual({ delays: { "🇯🇵 日本家宽-02": 428, "🇯🇵 日本家宽-01": 392 } });
    // Its own node set where the node is in it, else whichever set has the node; a node that does not answer: null.
    expect(calls.filter((c) => c.includes("/healthcheck")).map((c) => c.split("/")[3])).toEqual(["as-claude", "as-claude"]);
    expect((await call("POST", "/clash/delays", { service: "openai", scope: "all" })).json).toEqual({ delays: { "🇯🇵 日本家宽-01": 392, "🇯🇵 日本家宽-02": 428, "🇺🇸 美国-01": null } });
    expect(calls.at(-1)).toContain("/providers/proxies/tgyun/🇺🇸 美国-01/healthcheck?url=https://api.openai.com/");
  });

  it("fetches the subscription again when asked and when its interval has passed, and tells the core", async () => {
    const { call, calls, clash, asked, upstream, clock } = await served();
    await call("POST", "/clash/source", { link: LINK });
    expect((await call("GET", "/clash")).json.source).toMatchObject({ kind: "link", host: "sub.example:9888", nodes: 3, providers: [] });
    await call("PUT", "/clash/settings", { ...chosen, autoUpdateHours: 1 });
    upstream.body = PROVIDED.replace("🇺🇸 美国-01", "🇺🇸 美国-02");
    calls.length = 0;
    await clash.tick();
    expect(asked).toHaveLength(1);                      // not due yet
    clock.add(3_600_000);
    await clash.tick();
    expect(asked).toHaveLength(2);
    expect((await call("GET", "/clash")).json.nodes).toEqual(["🇯🇵 日本家宽-01", "🇯🇵 日本家宽-02", "🇺🇸 美国-02"]);
    expect(calls).toContain("PUT /providers/proxies/as-claude");
    upstream.body = PROVIDED;
    const updated = await call("POST", "/clash/update");
    expect(asked).toHaveLength(3);
    expect(updated.json.nodes).toContain("🇺🇸 美国-01");
    expect((await call("DELETE", "/clash/source")).json).toMatchObject({ source: null, nodes: [] });
    // A link that is not a Clash subscription: said, nothing kept.
    expect(await call("POST", "/clash/source", { link: "https://nowhere.example/x" })).toMatchObject({ status: 400, json: { error: "连不上 nowhere.example" } });
    expect((await call("POST", "/clash/source", { verge: "Nope1234" })).status).toBe(400);
  });

  it("leaves a core that does not run its subscription alone", async () => {
    const { call, calls } = await served({ nodeSets: { tgyun: NODES.map((n) => n.name) }, ruleSets: [], groups: ["OpenAI自动选择", "OpenAI", "Manual", "Auto"] });
    await call("POST", "/clash/source", { verge: "Lbw7BJYzpand" });
    const saved = await call("PUT", "/clash/settings", chosen);
    expect(saved.json).toMatchObject({ active: false, upToDate: false, services: { claude: { live: false, now: null } } });
    expect(calls.filter((c) => c.startsWith("PUT "))).toEqual([]);
    // The nodes can still be tried, through the node set the core has them in.
    expect((await call("POST", "/clash/delays", { service: "claude", scope: "chosen" })).json.delays).toEqual({ "🇯🇵 日本家宽-02": 428, "🇯🇵 日本家宽-01": 392 });
    expect((await call("POST", "/clash/select", { service: "claude", node: null })).status).toBe(400);
  });

  it("hands Clash Verge the subscription and the core its sets, to whoever holds the token and nobody else", async () => {
    const { call, clash } = await served();
    const k = clash.token();
    expect((await call("GET", `/clash/sub.yaml?k=${k}`)).status).toBe(503);   // nothing to work from yet
    await call("POST", "/clash/source", { verge: "Lbw7BJYzpand" });
    expect((await call("GET", `/clash/nodes/as-claude.yaml?k=${k}`)).status).toBe(503);   // no node chosen: no empty set
    await call("PUT", "/clash/settings", chosen);
    const sub = await call("GET", `/clash/sub.yaml?k=${k}&name=AgentSwitch`);   // Clash Verge adds a parameter of its own
    expect(sub.status).toBe(200);
    expect([sub.headers.get("profile-update-interval"), sub.headers.get("subscription-userinfo")]).toEqual(["1", "upload=1; download=2; total=100; expire=1893456000"]);
    const made = parse(sub.text) as Record<string, any>;
    expect(made.rules.slice(0, 2)).toEqual(["RULE-SET,as-direct,DIRECT", "RULE-SET,as-claude,Claude"]);
    expect(made["proxy-providers"]["as-claude"].url).toBe(`http://127.0.0.1:4711/clash/nodes/as-claude.yaml?k=${k}`);
    // The subscription service's own link is nowhere in what Clash Verge is handed.
    expect(sub.text).not.toContain("secret");
    expect((await call("GET", "/clash")).json).toMatchObject({ fetchedAt: 1_000, upToDate: true });
    expect(parse((await call("GET", `/clash/nodes/as-claude.yaml?k=${k}`)).text)).toEqual({ proxies: [node("🇯🇵 日本家宽-02"), node("🇯🇵 日本家宽-01")] });
    expect(parse((await call("GET", `/clash/rules/as-direct.yaml?k=${k}`)).text)).toEqual({ payload: ["IP-CIDR,5.102.107.254/32,no-resolve"] });
    const copy = await call("GET", `/clash/providers/${providerSlug("tgyun")}.yaml?k=${k}`);
    expect([copy.status, copy.text, copy.headers.get("subscription-userinfo")]).toEqual([200, PROVIDED, "upload=1; download=2; total=100; expire=1893456000"]);
    for (const path of ["/clash/sub.yaml", "/clash/sub.yaml?k=wrong", "/clash/rules/as-direct.yaml", "/clash/nodes/as-claude.yaml", `/clash/providers/${providerSlug("tgyun")}.yaml`,
      `/clash/rules/unknown.yaml?k=${k}`, `/clash/providers/unknown.yaml?k=${k}`]) expect((await call("GET", path)).status, path).toBe(404);
    expect((await call("GET", `/clash/nodes/as-claude.yaml?k=${k}`, undefined, markRemote({}, { deviceId: "phone" }))).status).toBe(404);
    // The local listener lets exactly these kinds of address through without its own token.
    const auth = new LocalAuth("local-token-0123456789abcdefghijklmnopqrstuv");
    const open = (path: string, method = "GET") => auth.check(new Request(`http://127.0.0.1:4711${path}`, { method })) === null;
    expect([open("/clash/sub.yaml?k=x"), open("/clash/rules/as-direct.yaml?k=x"), open("/clash/nodes/as-claude.yaml?k=x"), open(`/clash/providers/${providerSlug("节点集")}.yaml?k=x`)]).toEqual([true, true, true, true]);
    expect([open("/clash"), open("/clash/settings"), open("/clash/source", "POST"), open("/clash/update", "POST"), open("/clash/rules/../../x"), open("/clash/nodes/a.yaml", "POST")]).toEqual([false, false, false, false, false, false]);
  });

  it("answers the same address again and again through the real local listener", async () => {
    const { clash } = await served();
    await clash.setSource({ verge: "Lbw7BJYzpand" });
    await clash.saveSettings(chosen);
    const app = new Hono();
    mountClash(app, { clash } as unknown as ApiDeps);
    const port = await new Promise<number>((ok) => { const server = listenLocal({ app }, 0, (info) => ok(info.port), new LocalAuth("local-token-0123456789abcdefghijklmnopqrstuv")); closers.push(() => server.close()); });
    // The core asks for each set over and over; the second answer once failed where the first did not.
    for (const path of ["rules/as-direct.yaml", "rules/as-claude.yaml", "nodes/as-claude.yaml", "rules/as-direct.yaml", "nodes/as-claude.yaml", "sub.yaml", "sub.yaml", `providers/${providerSlug("tgyun")}.yaml`, `providers/${providerSlug("tgyun")}.yaml`]) {
      const res = await fetch(`http://127.0.0.1:${port}/clash/${path}?k=${clash.token()}`);
      expect([path, res.status, res.headers.get("content-type")]).toEqual([path, 200, "text/yaml; charset=utf-8"]);
      expect(Object.keys(parse(await res.text()) as object).length).toBeGreaterThan(0);
    }
    expect((await fetch(`http://127.0.0.1:${port}/clash/sub.yaml`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/clash`)).status).toBe(401);
  });

  it("turns a rule template on and takes the user's own rules for it, at once and by the line", async () => {
    const { call, calls } = await served();
    await call("POST", "/clash/source", { verge: "Lbw7BJYzpand" });
    expect((await call("GET", "/clash/templates/domestic")).json).toMatchObject({ custom: false, rules: expect.arrayContaining(["DOMAIN-SUFFIX,cn", "GEOIP,CN"]) });
    expect((await call("GET", "/clash/templates/nope")).status).toBe(404);
    expect((await call("GET", "/clash/templates/block", undefined, markRemote({}, { deviceId: "phone" }))).status).toBe(403);
    const k = (await call("GET", "/clash")).json.install.match(/k%3D([\w-]+)/)[1];
    const payload = async (name: string): Promise<string[]> => parse((await call("GET", `/clash/rules/${name}.yaml?k=${k}`)).text).payload;
    expect(await payload("as-block")).toEqual(["DOMAIN,agentswitch-nothing.invalid"]);

    calls.length = 0;
    const on = await call("PUT", "/clash/settings", { ...chosen, templates: { domestic: { on: true, rules: null }, block: { on: true, rules: null } } });
    // Only the sets' content changed: the core reads them again, and the subscription is still the one it has.
    expect(on.json).toMatchObject({ upToDate: true, templates: { domestic: { on: true, custom: false, count: 169 }, block: { on: true, custom: false, count: 27 } } });
    expect(calls).toEqual(expect.arrayContaining(["PUT /providers/rules/as-domestic", "PUT /providers/rules/as-domestic-ip", "PUT /providers/rules/as-block"]));
    expect([(await payload("as-domestic")).length + (await payload("as-domestic-ip")).length, (await payload("as-block")).length]).toEqual([169, 27]);

    // The user's own lines, as pasted: kept as rules, each once.
    const own = await call("PUT", "/clash/settings", { ...chosen, templates: { domestic: { on: true, rules: null }, block: { on: true, rules: ["  - DOMAIN-SUFFIX,doubleclick.net,REJECT  # ads", "", "# mine", "DOMAIN-KEYWORD,adservice", "DOMAIN-KEYWORD,adservice"] } } });
    expect(own.json).toMatchObject({ settings: { templates: { block: { on: true, rules: ["DOMAIN-SUFFIX,doubleclick.net", "DOMAIN-KEYWORD,adservice"] } } }, templates: { block: { custom: true, count: 2 } } });
    expect((await call("GET", "/clash/templates/block")).json).toEqual({ rules: ["DOMAIN-SUFFIX,doubleclick.net", "DOMAIN-KEYWORD,adservice"], custom: true });
    expect(await payload("as-block")).toEqual(["DOMAIN-SUFFIX,doubleclick.net", "DOMAIN-KEYWORD,adservice"]);
    // A line that is not a rule: said by its number, nothing kept.
    const bad = await call("PUT", "/clash/settings", { ...chosen, templates: { domestic: { on: true, rules: ["DOMAIN-SUFFIX,cn", "MATCH,DIRECT"] }, block: { on: false, rules: null } } });
    expect(bad).toMatchObject({ status: 400, json: { error: "第 2 行不是一条规则（这里不收 MATCH 这种规则）：MATCH,DIRECT" } });
    expect((await call("GET", "/clash")).json.templates).toMatchObject({ domestic: { on: true, custom: false }, block: { on: true, custom: true } });
    // Back to the built-in ones.
    expect((await call("PUT", "/clash/settings", { ...chosen, templates: { domestic: { on: false, rules: null }, block: { on: true, rules: null } } })).json.templates.block).toEqual({ on: true, custom: false, count: 27 });
  });

  it("takes the DNS template and the user's own text for it; Clash Verge has to fetch the subscription for it to count", async () => {
    const { call, clash, clock } = await served();
    await call("POST", "/clash/source", { verge: "Lbw7BJYzpand" });
    await call("PUT", "/clash/settings", chosen);
    expect((await call("GET", "/clash/dns")).json).toMatchObject({ custom: false, text: expect.stringContaining("enhanced-mode: fake-ip") });
    expect((await call("GET", "/clash/dns", undefined, markRemote({}, { deviceId: "phone" }))).status).toBe(403);
    // Clash Verge fetches: from then on what it has is known by its fingerprint.
    const k = clash.token();
    const before = parse((await call("GET", `/clash/sub.yaml?k=${k}`)).text) as Record<string, any>;
    expect(before.dns).toBeUndefined();
    expect((await call("GET", "/clash")).json).toMatchObject({ upToDate: true, dns: { on: false, custom: false, overridden: false } });
    // The template on: nothing the core shows has changed, yet what would be handed over has — it is to be fetched.
    clock.add(60_000);
    const on = await call("PUT", "/clash/settings", { ...chosen, dns: { on: true, text: null } });
    expect(on.json).toMatchObject({ upToDate: false, dns: { on: true, custom: false }, fetchedAt: 1_000 });
    const after = parse((await call("GET", `/clash/sub.yaml?k=${k}`)).text) as Record<string, any>;
    expect(after.dns).toMatchObject({ "enhanced-mode": "fake-ip", "proxy-server-nameserver": ["223.5.5.5", "119.29.29.29"] });
    expect((await call("GET", "/clash")).json).toMatchObject({ upToDate: true, fetchedAt: 61_000 });
    // The user's own text; one that is not a section is said and nothing is kept.
    const own = await call("PUT", "/clash/settings", { ...chosen, dns: { on: true, text: "enable: true\nnameserver:\n  - 223.5.5.5\n" } });
    expect(own.json).toMatchObject({ upToDate: false, dns: { on: true, custom: true } });
    expect((await call("GET", "/clash/dns")).json).toEqual({ text: "enable: true\nnameserver:\n  - 223.5.5.5\n", custom: true });
    expect(await call("PUT", "/clash/settings", { ...chosen, dns: { on: true, text: "- not\n- a section\n" } })).toMatchObject({ status: 400, json: { error: "DNS 这一段要是一组“键: 值”（dns: 下面的内容）" } });
    expect((await call("GET", "/clash")).json.dns).toMatchObject({ on: true, custom: true });
    // A change that lives in a set leaves the subscription as fetched: still the newest once it is fetched again.
    await call("GET", `/clash/sub.yaml?k=${k}`);
    expect((await call("PUT", "/clash/settings", { ...chosen, dns: { on: true, text: "enable: true\nnameserver:\n  - 223.5.5.5\n" }, direct: ["1.2.3.4"], templates: { domestic: { on: true, rules: null }, block: { on: false, rules: null } } })).json.upToDate).toBe(true);
  });

  it("offers to call a subscription's default group Manual, which Clash Verge has to fetch", async () => {
    const { call, clash } = await served({ nodeSets: {}, groups: ["Proxy"] });
    await clash.setSource({ yaml: PLAIN, name: "plain.yaml" });
    expect((await call("GET", "/clash")).json).toMatchObject({ defaultGroup: "Proxy", active: true, upToDate: true });
    const renamed = await call("PUT", "/clash/settings", { ...chosen, claude: { nodes: [] }, renameDefault: true });
    expect(renamed.json).toMatchObject({ defaultGroup: "Proxy", settings: { renameDefault: true }, active: true, upToDate: false });
    const made = parse((await call("GET", `/clash/sub.yaml?k=${clash.token()}`)).text) as Record<string, any>;
    expect([made["proxy-groups"].map((g: { name: string }) => g.name), made.rules.at(-1)]).toEqual([["Manual"], "MATCH,Manual"]);
    // The user's own file has a Manual: nothing is offered.
    await clash.setSource({ verge: "Lbw7BJYzpand" });
    expect((await call("GET", "/clash")).json.defaultGroup).toBeNull();
  });

  it("reads what a subscription service says is used", () => {
    expect(parseTraffic("upload=1; download=2; total=100; expire=1893456000")).toEqual({ used: 3, total: 100, expire: 1893456000000 });
    expect(parseTraffic("upload=0;download=5;total=10")).toEqual({ used: 5, total: 10, expire: null });
    expect(parseTraffic("nonsense")).toBeNull();
  });
});
