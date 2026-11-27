/** A profile's `Direct` rules (docs/profiles-v0.md §4.3): the addresses its browser — Chrome or Camoufox — and its
 *  terminals reach straight from this Mac, past the profile's proxy. The forwarder asks them for every request. */

const bare = (hostname: string): string => hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

/** What a profile's browser reaches straight when no rules of its own were set: NetBird's service and its peers. */
export const DEFAULT_DIRECT: readonly string[] = ["netbird.io", "*.netbird.io", "*.netbird.cloud", "100.64.0.0/10"];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const ipv4 = (s: string): number | null => {
  const m = IPV4.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((n) => n > 255) ? null : ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
};
const NAME = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A rule as kept, or null when it is not one: a name (`netbird.io`, that name alone), `*.` and a name (any name
 *  under it, not the name itself), an IPv4 address, or an IPv4 CIDR (`100.64.0.0/10`). Lower case, no dot at the end. */
export function directRule(said: string): string | null {
  const r = said.trim().toLowerCase().replace(/\.$/, "");
  if (!r || r.length > 253) return null;
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(r);
  if (cidr) return ipv4(cidr[1]!) !== null && Number(cidr[2]) <= 32 ? `${cidr[1]}/${Number(cidr[2])}` : null;
  if (IPV4.test(r)) return ipv4(r) !== null ? r : null;
  return NAME.test(r) && r.includes(".") ? r : null;
}

/** `hostname` (as the browser asked for it) is one a rule says goes straight. CIDRs and addresses match an address
 *  asked for as such; a name is not resolved here to match one (what the name is is the upstream's to look up). */
export function directMatch(hostname: string, rules: readonly string[]): boolean {
  const h = bare(hostname), ip = ipv4(h);
  return rules.some((rule) => {
    if (rule.includes("/")) {
      const [base, bits] = rule.split("/"), b = ipv4(base!), n = Number(bits);
      if (ip === null || b === null) return false;
      const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
      return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
    }
    if (rule.startsWith("*.")) return h.endsWith(rule.slice(1)) && h.length > rule.length - 1;
    return h === rule;
  });
}
