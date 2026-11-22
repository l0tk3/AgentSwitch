/** The subscription as a phone's Clash takes it (docs/clash-v0.md §12): the one made for this Mac, whole in one text.
 *  What this Mac's core fetches from AgentSwitch a part at a time — its node sets, its rule sets — a phone cannot
 *  fetch (they are on this Mac's loopback), and away from home it cannot reach this Mac at all: so the nodes and the
 *  rules are written into the text, and nothing in it points back here. What is this Mac's alone is left out (its
 *  ports, its controller, TUN), and for Stash what Stash has no word for.
 *
 *  The user's own Stash file of 2026-09-28 is the pattern: `mode`, `dns`, `proxies`, `proxy-groups`, `rules`. */

import { parse } from "yaml";

export type PhoneApp = "stash" | "mihomo";

/** Which app asks: by what it calls itself (`Stash/3.1.0 Clash/1.11.0`), unless the address says (`?for=stash`).
 *  Anything else is taken for a Clash with mihomo inside (Clash Meta for Android, FlClash, Clash Verge). */
export function phoneApp(userAgent: string | undefined, asked?: string | undefined): PhoneApp {
  if (asked === "stash" || asked === "mihomo") return asked;
  return /stash/i.test(userAgent ?? "") ? "stash" : "mihomo";
}

export type PhoneParts = {
  /** Where this Mac serves the parts (`http://127.0.0.1:<port>/clash`): an address under it is one of AgentSwitch's. */
  readonly base: string;
  readonly ruleSet: (name: string) => string | null;
  readonly nodeSet: (name: string) => string | null;
  readonly provider: (slug: string) => string | null;
};

/** What a phone has no use for, or must not be told to do: listen on ports, be controlled, run this Mac's TUN. */
const MAC_ONLY = new Set(["port", "socks-port", "mixed-port", "redir-port", "tproxy-port", "allow-lan", "bind-address", "lan-allowed-ips", "lan-disallowed-ips",
  "authentication", "skip-auth-prefixes", "external-controller", "external-controller-tls", "external-controller-unix", "external-controller-pipe",
  "external-controller-cors", "external-ui", "external-ui-name", "external-ui-url", "external-doh-server", "secret", "tun", "listeners", "tunnels",
  "interface-name", "routing-mark", "iptables", "ebpf", "experimental"]);
/** What Stash reads of a Clash file (stash.wiki, 2026-11-22). */
const STASH_KEEPS = new Set(["mode", "log-level", "ipv6", "dns", "hosts", "proxies", "proxy-groups", "proxy-providers", "rules", "rule-providers"]);
const STASH_DNS = new Set(["nameserver", "default-nameserver", "proxy-server-nameserver", "nameserver-policy", "fallback", "fallback-filter", "fake-ip-range", "fake-ip-filter", "ipv6", "follow-rule"]);
const BY_ADDRESS = new Set(["IP-CIDR", "IP-CIDR6", "IP-SUFFIX", "IP-ASN", "GEOIP"]);
const NOTHING = "DOMAIN,agentswitch-nothing.invalid";

/** `made` (what would be handed to this Mac's Clash; not changed) as a phone's `app` takes it. */
export function phoneConfig(made: Readonly<Record<string, unknown>>, parts: PhoneParts, app: PhoneApp): Record<string, unknown> {
  const config = structuredClone(made) as Record<string, unknown>;
  for (const key of Object.keys(config)) if (MAC_ONLY.has(key) || (app === "stash" && !STASH_KEEPS.has(key))) delete config[key];
  inlineNodes(config, parts);
  const gone = inlineRules(config, parts, app);
  const dns = record(config.dns);
  if (Object.keys(dns).length) config.dns = phoneDns(dns, gone, app);
  return config;
}

/** The part of one of AgentSwitch's addresses after `…/clash/`, without the token: `nodes/as-claude.yaml`. */
function own(url: unknown, base: string): string | null {
  if (typeof url !== "string" || !url.startsWith(`${base}/`)) return null;
  return url.slice(base.length + 1).replace(/\?.*$/, "");
}

/** The node sets AgentSwitch serves become nodes of the text, and the groups that used a set name its nodes. A group
 *  that chose among a set's nodes by a pattern (`filter`) has the ones the pattern takes. A set served by someone
 *  else stays a set: the phone fetches it itself. */
