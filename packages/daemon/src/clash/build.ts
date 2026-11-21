/** The subscription AgentSwitch hands to Clash Verge (docs/clash-v0.md §7.2, §7.7): the one it works from as it is,
 *  and for each of Claude and OpenAI that has nodes chosen — a node set AgentSwitch serves (those nodes, in their
 *  order, by their own names), a group that uses the first of them that answers, and the group that decides where that
 *  traffic goes (the automatic one, or a node of the set). Its rules are in front of the subscription's own, and the
 *  subscription's own rules for that service send to its group too (`ruleService`); the rule
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
  /** Only AgentSwitch's rules (§7.11): what is handed over keeps the subscription's nodes and nothing else of its
   *  routing — its groups, rules and rule sets are left out; AgentSwitch's groups, its rule sets and `MATCH,Manual`
   *  are all there is. The domestic template is on while this is. */
  readonly ownRules: boolean;
  /** A change to the subscription's text is loaded into the running core by AgentSwitch itself, without waiting for
   *  Clash Verge to fetch it (§7.12). Off unless the user turns it on: it changes what runs behind Clash Verge's back. */
  readonly applyNow: boolean;
};
export const EMPTY_SETTINGS: ClashSettings = { claude: { nodes: [] }, openai: { nodes: [] }, direct: [], autoUpdateHours: 24,
  templates: { domestic: { on: false, rules: null }, block: { on: false, rules: null } }, renameDefault: false, dns: { on: false, text: null }, ownRules: false, applyNow: false };
export const UPDATE_HOURS = [0, 1, 6, 12, 24] as const;
export const BUILT_IN: Readonly<Record<ClashTemplate, readonly string[]>> = { domestic: DOMESTIC_TEMPLATE, block: BLOCK_TEMPLATE };

/** Each service's names in Clash (the user's own file of 2026-10-08, docs/clash-v0.md §1), where its nodes are tried,
 *  and the domains it is reached at. The node set and the rule set have one name: they are two kinds of set. `own`: a
 *  word that names a subscription's own rules for it (a rule set `openai`, `…/OpenAI/OpenAI.yaml`; `GEOSITE,openai`). */
export const SERVICE: Record<ClashService, { readonly group: string; readonly auto: string; readonly set: string; readonly probe: string; readonly domains: readonly string[]; readonly own: RegExp }> = {
  claude: { group: "Claude", auto: "Claude自动选择", set: "as-claude", probe: "https://api.anthropic.com/",
    domains: ["DOMAIN-KEYWORD,anthropic", "DOMAIN-SUFFIX,claude.ai", "DOMAIN-SUFFIX,claude.com", "DOMAIN-SUFFIX,claudeusercontent.com"], own: /^(claude|anthropic)$/i },
  openai: { group: "OpenAI", auto: "OpenAI自动选择", set: "as-openai", probe: "https://api.openai.com/",
    domains: ["DOMAIN-KEYWORD,openai", "DOMAIN-SUFFIX,chatgpt.com", "DOMAIN-SUFFIX,chat.com", "DOMAIN-SUFFIX,sora.com", "DOMAIN-SUFFIX,oaistatic.com", "DOMAIN-SUFFIX,oaiusercontent.com"], own: /^(openai|chatgpt)$/i },
};
export const DIRECT_SET = "as-direct";
/** The templates' rule sets: the domestic one in two — what a name alone decides, in front; what needs its address
 *  looked up (a range, `GEOIP`), with the blocking one, after the subscription's own rules (§7.7). */
export const DOMESTIC_SET = "as-domestic", DOMESTIC_LOOKUP_SET = "as-domestic-ip", BLOCK_SET = "as-block";
/** Every rule set AgentSwitch serves; all of them are always named in the subscription. */
export const RULE_SETS: readonly string[] = [DIRECT_SET, ...CLASH_SERVICES.map((s) => SERVICE[s].set), DOMESTIC_SET, BLOCK_SET, DOMESTIC_LOOKUP_SET];
export const DEFAULT_GROUP = "Manual";
/** With only AgentSwitch's rules: the group `Manual` offers first, the fastest of every node now. */
export const AUTO_GROUP = "自动选择";
const AUTO_PROBE = "https://www.gstatic.com/generate_204", AUTO_SECONDS = 300;
const PROBE_SECONDS = 180;
/** How often Clash Verge is asked to fetch the subscription again, in hours: the least its header can say (§7.3). */
export const VERGE_UPDATE_HOURS = 1;

