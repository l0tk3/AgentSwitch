/** The subscription AgentSwitch hands to Clash Verge (docs/clash-v0.md §6): the user's own subscription as it is, with
 *  AgentSwitch's groups in front of its groups, its rule sets declared, and the rules that send traffic to them in
 *  front of its rules. What changes from day to day — which addresses go direct, which domains are Claude's — is in the
 *  rule sets, which the core reads again one at a time; the groups and their order are the subscription's own text. */

import { parse, stringify } from "yaml";

export const CLASH_SERVICES = ["claude", "openai"] as const;
export type ClashService = (typeof CLASH_SERVICES)[number];
export type ServiceProxy = { /** Nodes by name, the first preferred. */ readonly nodes: readonly string[]; /** `auto`: the first that answers; `manual`: the one picked. */ readonly mode: "auto" | "manual"; readonly picked?: string };
export type ClashSettings = { readonly source: string | null; readonly claude: ServiceProxy; readonly openai: ServiceProxy; /** Addresses (an IP or a host) that go direct. */ readonly direct: readonly string[] };

export const EMPTY_SETTINGS: ClashSettings = { source: null, claude: { nodes: [], mode: "auto" }, openai: { nodes: [], mode: "auto" }, direct: [] };
export const GROUP = { claude: "AgentSwitch Claude", openai: "AgentSwitch OpenAI" } as const;
export const AUTO_SUFFIX = " Auto";
export const RULE_SETS = { direct: "as-direct", claude: "as-claude", openai: "as-openai" } as const;
const NODE_PREFIX = "AS · ";
const PROBE = "https://www.gstatic.com/generate_204";

/** The domains each service is reached at (the user's own rules of 2026-10-08, docs/clash-v0.md §1). */
const DOMAINS: Record<ClashService, readonly string[]> = {
  claude: ["DOMAIN-KEYWORD,anthropic", "DOMAIN-SUFFIX,claude.ai", "DOMAIN-SUFFIX,claude.com", "DOMAIN-SUFFIX,claudeusercontent.com"],
  openai: ["DOMAIN-KEYWORD,openai", "DOMAIN-SUFFIX,chatgpt.com", "DOMAIN-SUFFIX,chat.com", "DOMAIN-SUFFIX,sora.com", "DOMAIN-SUFFIX,oaistatic.com", "DOMAIN-SUFFIX,oaiusercontent.com"],
};

export class ClashBuildError extends Error {}

/** A rule set's text, as the core fetches it. */
export function ruleSet(name: string, settings: ClashSettings): string | null {
  const payload = name === RULE_SETS.direct ? settings.direct.flatMap(directRule)
    : name === RULE_SETS.claude ? DOMAINS.claude : name === RULE_SETS.openai ? DOMAINS.openai : null;
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

/** `source` (a Clash subscription's text) with AgentSwitch's part added. `base`: where this Mac serves the rule sets
 *  (`http://127.0.0.1:<port>/clash`), `token`: what the address has to carry. */
export function buildSubscription(source: string, settings: ClashSettings, base: string, token: string): string {
  let doc: unknown;
  try { doc = parse(source); } catch (err) { throw new ClashBuildError(`订阅不是合法的 YAML：${(err as Error).message.split("\n")[0]}`); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ClashBuildError("订阅里没有内容");
  const config = { ...(doc as Record<string, unknown>) };
  const inline = new Set((Array.isArray(config.proxies) ? config.proxies : []).map((p) => String((p as { name?: unknown })?.name ?? "")));
  const providers = Object.keys(config["proxy-providers"] && typeof config["proxy-providers"] === "object" ? config["proxy-providers"] as object : {});
  const groups: Record<string, unknown>[] = [];
  const rules = [`RULE-SET,${RULE_SETS.direct},DIRECT`];
  const wrapped = new Set<string>();
  for (const service of CLASH_SERVICES) {
    const nodes = [...new Set(settings[service].nodes)].filter(Boolean);
    if (!nodes.length) continue;
    // A node of the subscription's own list is named as it is; one that comes from a provider can only be reached
    // through a group that picks it out of the providers by its exact name.
    const refs = nodes.map((node) => {
      if (inline.has(node)) return node;
      if (!providers.length) throw new ClashBuildError(`订阅里没有节点 ${node}`);
      const name = `${NODE_PREFIX}${node}`;
      if (!wrapped.has(name)) { wrapped.add(name); groups.push({ name, type: "select", use: providers, filter: `^${node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` }); }
      return name;
    });
    groups.unshift(
      { name: GROUP[service], type: "select", proxies: [`${GROUP[service]}${AUTO_SUFFIX}`, ...refs] },
      { name: `${GROUP[service]}${AUTO_SUFFIX}`, type: "fallback", proxies: refs, url: PROBE, interval: 300 },
    );
    rules.push(`RULE-SET,${RULE_SETS[service]},${GROUP[service]}`);
  }
  const set = (name: string) => ({ type: "http", behavior: "classical", format: "yaml", url: `${base}/rules/${name}.yaml?k=${token}`, path: `./ruleset/${name}.yaml`, interval: 86400, proxy: "DIRECT" });
  config["proxy-groups"] = [...groups, ...(Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [])];
  config["rule-providers"] = { ...(config["rule-providers"] && typeof config["rule-providers"] === "object" ? config["rule-providers"] as object : {}),
    ...Object.fromEntries(Object.values(RULE_SETS).map((name) => [name, set(name)])) };
  config.rules = [...rules, ...(Array.isArray(config.rules) ? config.rules : [])];
  return stringify(config, { lineWidth: 0 });
}

/** What the core runs is this subscription: its rule sets are AgentSwitch's and its groups are the ones `settings`
 *  asks for (a group missing or with other members means the subscription has to be fetched again). */
export function running(settings: ClashSettings, status: { readonly ruleSets: Readonly<Record<string, number>>; readonly groups: readonly { readonly name: string; readonly members: readonly string[] }[] }): { active: boolean; current: boolean } {
  const active = RULE_SETS.direct in status.ruleSets;
  const current = active && CLASH_SERVICES.every((service) => {
    const group = status.groups.find((g) => g.name === `${GROUP[service]}${AUTO_SUFFIX}`);
    const nodes = [...new Set(settings[service].nodes)].filter(Boolean);
    if (!nodes.length) return !group;
    return !!group && group.members.length === nodes.length && group.members.every((m, i) => m === nodes[i] || m === `${NODE_PREFIX}${nodes[i]}`);
  });
  return { active, current };
}
