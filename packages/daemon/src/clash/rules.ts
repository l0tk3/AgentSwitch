/** A rule of a template as the user writes it (docs/clash-v0.md §7.7): `TYPE,value`, with no target — where it goes is
 *  the template's. A line pasted whole from a Clash file (`- DOMAIN-SUFFIX,cn,DIRECT  # 注释`) is taken down to that;
 *  a blank line or a `#` line is nothing; what is not a rule of a kind a rule set takes is refused, by its line. */

const TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-WILDCARD", "DOMAIN-REGEX", "GEOSITE", "IP-CIDR", "IP-CIDR6", "IP-SUFFIX", "IP-ASN", "GEOIP",
  "PROCESS-NAME", "PROCESS-NAME-WILDCARD", "PROCESS-NAME-REGEX", "PROCESS-PATH", "PROCESS-PATH-WILDCARD", "PROCESS-PATH-REGEX", "DST-PORT", "SRC-PORT", "NETWORK"]);
/** Rules judged by an address: for a name, the address has to be looked up first — unless the rule says `no-resolve`. */
const BY_ADDRESS = new Set(["IP-CIDR", "IP-CIDR6", "IP-SUFFIX", "IP-ASN", "GEOIP"]);
export const MAX_RULES = 3000;
const MAX_LINE = 300;

/** The rule a line holds; null for a line that holds none; `{ error }` for one that is not a rule. */
export function ruleLine(raw: string): string | null | { readonly error: string } {
  let line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  line = line.replace(/^-\s*/, "").replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  if (!line) return null;
  if (line.length > MAX_LINE) return { error: "太长了" };
  const comma = line.indexOf(",");
  const type = (comma < 0 ? line : line.slice(0, comma)).trim().toUpperCase();
  if (!TYPES.has(type)) return { error: /^(AND|OR|NOT|SUB-RULE|RULE-SET|MATCH)$/.test(type) ? `这里不收 ${type} 这种规则` : `不认识的规则类型 ${type || "（空）"}` };
  const rest = comma < 0 ? "" : line.slice(comma + 1).trim();
  // An expression may hold commas of its own: it is kept whole.
  if (type.endsWith("-REGEX")) return rest ? `${type},${rest}` : { error: "缺内容" };
  const parts = rest.split(",").map((p) => p.trim());
  if (!parts[0]) return { error: "缺内容" };
  // What follows the value is `no-resolve`, or a target that came along with a pasted line and is dropped.
  return `${type},${parts[0]}${parts.slice(1).some((p) => p.toLowerCase() === "no-resolve") ? ",no-resolve" : ""}`;
}

/** The rules of a text's lines, each once, in their order; or which line is not one. */
export function rulesFrom(lines: readonly string[]): { readonly rules: string[] } | { readonly error: string } {
  const rules: string[] = [], seen = new Set<string>();
  for (const [i, raw] of lines.entries()) {
    const rule = ruleLine(raw);
    if (rule === null) continue;
    if (typeof rule !== "string") return { error: `第 ${i + 1} 行不是一条规则（${rule.error}）：${raw.trim().slice(0, 60)}` };
    if (!seen.has(rule)) { seen.add(rule); rules.push(rule); }
  }
  return rules.length > MAX_RULES ? { error: `规则太多了（最多 ${MAX_RULES} 条）` } : { rules };
}

/** The rule needs a name's address looked up before it can say anything. */
export function looksUp(rule: string): boolean {
  return BY_ADDRESS.has(rule.slice(0, rule.indexOf(","))) && !rule.endsWith(",no-resolve");
}