/** The nodes chosen for a service that the subscription still has, in their order. */
export function chosen(service: ClashService, settings: ClashSettings, nodes: readonly SourceNode[]): SourceNode[] {
  const by = new Map(nodes.map((n) => [n.name, n]));
  return [...new Set(settings[service].nodes)].flatMap((name) => by.get(name) ?? []);
}

/** A template is in use: switched on, or the domestic one while only AgentSwitch's rules are (without it, everything at
 *  home would go out by a proxy). */
export function templateOn(template: ClashTemplate, settings: ClashSettings): boolean {
  return settings.templates[template].on || (template === "domestic" && settings.ownRules);
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
export function groupNames(document: Record<string, unknown>, service: ClashService, settings?: ClashSettings): { readonly group: string; readonly auto: string } {
  // With only AgentSwitch's rules the subscription's groups are gone: its spelling of them goes with them.
  const names = settings?.ownRules ? [] : groupsOf(document).map((g) => String(g.name ?? ""));
  const like = (want: string): string => names.find((n) => same(n, want)) ?? want;
  return { group: like(SERVICE[service].group), auto: like(SERVICE[service].auto) };
}

/** The subscription's default group: the hand-picked one its last `MATCH` sends everything else to. Null when it has
 *  none such, or already has a group called `Manual`. */
export function defaultGroup(document: Record<string, unknown>, settings?: ClashSettings): string | null {
  if (settings?.ownRules) return null;   // its groups are left out: `Manual` is AgentSwitch's own
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

/** A rule set's text, as the core fetches it. A service with no selected nodes and a template that is off have an empty one:
 *  that traffic goes as the subscription's own rules say. */
export function ruleSet(name: string, settings: ClashSettings, _nodes: readonly SourceNode[]): string | null {
  const service = CLASH_SERVICES.find((s) => SERVICE[s].set === name);
  const of = (template: ClashTemplate): readonly string[] => (templateOn(template, settings) ? templateRules(template, settings) : []);
  const payload = name === DIRECT_SET ? settings.direct.flatMap(directRule)
    : service ? (settings[service].nodes.length ? SERVICE[service].domains : [])
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
  const renamed = settings.renameDefault ? defaultGroup(config, settings) : null;
  if (renamed) rename(config, renamed, DEFAULT_GROUP);
  const at = (path: string): string => `${base}/${path}?k=${token}`;
  const own = record(config["proxy-providers"]);
  const theirSets = Object.keys(own);
  // Only AgentSwitch's rules: of the subscription's routing nothing is kept but its nodes (§7.11).
  const dropped = settings.ownRules ? new Set(groupsOf(config).map((g) => String(g.name ?? ""))) : null;
  const groups = dropped ? [] : groupsOf(config);
  const front: Record<string, unknown>[] = [];
  const first = [`RULE-SET,${DIRECT_SET},DIRECT`];
  const sets: Record<string, unknown> = {};
  const decides: Partial<Record<ClashService, string>> = {};
  for (const service of CLASH_SERVICES) {
    if (!settings[service].nodes.length) continue;
    const { set, probe } = SERVICE[service];
    if (!chosen(service, settings, nodes).length) {
      // A subscription losing every selected node must not silently change the service's exit.
      decides[service] = "REJECT";
      first.push(`RULE-SET,${set},REJECT`);
      continue;
    }
    const names = groupNames(config, service, settings);
    decides[service] = names.group;
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
    // Mihomo skips a proxy without UDP support and keeps matching. Catch that same traffic before
    // it reaches domestic, subscription or MATCH rules; UDP-capable nodes still use the first rule.
    first.push(`RULE-SET,${set},${names.group}`, `RULE-SET,${set},REJECT`);
  }
  // The domestic template's names and processes: decided without a lookup (`no-resolve`: an address rule in it
  // matches an address as given, never a name's). To the subscription's own group for what goes direct where it has
  // one (`🎯 直连`): switched to a proxy there, this goes with the rest (2026-10-16, §7.10).
  const direct = directGroup(config, settings) ?? "DIRECT";
  first.push(`RULE-SET,${DOMESTIC_SET},${direct},no-resolve`);
  // The node sets it fetched by link are fetched from AgentSwitch instead: one place asks the subscription service,
  // and what it brings back the core can be told to take at once.
  for (const name of held) {
    const set = record(own[name]);
    if (set.type === "http") own[name] = { ...set, url: at(`providers/${providerSlug(name)}.yaml`), proxy: "DIRECT" };
  }
  const ruleSets = Object.fromEntries(RULE_SETS.map((name) =>
    [name, { type: "http", behavior: "classical", format: "yaml", url: at(`rules/${name}.yaml`), path: `./ruleset/${name}.yaml`, interval: 86400, proxy: "DIRECT" }]));
  if (dropped) front.push(...everyNode(config, theirSets));
  config["proxy-groups"] = [...front, ...groups];
  if (Object.keys(own).length || Object.keys(sets).length) config["proxy-providers"] = { ...own, ...sets };
  if (dropped) {
    config["rule-providers"] = ruleSets;
    config.rules = [...first, `RULE-SET,${BLOCK_SET},REJECT`, `RULE-SET,${DOMESTIC_LOOKUP_SET},DIRECT`, `MATCH,${DEFAULT_GROUP}`];
    delete config["sub-rules"];
    unname(config, dropped);
    return config;
  }
  config["rule-providers"] = { ...record(config["rule-providers"]), ...ruleSets };
  // The subscription's own rules for a service AgentSwitch has nodes for send that traffic to AgentSwitch's group too,
  // where they stand: its lists are often longer than AgentSwitch's (sign-in, the human check, voice), and what they
  // caught went out by the subscription's own group (`🤖 AI`) — one service by two ways out (2026-10-16, user: 代理的
  // 分组现在怎么带上了上游订阅的分组？两个不会打架吗).
  const theirs = (Array.isArray(config.rules) ? config.rules : []).flatMap((rule) => {
    const service = ruleService(rule, config);
    const group = service && decides[service];
    if (!group) return [rule];
    const routed = target(rule as string, group);
    return group === "REJECT" ? [routed] : [routed, target(rule as string, "REJECT")];
  });
  // Blocking after everything of the subscription's that claims a kind of traffic, before the broad rules it ends on
  // (the lists of everything abroad, `GEOIP`, `MATCH`): there it meets what is left. What needs a lookup as late as it
  // can be, just before the first of those that needs one — where the user's own file had them (§7.7). A converted
  // subscription ends on `gfw`, `proxy`, `cncidr`, `GEOIP,CN`, `tld-not-cn`, `MATCH`: blocking put before only the last
  // of them met almost nothing (§7.10).
  const broad = broadFrom(theirs, config);
  let lookup = broad;
  while (lookup < theirs.length && !looksUpRule(theirs[lookup], config)) lookup += 1;
  config.rules = [...first, ...theirs.slice(0, broad), `RULE-SET,${BLOCK_SET},REJECT`, ...theirs.slice(broad, lookup), `RULE-SET,${DOMESTIC_LOOKUP_SET},${direct}`, ...theirs.slice(lookup)];
  return config;
}

/** With only AgentSwitch's rules, the groups everything else goes by: `Manual`, picked by hand, and `自动选择`, the
 *  fastest of every node. Every node is the subscription's own list and its node sets (not AgentSwitch's, which hold
 *  only some of them again). With no node at all, `Manual` has `DIRECT` alone: a group of nothing the core refuses. */
function everyNode(config: Record<string, unknown>, sets: readonly string[]): Record<string, unknown>[] {
  const nodes = (Array.isArray(config.proxies) ? config.proxies : []).map((p) => String(record(p).name ?? "")).filter(Boolean);
  const use = sets.length ? { use: [...sets] } : {};
  if (!nodes.length && !sets.length) return [{ name: DEFAULT_GROUP, type: "select", proxies: ["DIRECT"] }];
  return [
    { name: DEFAULT_GROUP, type: "select", proxies: [AUTO_GROUP, ...nodes], ...use },
    { name: AUTO_GROUP, type: "url-test", ...(nodes.length ? { proxies: nodes } : {}), ...use, url: AUTO_PROBE, interval: AUTO_SECONDS },
  ];
}

/** What else of the subscription names a group that is left out goes without it: a name server's `#group` (asked
 *  directly), a node's `dialer-proxy` (dialled directly), a name server for a rule set that is left out (dropped). */
function unname(config: Record<string, unknown>, gone: ReadonlySet<string>): void {
  const kept = new Set(Object.keys(record(config["rule-providers"])));
  const server = (v: unknown): unknown => {
    if (typeof v !== "string") return Array.isArray(v) ? v.map(server) : v;
    const hash = v.lastIndexOf("#");
    return hash > 0 && gone.has(v.slice(hash + 1)) ? v.slice(0, hash) : v;
  };
  const dns = record(config.dns);
  for (const key of ["nameserver", "fallback", "default-nameserver", "proxy-server-nameserver", "direct-nameserver"]) if (key in dns) dns[key] = server(dns[key]);
  const policy = record(dns["nameserver-policy"]);
  for (const [key, value] of Object.entries(policy)) {
    const sets = /^rule-set:/i.test(key) ? key.slice(9).split(",").map((n) => n.trim()) : [];
    if (sets.some((n) => !kept.has(n))) delete policy[key]; else policy[key] = server(value);
  }
  for (const node of Array.isArray(config.proxies) ? config.proxies : []) {
    const n = record(node);
    if (typeof n["dialer-proxy"] === "string" && gone.has(n["dialer-proxy"])) delete n["dialer-proxy"];
  }
}

/** The parts of a configuration that are the subscription's routing: what Clash Verge takes from the subscription as
 *  it is. Everything else of what the core runs — its ports, its controller, TUN, the mode — is Clash Verge's own. */
const ROUTING = ["proxies", "proxy-providers", "proxy-groups", "rule-providers", "rules", "sub-rules"] as const;

/** What the core is to run now (§7.12): the configuration Clash Verge made for it (`runtime`), with the routing of the
 *  subscription made now (`made`) in place of the routing it has. `dns:` too, unless Clash Verge has its own DNS
 *  settings on or the subscription made now has none. Neither is changed. */
export function appliedConfig(runtime: Readonly<Record<string, unknown>>, made: Readonly<Record<string, unknown>>, vergeDns: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...runtime };
  for (const key of ROUTING) { if (key in made) out[key] = made[key]; else delete out[key]; }
  if (!vergeDns && "dns" in made) out.dns = made.dns;
  return out;
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

/** The subscription's own group for what goes direct: the hand-picked one its `GEOIP,CN` sends to, where that group
 *  offers `DIRECT` (a converted subscription's `🎯 直连`). Null for none: what goes direct goes to `DIRECT` itself. */
export function directGroup(config: Record<string, unknown>, settings?: ClashSettings): string | null {
  if (settings?.ownRules) return null;
  const rules = (Array.isArray(config.rules) ? config.rules : []).filter((r): r is string => typeof r === "string");
  const geoip = rules.map((r) => r.split(",").map((p) => p.trim())).find((p) => p[0]?.toUpperCase() === "GEOIP" && p[1]?.toUpperCase() === "CN");
  const name = geoip?.[2];
  const group = name ? groupsOf(config).find((g) => g.name === name) : undefined;
  return group && group.type === "select" && Array.isArray(group.proxies) && group.proxies.includes("DIRECT") ? name! : null;
}

/** The words that name the broad lists a subscription ends on: everything abroad, everything at home. */
const BROAD = new Set(["gfw", "greatfire", "proxy", "proxylite", "cncidr", "cnip", "chnip", "chinaip", "china", "cn", "tld", "geolocation", "global", "lancidr"]);
const BROAD_SITE = /^(?:cn|!cn|private|gfw|greatfire|geolocation-!?cn|tld-!?cn)$/i;

/** Where the broad rules the subscription ends on begin: counted back from its end, `MATCH`, `GEOIP`, the broad
 *  `GEOSITE`s and rule sets of the broad lists. Its length when it ends on none. */
function broadFrom(rules: readonly unknown[], config: Record<string, unknown>): number {
  let i = rules.length;
  while (i > 0 && broadRule(rules[i - 1], config)) i -= 1;
  return i;
}

function broadRule(rule: unknown, config: Record<string, unknown>): boolean {
  if (typeof rule !== "string" || rule.includes("(")) return false;
  const [kind, value = ""] = rule.split(",").map((p) => p.trim());
  switch (kind?.toUpperCase()) {
    case "MATCH": case "FINAL": case "GEOIP": return true;
    case "GEOSITE": return BROAD_SITE.test(value);
    case "RULE-SET": return [value, providerFile(record(record(config["rule-providers"])[value]))].flatMap((n) => n.toLowerCase().split(/[^a-z0-9]+/)).some((w) => BROAD.has(w));
    default: return false;
  }
}

/** A rule that looks the name up to decide (`GEOIP`, an address rule or a rule set of addresses without
 *  `no-resolve`), or the one that takes everything left (`MATCH`). */
function looksUpRule(rule: unknown, config: Record<string, unknown>): boolean {
  if (typeof rule !== "string" || rule.includes("(")) return false;
  const parts = rule.split(",").map((p) => p.trim());
  const kind = parts[0]?.toUpperCase() ?? "";
  if (kind === "MATCH" || kind === "FINAL") return true;
  if (parts.some((p) => /^no-resolve$/i.test(p))) return false;
  if (kind === "GEOIP" || kind === "IP-CIDR" || kind === "IP-CIDR6" || kind === "IP-ASN") return true;
  return kind === "RULE-SET" && record(record(config["rule-providers"])[parts[1] ?? ""]).behavior === "ipcidr";
}

/** The service a rule of the subscription's is for: a rule set it names after one service (by the set's name, or by
 *  the file it comes from), or a `GEOSITE` of one. Null for anything else, and for what names both (one list for
 *  every AI service stays where the subscription sends it). */
export function ruleService(rule: unknown, config: Record<string, unknown>): ClashService | null {
  if (typeof rule !== "string" || rule.includes("(")) return null;
  const [kind, value] = rule.split(",").map((p) => p.trim());
  if (!value) return null;
  const names = kind?.toUpperCase() === "GEOSITE" ? [value]
    : kind?.toUpperCase() === "RULE-SET" ? [value, providerFile(record(record(config["rule-providers"])[value]))] : [];
  const words = names.flatMap((n) => n.split(/[^a-z0-9]+/i)).filter(Boolean);
  const hit = CLASH_SERVICES.filter((s) => words.some((w) => SERVICE[s].own.test(w)));
  return hit.length === 1 ? hit[0]! : null;
}

/** A rule provider's file name without its extension (`OpenAI` of `…/rule/Clash/OpenAI/OpenAI.yaml`); "" for none. */
function providerFile(provider: Record<string, unknown>): string {
  const at = typeof provider.url === "string" ? provider.url : typeof provider.path === "string" ? provider.path : "";
  try { return (at.includes("://") ? new URL(at).pathname : at).split("/").pop()!.replace(/\.[^.]*$/, ""); } catch { return ""; }
}

/** The field of a rule that names where its traffic goes: the last one that is not a flag (`MATCH,Proxy`;
 *  `IP-CIDR,1.2.3.0/24,Proxy,no-resolve`). -1 for a rule without one. */
function targetAt(parts: readonly string[]): number {
  let i = parts.length - 1;
  while (i > 0 && /^(no-resolve|src)$/i.test(parts[i]!.trim())) i -= 1;
  return i > 0 ? i : -1;
}

/** `rule` sending its traffic to `group` instead. */
function target(rule: string, group: string): string {
  const parts = rule.split(",");
  const i = targetAt(parts);
  if (i < 0) return rule;
  parts[i] = group;
  return parts.join(",");
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
    const i = targetAt(parts);
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
