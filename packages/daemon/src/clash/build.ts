/** The subscription AgentSwitch hands to Clash Verge (docs/clash-v0.md §7.2): the one it works from as it is, and for
 *  each of Claude and OpenAI that has nodes chosen — a node set AgentSwitch serves (those nodes, in their order, by
 *  their own names), a group that uses the first of them that answers, and the group that decides where that traffic
 *  goes (the automatic one, or a node of the set). Its rules are in front of the subscription's own.
 *
 *  What changes from day to day is not in this text but in the sets it names — the node sets, the rule sets — which the
 *  core reads again one at a time. The text itself changes only when a group appears or goes. */

import { stringify } from "yaml";
import { providerSlug, type SourceNode } from "./source.js";

export const CLASH_SERVICES = ["claude", "openai"] as const;
export type ClashService = (typeof CLASH_SERVICES)[number];
export type ClashSettings = {
  readonly claude: { /** Nodes by name, the first preferred. */ readonly nodes: readonly string[] };
  readonly openai: { readonly nodes: readonly string[] };
  /** Addresses (an IP or a host) that go direct. */
  readonly direct: readonly string[];
  /** The subscription is fetched again after this many hours; 0: only when asked. */
  readonly autoUpdateHours: number;
};
export const EMPTY_SETTINGS: ClashSettings = { claude: { nodes: [] }, openai: { nodes: [] }, direct: [], autoUpdateHours: 24 };
export const UPDATE_HOURS = [0, 1, 6, 12, 24] as const;

/** Each service's names in Clash (the user's own file of 2026-10-08, docs/clash-v0.md §1), where its nodes are tried,
 *  and the domains it is reached at. The node set and the rule set have one name: they are two kinds of set. */
export const SERVICE: Record<ClashService, { readonly group: string; readonly auto: string; readonly set: string; readonly probe: string; readonly domains: readonly string[] }> = {
  claude: { group: "Claude", auto: "Claude自动选择", set: "as-claude", probe: "https://api.anthropic.com/",
    domains: ["DOMAIN-KEYWORD,anthropic", "DOMAIN-SUFFIX,claude.ai", "DOMAIN-SUFFIX,claude.com", "DOMAIN-SUFFIX,claudeusercontent.com"] },
  openai: { group: "OpenAI", auto: "OpenAI自动选择", set: "as-openai", probe: "https://api.openai.com/",
    domains: ["DOMAIN-KEYWORD,openai", "DOMAIN-SUFFIX,chatgpt.com", "DOMAIN-SUFFIX,chat.com", "DOMAIN-SUFFIX,sora.com", "DOMAIN-SUFFIX,oaistatic.com", "DOMAIN-SUFFIX,oaiusercontent.com"] },
};
export const DIRECT_SET = "as-direct";
const PROBE_SECONDS = 180;
/** How often Clash Verge is asked to fetch the subscription again, in hours: the least its header can say (§7.3). */
export const VERGE_UPDATE_HOURS = 1;

/** The nodes chosen for a service that the subscription still has, in their order. */
export function chosen(service: ClashService, settings: ClashSettings, nodes: readonly SourceNode[]): SourceNode[] {
  const by = new Map(nodes.map((n) => [n.name, n]));
  return [...new Set(settings[service].nodes)].flatMap((name) => by.get(name) ?? []);
}

/** A service's two groups by the names they have in this subscription: its own spelling of them where it has such
 *  groups (spaces and case aside — `Claude 自动选择` is `Claude自动选择`), else AgentSwitch's. */
export function groupNames(document: Record<string, unknown>, service: ClashService): { readonly group: string; readonly auto: string } {
  const names = groupsOf(document).map((g) => String(g.name ?? ""));
  const like = (want: string): string => names.find((n) => same(n, want)) ?? want;
  return { group: like(SERVICE[service].group), auto: like(SERVICE[service].auto) };
}

/** A node set's text, as the core fetches it: the chosen nodes in their order. Null when there is none — the core
 *  takes no empty set (it keeps the one it had), so none is ever handed to it. */
export function nodeSet(service: ClashService, settings: ClashSettings, nodes: readonly SourceNode[]): string | null {
  const list = chosen(service, settings, nodes);
  return list.length ? stringify({ proxies: list.map((n) => n.definition) }, { lineWidth: 0 }) : null;
}

/** A rule set's text, as the core fetches it. A service with no nodes has an empty one: its traffic goes as the
 *  subscription's own rules say. */
