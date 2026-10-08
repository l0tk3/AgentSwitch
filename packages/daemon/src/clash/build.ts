/** The subscription AgentSwitch hands to Clash Verge (docs/clash-v0.md §7.2, §7.7): the one it works from as it is,
 *  and for each of Claude and OpenAI that has nodes chosen — a node set AgentSwitch serves (those nodes, in their
 *  order, by their own names), a group that uses the first of them that answers, and the group that decides where that
 *  traffic goes (the automatic one, or a node of the set). Its rules are in front of the subscription's own; the rule
 *  templates (domestic direct, blocking) are rule sets too, the broad ones after the subscription's rules.
 *
 *  What changes from day to day is not in this text but in the sets it names — the node sets, the rule sets — which the
 *  core reads again one at a time. The text itself changes only when a group appears, goes or is renamed. */

import { parse, stringify } from "yaml";
import { looksUp } from "./rules.js";
import { providerSlug, type SourceNode } from "./source.js";
import { BLOCK_TEMPLATE, DNS_TEMPLATE, DOMESTIC_TEMPLATE } from "./templates.js";

export const CLASH_SERVICES = ["claude", "openai"] as const;
export type ClashService = (typeof CLASH_SERVICES)[number];
export const CLASH_TEMPLATES = ["domestic", "block"] as const;
export type ClashTemplate = (typeof CLASH_TEMPLATES)[number];
export type TemplateSetting = { readonly on: boolean; /** The user's own rules; null: the template as it is built in. */ readonly rules: readonly string[] | null };
export type ClashSettings = {
  readonly claude: { /** Nodes by name, the first preferred. */ readonly nodes: readonly string[] };
  readonly openai: { readonly nodes: readonly string[] };
  /** Addresses (an IP or a host) that go direct. */
  readonly direct: readonly string[];
  /** The subscription is fetched again after this many hours; 0: only when asked. */
  readonly autoUpdateHours: number;
  /** The rule templates: domestic and local traffic direct, ads and trackers rejected. */
  readonly templates: Readonly<Record<ClashTemplate, TemplateSetting>>;
  /** The subscription's default group — the hand-picked one its last rule sends everything else to — is called
   *  `Manual` in what is handed over. */
  readonly renameDefault: boolean;
  /** The DNS template (§7.8): on, what is handed over has it under `dns:` in place of the subscription's own.
   *  `text`: the user's own (YAML, what goes under `dns:`); null: the built-in one. */
  readonly dns: { readonly on: boolean; readonly text: string | null };
};
export const EMPTY_SETTINGS: ClashSettings = { claude: { nodes: [] }, openai: { nodes: [] }, direct: [], autoUpdateHours: 24,
  templates: { domestic: { on: false, rules: null }, block: { on: false, rules: null } }, renameDefault: false, dns: { on: false, text: null } };
export const UPDATE_HOURS = [0, 1, 6, 12, 24] as const;
export const BUILT_IN: Readonly<Record<ClashTemplate, readonly string[]>> = { domestic: DOMESTIC_TEMPLATE, block: BLOCK_TEMPLATE };

/** Each service's names in Clash (the user's own file of 2026-10-08, docs/clash-v0.md §1), where its nodes are tried,
 *  and the domains it is reached at. The node set and the rule set have one name: they are two kinds of set. */
export const SERVICE: Record<ClashService, { readonly group: string; readonly auto: string; readonly set: string; readonly probe: string; readonly domains: readonly string[] }> = {
  claude: { group: "Claude", auto: "Claude自动选择", set: "as-claude", probe: "https://api.anthropic.com/",
    domains: ["DOMAIN-KEYWORD,anthropic", "DOMAIN-SUFFIX,claude.ai", "DOMAIN-SUFFIX,claude.com", "DOMAIN-SUFFIX,claudeusercontent.com"] },
  openai: { group: "OpenAI", auto: "OpenAI自动选择", set: "as-openai", probe: "https://api.openai.com/",
    domains: ["DOMAIN-KEYWORD,openai", "DOMAIN-SUFFIX,chatgpt.com", "DOMAIN-SUFFIX,chat.com", "DOMAIN-SUFFIX,sora.com", "DOMAIN-SUFFIX,oaistatic.com", "DOMAIN-SUFFIX,oaiusercontent.com"] },
};
export const DIRECT_SET = "as-direct";
/** The templates' rule sets: the domestic one in two — what a name alone decides, in front; what needs its address
 *  looked up (a range, `GEOIP`), with the blocking one, after the subscription's own rules (§7.7). */
export const DOMESTIC_SET = "as-domestic", DOMESTIC_LOOKUP_SET = "as-domestic-ip", BLOCK_SET = "as-block";
/** Every rule set AgentSwitch serves; all of them are always named in the subscription. */
export const RULE_SETS: readonly string[] = [DIRECT_SET, ...CLASH_SERVICES.map((s) => SERVICE[s].set), DOMESTIC_SET, BLOCK_SET, DOMESTIC_LOOKUP_SET];
export const DEFAULT_GROUP = "Manual";
const PROBE_SECONDS = 180;
/** How often Clash Verge is asked to fetch the subscription again, in hours: the least its header can say (§7.3). */
export const VERGE_UPDATE_HOURS = 1;