function inlineNodes(config: Record<string, unknown>, parts: PhoneParts): void {
  const sets = record(config["proxy-providers"]);
  const nodes = (Array.isArray(config.proxies) ? config.proxies : []).filter((p) => p && typeof p === "object") as Record<string, unknown>[];
  const listed = nodes.map((n) => String(n.name ?? ""));
  const have = new Set(listed);
  const brought = new Map<string, Record<string, unknown>[]>();
  for (const [name, set] of Object.entries(sets)) {
    const path = own(record(set).url, parts.base);
    if (!path) continue;
    const file = path.replace(/^[^/]+\//, "").replace(/\.yaml$/, "");
    const text = path.startsWith("nodes/") ? parts.nodeSet(file) : path.startsWith("providers/") ? parts.provider(file) : null;
    let found: unknown[] = [];
    try { const doc = text ? parse(text) as { proxies?: unknown } : null; if (Array.isArray(doc?.proxies)) found = doc.proxies; } catch { /* a set that cannot be read brings nothing */ }
    const of = found.filter((p) => p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string") as Record<string, unknown>[];
    brought.set(name, of);
    // A node two sets hold (one chosen for Claude is in its subscription's set too) is written once.
    for (const node of of) if (!have.has(String(node.name))) { have.add(String(node.name)); nodes.push(node); }
    delete sets[name];
  }
  if (!brought.size) return;
  const kind = new Map(nodes.map((n) => [String(n.name), String(n.type ?? "")]));
  const outside = Object.keys(sets);
  for (const group of groupsOf(config)) {
    const use = Array.isArray(group.use) ? group.use.map(String) : [];
    const all = group["include-all"] === true, allSets = all || group["include-all-providers"] === true, allNodes = all || group["include-all-proxies"] === true;
    if (!use.some((u) => brought.has(u)) && !(allSets && brought.size)) continue;
    const takes = taker(group);
    const members: string[] = Array.isArray(group.proxies) ? group.proxies.map(String) : [];
    const add = (name: string) => { if (!members.includes(name) && takes(name, kind.get(name) ?? "")) members.push(name); };
    // Every set, as the core takes them: by name. The ones named, in the order they are named.
    const from = allSets ? [...brought.keys()].sort() : use.filter((u) => brought.has(u));
    if (!outside.length) {
      // Nothing of this group is fetched any more: what it holds is said in full, and the words for choosing go.
      if (allNodes) listed.forEach(add);
      for (const set of from) for (const node of brought.get(set)!) add(String(node.name));
      for (const key of ["use", "include-all", "include-all-providers", "include-all-proxies", "filter", "exclude-filter", "exclude-type"]) delete group[key];
    } else {
      for (const set of from) for (const node of brought.get(set)!) add(String(node.name));
      const left = use.filter((u) => !brought.has(u));
      if (left.length) group.use = left; else delete group.use;
    }
    // A group of nothing is refused; one that lost every node must not send its traffic out some other way.
    const fetched = (Array.isArray(group.use) && group.use.length > 0) || group["include-all"] === true || group["include-all-providers"] === true || group["include-all-proxies"] === true;
    if (members.length) group.proxies = members; else if (fetched) delete group.proxies; else group.proxies = ["REJECT"];
  }
  config.proxies = nodes;
  if (Object.keys(sets).length) config["proxy-providers"] = sets; else delete config["proxy-providers"];
}

/** Which nodes of its sets a group takes: `filter` (any of its patterns, set apart by a backtick), not
 *  `exclude-filter`, not a kind in `exclude-type`. A pattern this cannot read takes everything. */
function taker(group: Record<string, unknown>): (name: string, type: string) => boolean {
  const patterns = (v: unknown): RegExp[] => (typeof v === "string" && v ? v.split("`").flatMap((p) => { try { return [new RegExp(p.replace(/^\(\?i\)/, ""), p.startsWith("(?i)") ? "i" : "")]; } catch { return []; } }) : []);
  const keep = patterns(group.filter), drop = patterns(group["exclude-filter"]);
  const kinds = typeof group["exclude-type"] === "string" ? group["exclude-type"].toLowerCase().split("|").map((k) => k.trim()).filter(Boolean) : [];
  return (name, type) => (!keep.length || keep.some((p) => p.test(name))) && !drop.some((p) => p.test(name)) && !kinds.includes(type.toLowerCase());
}

/** The rule sets AgentSwitch serves become rules of the text, where the rule naming the set stood, each going where
 *  that rule sent the set. Rules by a program's name go (a phone has none of this Mac's programs to match); for Stash so do rules it has
 *  no word for. Returns the sets that are no longer sets. */
function inlineRules(config: Record<string, unknown>, parts: PhoneParts, app: PhoneApp): Set<string> {
  const sets = record(config["rule-providers"]);
  const payloads = new Map<string, string[]>();
  for (const [name, set] of Object.entries(sets)) {
    const path = own(record(set).url, parts.base);
    if (!path?.startsWith("rules/")) continue;
    let rules: unknown[] = [];
    try { const doc = parse(parts.ruleSet(path.slice(6).replace(/\.yaml$/, "")) ?? "") as { payload?: unknown } | null; if (Array.isArray(doc?.payload)) rules = doc.payload; } catch { /* nothing */ }
    payloads.set(name, rules.filter((r): r is string => typeof r === "string" && r !== NOTHING));
    delete sets[name];
  }
  // A rule by a program's name is this Mac's programs (`WeChat`, `QQ Helper`): a phone has none of them, and an older
  // core refuses the kinds it does not know (`PROCESS-NAME-WILDCARD`, Clash on Android, 2026-11-22) with the whole text.
  const unread = (rule: string): boolean => /^PROCESS-/i.test(rule.trim()) || (app === "stash" && /^(SUB-RULE\b|IN-|DSCP\b|UID\b)/i.test(rule.trim()));
  const rules = (Array.isArray(config.rules) ? config.rules : []).flatMap((rule): unknown[] => {
    if (typeof rule !== "string") return [rule];
    const fields = rule.split(",").map((p) => p.trim());
    const payload = fields[0]?.toUpperCase() === "RULE-SET" ? payloads.get(fields[1] ?? "") : undefined;
    if (!payload) return unread(rule) ? [] : [rule];
    const target = fields[2] ?? "DIRECT", asGiven = fields.slice(3).some((f) => /^no-resolve$/i.test(f));
    return payload.filter((r) => !unread(r)).map((r) => {
      const said = /,no-resolve$/i.test(r), bare = said ? r.replace(/,no-resolve$/i, "") : r;
      const flag = said || (asGiven && BY_ADDRESS.has(bare.slice(0, bare.indexOf(",")).toUpperCase()));
      return `${bare},${target}${flag ? ",no-resolve" : ""}`;
    });
  });
  if (rules.length) config.rules = rules;
  if (Object.keys(sets).length) config["rule-providers"] = sets; else delete config["rule-providers"];
  if (app === "stash") delete config["sub-rules"];
  return new Set(payloads.keys());
}

/** `dns:` for a phone: it listens nowhere; a name server chosen for a rule set that is no longer a set goes. For
 *  Stash, only the keys it reads, and a name server without the group it was to be asked through. */
function phoneDns(dns: Record<string, unknown>, gone: ReadonlySet<string>, app: PhoneApp): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const server = (v: unknown): unknown => (Array.isArray(v) ? v.map(server) : typeof v === "string" && app === "stash" ? v.replace(/#[^#]*$/, "") : v);
  for (const [key, value] of Object.entries(dns)) {
    if (key === "listen" || (app === "stash" && !STASH_DNS.has(key))) continue;
    if (key === "nameserver-policy") {
      const policy: Record<string, unknown> = {};
      for (const [names, to] of Object.entries(record(value))) {
        const sets = /^rule-set:/i.test(names) ? names.slice(9).split(",").map((n) => n.trim()) : [];
        if (sets.some((n) => gone.has(n))) continue;
        // Several names with one answer (`+.a.com,+.b.com`) are one line each for Stash: its pages show only that.
        if (app === "stash" && !/^(rule-set|geosite):/i.test(names)) for (const name of names.split(",").map((n) => n.trim()).filter(Boolean)) policy[name] = server(to);
        else policy[names] = server(to);
      }
      if (Object.keys(policy).length) out[key] = policy;
    } else if (key === "fake-ip-filter" && Array.isArray(value)) {
      out[key] = value.filter((v) => !(typeof v === "string" && /^rule-set:/i.test(v) && v.slice(9).split(",").some((n) => gone.has(n.trim()))));
    } else out[key] = ["nameserver", "default-nameserver", "proxy-server-nameserver", "fallback", "direct-nameserver"].includes(key) ? server(value) : value;
  }
  // mihomo's "the name servers are asked the way the rules say" is Stash's `follow-rule`.
  if (app === "stash" && dns["respect-rules"] === true) out["follow-rule"] = true;
  return out;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const groupsOf = (config: Record<string, unknown>): Record<string, unknown>[] =>
  (Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : []).filter((g): g is Record<string, unknown> => !!g && typeof g === "object");
