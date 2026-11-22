/** The subscription for a phone's Clash or Stash (docs/clash-v0.md §12): whole in one text with nothing pointing back
 *  to this Mac, as the app that asks takes it; and the one address it is fetched at. */

import { stringify, parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { phoneApp, phoneConfig, type PhoneParts } from "../src/clash/phone.js";
import { listenPhone, PHONE_PATH, type PhoneListener } from "../src/clash/phoneListener.js";

const BASE = "http://127.0.0.1:4711/clash";
const at = (path: string) => `${BASE}/${path}?k=tok`;
const node = (name: string, type = "anytls") => ({ name, type, server: "s.example", port: 1, password: "p" });
const PARTS: PhoneParts = {
  base: BASE,
  nodeSet: (name) => (name === "as-claude" ? stringify({ proxies: [node("JP 2"), node("JP 1")] }) : null),
  provider: (slug) => (slug === "sub-1" ? stringify({ proxies: [node("HK 1"), node("JP 1"), node("JP 2"), node("US 1", "vless")] }) : null),
  ruleSet: (name) => stringify({ payload: name === "as-claude" ? ["DOMAIN-SUFFIX,claude.ai"] : name === "as-domestic" ? ["DOMAIN-SUFFIX,cn", "PROCESS-NAME,WeChat", "IP-CIDR,10.0.0.0/8"]
    : name === "as-domestic-ip" ? ["GEOIP,CN", "IP-CIDR,1.2.3.4/32,no-resolve"] : ["DOMAIN,agentswitch-nothing.invalid"] }),
};
/** What this Mac's Clash is handed, cut down: every node in a set AgentSwitch serves, every rule in a rule set. */
const made = (): Record<string, unknown> => ({
  "mixed-port": 7897, "external-controller": "127.0.0.1:9090", secret: "s", tun: { enable: true }, "log-level": "info", sniffer: { enable: true },
  dns: { enable: true, listen: "0.0.0.0:53", "respect-rules": true, nameserver: ["https://1.1.1.1/dns-query#Manual"], "nameserver-policy": { "+.a.com,+.b.com": ["223.5.5.5"], "rule-set:as-domestic": ["223.5.5.5"], "geosite:cn": ["223.5.5.5"] } },
  "proxy-groups": [
    { name: "Claude", type: "select", proxies: ["Claude自动选择"], use: ["as-claude"] },
    { name: "Claude自动选择", type: "fallback", use: ["as-claude"], url: "https://api.anthropic.com/", interval: 180 },
    { name: "Manual", type: "select", proxies: ["自动选择"], use: ["as-sub-1"] },
    { name: "自动选择", type: "url-test", use: ["as-sub-1"], "exclude-type": "vless", url: "https://www.gstatic.com/generate_204", interval: 300 },
    { name: "日本", type: "select", use: ["as-sub-1"], filter: "(?i)jp" },
  ],
  "proxy-providers": {
    "as-claude": { type: "http", url: at("nodes/as-claude.yaml"), path: "./a.yaml" },
    "as-sub-1": { type: "http", url: at("providers/sub-1.yaml"), path: "./b.yaml" },
  },
  "rule-providers": Object.fromEntries(["as-direct", "as-claude", "as-domestic", "as-domestic-ip"].map((n) => [n, { type: "http", behavior: "classical", url: at(`rules/${n}.yaml`) }])),
  rules: ["RULE-SET,as-direct,DIRECT", "RULE-SET,as-claude,Claude", "RULE-SET,as-claude,REJECT", "RULE-SET,as-domestic,DIRECT,no-resolve", "PROCESS-NAME,Telegram,Manual", "RULE-SET,as-domestic-ip,DIRECT", "MATCH,Manual"],
});

describe("the subscription for a phone", () => {
  it("tells Stash from the rest by what the app calls itself, unless the address says", () => {
    expect(phoneApp("Stash/3.1.0 Clash/1.11.0")).toBe("stash");
    expect(phoneApp("ClashMetaForAndroid/2.11.1.Meta")).toBe("mihomo");
    expect(phoneApp(undefined)).toBe("mihomo");
    expect(phoneApp("Stash/3", "mihomo")).toBe("mihomo");
    expect(phoneApp("curl/8", "stash")).toBe("stash");
    expect(phoneApp("Stash/3", "nonsense")).toBe("stash");
  });

  it("writes the nodes and the rules into the text, and names nothing on this Mac", () => {
    const source = made(), before = JSON.stringify(source);
    const config = phoneConfig(source, PARTS, "mihomo");
    expect(JSON.stringify(source)).toBe(before);   // what this Mac's Clash is handed is not changed
    expect(stringify(config)).not.toContain("4711");
    expect(config["proxy-providers"]).toBeUndefined();
    expect(config["rule-providers"]).toBeUndefined();
    // A node two sets hold is written once; the order is the first set's, then what the next adds.
    expect((config.proxies as { name: string }[]).map((p) => p.name)).toEqual(["JP 2", "JP 1", "HK 1", "US 1"]);
    const groups = Object.fromEntries((config["proxy-groups"] as { name: string; proxies: string[] }[]).map((g) => [g.name, g]));
    expect(groups["Claude"]!.proxies).toEqual(["Claude自动选择", "JP 2", "JP 1"]);
    expect(groups["Claude自动选择"]!.proxies).toEqual(["JP 2", "JP 1"]);
    expect(groups["Manual"]!.proxies).toEqual(["自动选择", "HK 1", "JP 1", "JP 2", "US 1"]);
    expect(groups["自动选择"]!.proxies).toEqual(["HK 1", "JP 1", "JP 2"]);          // exclude-type
    expect(groups["日本"]!.proxies).toEqual(["JP 1", "JP 2"]);                      // filter
    for (const g of Object.values(groups)) for (const key of ["use", "filter", "exclude-type"]) expect(g).not.toHaveProperty(key);
    expect(config.rules).toEqual([
      "DOMAIN-SUFFIX,claude.ai,Claude", "DOMAIN-SUFFIX,claude.ai,REJECT",
      "DOMAIN-SUFFIX,cn,DIRECT", "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve", "GEOIP,CN,DIRECT", "IP-CIDR,1.2.3.4/32,DIRECT,no-resolve", "MATCH,Manual"]);
  });

  it("leaves out what is this Mac's alone, and keeps the rest for a Clash with mihomo inside", () => {
    const config = phoneConfig(made(), PARTS, "mihomo");
    for (const key of ["mixed-port", "external-controller", "secret", "tun"]) expect(config).not.toHaveProperty(key);
    expect(config.sniffer).toEqual({ enable: true });
    const dns = config.dns as Record<string, unknown>;
    expect(dns).not.toHaveProperty("listen");
    expect(dns["respect-rules"]).toBe(true);
    expect(dns.nameserver).toEqual(["https://1.1.1.1/dns-query#Manual"]);
    expect(Object.keys(dns["nameserver-policy"] as object)).toEqual(["+.a.com,+.b.com", "geosite:cn"]);
  });

  it("gives Stash only what Stash reads, in its words", () => {
    const config = phoneConfig(made(), PARTS, "stash");
    expect(Object.keys(config).sort()).toEqual(["dns", "log-level", "proxies", "proxy-groups", "rules"]);
    expect(config.rules).toEqual([
      "DOMAIN-SUFFIX,claude.ai,Claude", "DOMAIN-SUFFIX,claude.ai,REJECT", "DOMAIN-SUFFIX,cn,DIRECT", "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
      "GEOIP,CN,DIRECT", "IP-CIDR,1.2.3.4/32,DIRECT,no-resolve", "MATCH,Manual"]);
    expect(config.dns).toEqual({ nameserver: ["https://1.1.1.1/dns-query"], "nameserver-policy": { "+.a.com": ["223.5.5.5"], "+.b.com": ["223.5.5.5"], "geosite:cn": ["223.5.5.5"] }, "follow-rule": true });
  });

  it("leaves a set someone else serves a set, and has a group that lost every node reject", () => {
    const source = made();
    (source["proxy-providers"] as Record<string, unknown>).theirs = { type: "http", url: "https://sub.example/x" };
    (source["proxy-groups"] as Record<string, unknown>[]).push({ name: "Mixed", type: "select", use: ["theirs", "as-claude"] }, { name: "Empty", type: "select", use: ["as-claude"], filter: "nothing-like-this" });
    const config = phoneConfig(source, PARTS, "mihomo");
    expect(Object.keys(config["proxy-providers"] as object)).toEqual(["theirs"]);
    const groups = Object.fromEntries((config["proxy-groups"] as { name: string }[]).map((g) => [g.name, g as Record<string, unknown>]));
    expect(groups["Mixed"]).toMatchObject({ use: ["theirs"], proxies: ["JP 2", "JP 1"] });
    expect(groups["Empty"]!.proxies).toEqual(["REJECT"]);
  });
});

describe("the address a phone fetches it at", () => {
  let listener: PhoneListener | null = null;
  afterEach(async () => { await listener?.close(); listener = null; });
  const clash = (on = true) => {
    const seen: (string | undefined)[] = [];
    return { seen, phoneOn: () => on, phoneToken: () => "token-of-now-0123456789", phone: (agent: string | undefined, asked?: string) => { seen.push(agent, asked); return { text: "mode: rule\n", app: "stash" as const, headers: { "profile-update-interval": "12" } }; } };
  };
  const get = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${listener!.port}${path}`, init);

  it("answers the one address with its token, and nothing else", async () => {
    const c = clash();
    listener = await listenPhone(c, 0, { host: "127.0.0.1", log: () => undefined, allowSource: () => true });
    const ok = await get(`${PHONE_PATH}?k=token-of-now-0123456789&for=stash`, { headers: { "user-agent": "Stash/3.1.0" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/yaml");
    expect(ok.headers.get("profile-update-interval")).toBe("12");
    expect(parse(await ok.text())).toEqual({ mode: "rule" });
    expect(c.seen).toEqual(["Stash/3.1.0", "stash"]);
    for (const path of [`${PHONE_PATH}?k=wrong`, PHONE_PATH, "/clash/sub.yaml?k=token-of-now-0123456789", "/", "/clash", `/x${PHONE_PATH}?k=token-of-now-0123456789`]) expect((await get(path)).status).toBe(404);
    expect((await get(`${PHONE_PATH}?k=token-of-now-0123456789`, { method: "POST" })).status).toBe(404);
  });

  it("is not there while switched off, nor for a caller from outside the home networks", async () => {
    listener = await listenPhone(clash(false), 0, { host: "127.0.0.1", log: () => undefined, allowSource: () => true });
    expect((await get(`${PHONE_PATH}?k=token-of-now-0123456789`)).status).toBe(404);
    await listener.close();
    listener = await listenPhone(clash(), 0, { host: "127.0.0.1", log: () => undefined, allowSource: () => false });
    await expect(get(`${PHONE_PATH}?k=token-of-now-0123456789`)).rejects.toThrow();
  });
});