/** The nodes chosen for a service that the subscription still has, in their order. */
export function chosen(service: ClashService, settings: ClashSettings, nodes: readonly SourceNode[]): SourceNode[] {
  const by = new Map(nodes.map((n) => [n.name, n]));
  return [...new Set(settings[service].nodes)].flatMap((name) => by.get(name) ?? []);
}

/** A template's rules as they are in use: the user's own, else the built-in ones. */
export function templateRules(template: ClashTemplate, settings: ClashSettings): readonly string[] {
  return settings.templates[template].rules ?? BUILT_IN[template];
}

/** The DNS template's text as it is in use: the user's own, else the built-in one. */
export function dnsText(settings: ClashSettings): string { return settings.dns.text ?? DNS_TEMPLATE; }

/** What a DNS template's text holds: a set of keys, as `dns:` takes. Or why it is not one. */
export function dnsSection(text: string): { readonly section: Record<string, unknown> } | { readonly error: string } {
  let doc: unknown;
  try { doc = parse(text); } catch (err) {
    const at = (err as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    return { error: `DNS 这一段不是合法的 YAML${at ? `（第 ${at} 行附近）` : ""}` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { error: "DNS 这一段要是一组“键: 值”（dns: 下面的内容）" };
  if ("dns" in doc && Object.keys(doc).length === 1) return { error: "不用写 dns: 这一行，只写它下面的内容" };
  return { section: doc as Record<string, unknown> };
}

/** A service's two groups by the names they have in this subscription: its own spelling of them where it has such
 *  groups (spaces and case aside — `Claude 自动选择` is `Claude自动选择`), else AgentSwitch's. */
export function groupNames(document: Record<string, unknown>, service: ClashService): { readonly group: string; readonly auto: string } {
  const names = groupsOf(document).map((g) => String(g.name ?? ""));
  const like = (want: string): string => names.find((n) => same(n, want)) ?? want;
  return { group: like(SERVICE[service].group), auto: like(SERVICE[service].auto) };
}

/** The subscription's default group: the hand-picked one its last `MATCH` sends everything else to. Null when it has
 *  none such, or already has a group called `Manual`. */
export function defaultGroup(document: Record<string, unknown>): string | null {
  const groups = groupsOf(document);
  if (groups.some((g) => g.name === DEFAULT_GROUP)) return null;
  const last = (Array.isArray(document.rules) ? document.rules : []).filter((r): r is string => typeof r === "string").reverse().find((r) => /^MATCH\s*,/i.test(r.trim()));
  const target = last?.split(",")[1]?.trim();
  return target && groups.some((g) => g.name === target && g.type === "select") ? target : null;
}

/** A node set's text, as the core fetches it: the chosen nodes in their order. Null when there is none — the core
 *  takes no empty set (it keeps the one it had), so none is ever handed to it. */
export function nodeSet(service: ClashService, settings: ClashSettings, nodes: readonly SourceNode[]): string | null {
  const list = chosen(service, settings, nodes);
  return list.length ? stringify({ proxies: list.map((n) => n.definition) }, { lineWidth: 0 }) : null;
}

/** A rule set's text, as the core fetches it. A service with no nodes and a template that is off have an empty one:
 *  that traffic goes as the subscription's own rules say. */
export function ruleSet(name: string, settings: ClashSettings, nodes: readonly SourceNode[]): string | null {
  const service = CLASH_SERVICES.find((s) => SERVICE[s].set === name);
  const of = (template: ClashTemplate): readonly string[] => (settings.templates[template].on ? templateRules(template, settings) : []);
  const payload = name === DIRECT_SET ? settings.direct.flatMap(directRule)
    : service ? (chosen(service, settings, nodes).length ? SERVICE[service].domains : [])
    : name === DOMESTIC_SET ? of("domestic").filter((r) => !looksUp(r))
    : name === DOMESTIC_LOOKUP_SET ? of("domestic").filter(looksUp)
    : name === BLOCK_SET ? of("block") : null;
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
export function buildConfig(document: Record<string, unknown>, nodes: readonly SourceNode[], held: readonly string[], settings: ClashSettings, base: string, token: string): Record<string, unknown> {
  const config = document;
  if (settings.dns.on) {
    const dns = dnsSection(dnsText(settings));
    if ("section" in dns) config.dns = dns.section;   // one that is not a section was refused when it was saved
  }
  const renamed = settings.renameDefault ? defaultGroup(config) : null;
  if (renamed) rename(config, renamed, DEFAULT_GROUP);
  const at = (path: string): string => `${base}/${path}?k=${token}`;
  const groups = groupsOf(config);
  const front: Record<string, unknown>[] = [];
  const first = [`RULE-SET,${DIRECT_SET},DIRECT`];
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
    first.push(`RULE-SET,${set},${names.group}`);
  }
  // The domestic template's names and processes: decided without a lookup (`no-resolve`: an address rule in it
  // matches an address as given, never a name's).
  first.push(`RULE-SET,${DOMESTIC_SET},DIRECT,no-resolve`);
  // The node sets it fetched by link are fetched from AgentSwitch instead: one place asks the subscription service,
  // and what it brings back the core can be told to take at once.
  const own = record(config["proxy-providers"]);
  for (const name of held) {
    const set = record(own[name]);
    if (set.type === "http") own[name] = { ...set, url: at(`providers/${providerSlug(name)}.yaml`), proxy: "DIRECT" };
  }
  const ruleSets = Object.fromEntries(RULE_SETS.map((name) =>
    [name, { type: "http", behavior: "classical", format: "yaml", url: at(`rules/${name}.yaml`), path: `./ruleset/${name}.yaml`, interval: 86400, proxy: "DIRECT" }]));
  config["proxy-groups"] = [...front, ...groups];
  if (Object.keys(own).length || Object.keys(sets).length) config["proxy-providers"] = { ...own, ...sets };
  config["rule-providers"] = { ...record(config["rule-providers"]), ...ruleSets };
  // Blocking, then what needs a lookup: after everything of the subscription's that claims traffic, before the rules
  // it ends on (`GEOIP…`, `MATCH`) — where the user's own file had them.
  const theirs = Array.isArray(config.rules) ? config.rules : [];
  let end = theirs.length;
  while (end > 0 && typeof theirs[end - 1] === "string" && /^(MATCH|GEOIP)\s*,/i.test((theirs[end - 1] as string).trim())) end -= 1;
  config.rules = [...first, ...theirs.slice(0, end), `RULE-SET,${BLOCK_SET},REJECT`, `RULE-SET,${DOMESTIC_LOOKUP_SET},DIRECT`, ...theirs.slice(end)];
  return config;
}

export function buildSubscription(document: Record<string, unknown>, nodes: readonly SourceNode[], held: readonly string[], settings: ClashSettings, base: string, token: string): string {
  return stringify(buildConfig(document, nodes, held, settings, base, token), { lineWidth: 0 });
}

/** The groups of a built subscription, by name. */
export function groupsIn(config: Record<string, unknown>): string[] { return groupsOf(config).map((g) => String(g.name ?? "")).filter(Boolean); }

/** What the core runs is this subscription (it has AgentSwitch's direct rule set), and it is the one made now: every
 *  rule set of AgentSwitch's is there, each service has its node set exactly when it has nodes chosen, and every
 *  group of what would be handed over now is there by its name. Otherwise Clash Verge has to fetch it again. */
export function running(expect: { readonly enabled: Readonly<Record<ClashService, boolean>>; readonly groups: readonly string[] },
                        status: { readonly ruleSets: Readonly<Record<string, number>>; readonly nodeSets: Readonly<Record<string, readonly string[]>>; readonly groups: readonly { readonly name: string }[] }): { active: boolean; current: boolean } {
  const active = DIRECT_SET in status.ruleSets;
  const have = new Set(status.groups.map((g) => g.name));
  return { active, current: active && RULE_SETS.every((name) => name in status.ruleSets)
    && CLASH_SERVICES.every((service) => expect.enabled[service] === (SERVICE[service].set in status.nodeSets))
    && expect.groups.every((name) => have.has(name)) };
}

/** A group called `from` is called `to` everywhere: itself, the groups that have it as a member, the rules that
 *  send traffic to it. */
function rename(config: Record<string, unknown>, from: string, to: string): void {
  for (const group of groupsOf(config)) {
    if (group.name === from) group.name = to;
    if (Array.isArray(group.proxies)) group.proxies = group.proxies.map((p) => (p === from ? to : p));
  }
  const retarget = (rule: unknown): unknown => {
    if (typeof rule !== "string" || rule.includes("(")) return rule;   // a logical rule is left as written
    const parts = rule.split(",");
    // The target is the last field that is not a flag (`MATCH,Proxy`; `IP-CIDR,1.2.3.0/24,Proxy,no-resolve`).
    let i = parts.length - 1;
    while (i > 0 && /^(no-resolve|src)$/i.test(parts[i]!.trim())) i -= 1;
    if (i > 0 && parts[i]!.trim() === from) parts[i] = parts[i]!.replace(from, to);
    return parts.join(",");
  };
  if (Array.isArray(config.rules)) config.rules = config.rules.map(retarget);
  for (const [name, rules] of Object.entries(record(config["sub-rules"]))) if (Array.isArray(rules)) record(config["sub-rules"])[name] = rules.map(retarget);
}

const same = (a: string, b: string): boolean => a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const groupsOf = (config: Record<string, unknown>): Record<string, unknown>[] =>
  (Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : []).filter((g): g is Record<string, unknown> => !!g && typeof g === "object");