export function ruleSet(name: string, settings: ClashSettings, nodes: readonly SourceNode[]): string | null {
  const service = CLASH_SERVICES.find((s) => SERVICE[s].set === name);
  const payload = name === DIRECT_SET ? settings.direct.flatMap(directRule)
    : service ? (chosen(service, settings, nodes).length ? SERVICE[service].domains : []) : null;
  // An empty set still has to be a list: a rule nothing matches.
  return payload && stringify({ payload: payload.length ? payload : ["DOMAIN,agentswitch-nothing.invalid"] });
}

/** `IP-CIDR,1.2.3.4/32,no-resolve` for an address, `DOMAIN,host` for a name; nothing for what is neither. */
export function directRule(address: string): string[] {
  const a = address.trim().toLowerCase();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(a) && a.split(".").every((n) => Number(n) <= 255)) return [`IP-CIDR,${a}/32,no-resolve`];
  if (/^[0-9a-f:]+$/.test(a) && a.includes(":")) return [`IP-CIDR6,${a}/128,no-resolve`];
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(a) ? [`DOMAIN,${a}`] : [];
}

/** `document` (the subscription worked from; changed in place) with AgentSwitch's part added. `held`: the node sets
 *  AgentSwitch has a copy of, which the core is to fetch from it; `base`: where this Mac serves everything
 *  (`http://127.0.0.1:<port>/clash`); `token`: what each address has to carry. */
export function buildSubscription(document: Record<string, unknown>, nodes: readonly SourceNode[], held: readonly string[], settings: ClashSettings, base: string, token: string): string {
  const config = document;
  const at = (path: string): string => `${base}/${path}?k=${token}`;
  const groups = groupsOf(config);
  const front: Record<string, unknown>[] = [];
  const rules = [`RULE-SET,${DIRECT_SET},DIRECT`];
  const sets: Record<string, unknown> = {};
  for (const service of CLASH_SERVICES) {
    if (!chosen(service, settings, nodes).length) continue;
    const { set, probe } = SERVICE[service];
    const names = groupNames(config, service);
    const made: Record<string, unknown>[] = [
      { name: names.group, type: "select", proxies: [names.auto], use: [set] },
      { name: names.auto, type: "fallback", use: [set], url: probe, interval: PROBE_SECONDS },
    ];
    // A group the subscription already has by this name is this one from now on, where it stood: what names it
    // elsewhere — a rule, another group — goes on naming it.
    for (const group of made) {
      const i = groups.findIndex((g) => g.name === group.name);
      if (i >= 0) groups[i] = group; else front.push(group);
    }
    sets[set] = { type: "http", url: at(`nodes/${set}.yaml`), path: `./proxy_providers/${set}.yaml`, interval: 86400, proxy: "DIRECT",
      "health-check": { enable: true, url: probe, interval: PROBE_SECONDS } };
    rules.push(`RULE-SET,${set},${names.group}`);
  }
  // The node sets it fetched by link are fetched from AgentSwitch instead: one place asks the subscription service,
  // and what it brings back the core can be told to take at once.
  const own = record(config["proxy-providers"]);
  for (const name of held) {
    const set = record(own[name]);
    if (set.type === "http") own[name] = { ...set, url: at(`providers/${providerSlug(name)}.yaml`), proxy: "DIRECT" };
  }
  const ruleSets = Object.fromEntries([DIRECT_SET, ...CLASH_SERVICES.map((s) => SERVICE[s].set)].map((name) =>
    [name, { type: "http", behavior: "classical", format: "yaml", url: at(`rules/${name}.yaml`), path: `./ruleset/${name}.yaml`, interval: 86400, proxy: "DIRECT" }]));
  config["proxy-groups"] = [...front, ...groups];
  if (Object.keys(own).length || Object.keys(sets).length) config["proxy-providers"] = { ...own, ...sets };
  config["rule-providers"] = { ...record(config["rule-providers"]), ...ruleSets };
  config.rules = [...rules, ...(Array.isArray(config.rules) ? config.rules : [])];
  return stringify(config, { lineWidth: 0 });
}

/** What the core runs is this subscription (its rule sets are AgentSwitch's), and it is the one made now: each
 *  service has its node set there exactly when it has nodes chosen. Otherwise Clash Verge has to fetch it again. */
export function running(enabled: Readonly<Record<ClashService, boolean>>, status: { readonly ruleSets: Readonly<Record<string, number>>; readonly nodeSets: Readonly<Record<string, readonly string[]>> }): { active: boolean; current: boolean } {
  const active = DIRECT_SET in status.ruleSets;
  return { active, current: active && CLASH_SERVICES.every((service) => enabled[service] === (SERVICE[service].set in status.nodeSets)) };
}

const same = (a: string, b: string): boolean => a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const groupsOf = (config: Record<string, unknown>): Record<string, unknown>[] =>
  (Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : []).filter((g): g is Record<string, unknown> => !!g && typeof g === "object");
