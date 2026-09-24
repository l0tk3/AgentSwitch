/** Who may reach the remote listener (app-v0 §2 来源地址) and which of this Mac's addresses a phone can use (§2 配对:
 *  `lan`). Pure apart from reading the interface table, which callers may pass in. */

import { BlockList, isIPv4, isIPv6 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** Source networks the remote listener accepts: loopback, RFC 1918, link-local, Tailscale CGNAT, IPv6 ULA (incl.
 *  Tailscale's fd7a:115c:a1e0::/48) and IPv6 link-local. Nothing else, so there is no public surface. */
export const ALLOWED_SOURCES: readonly (readonly [string, number, "ipv4" | "ipv6"])[] = [
  ["127.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
];

/** RFC 1918 only: the `lan` addresses a phone on the same network can dial. */
const LAN_RANGES: readonly (readonly [string, number])[] = [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]];

function blockList(ranges: readonly (readonly [string, number, "ipv4" | "ipv6"])[]): BlockList {
  const list = new BlockList();
  for (const [net, prefix, type] of ranges) list.addSubnet(net, prefix, type);
  return list;
}

const SOURCES = blockList(ALLOWED_SOURCES);
const LAN = blockList(LAN_RANGES.map(([net, prefix]) => [net, prefix, "ipv4"] as const));

/** The address as the family it really is: an IPv4-mapped IPv6 address (`::ffff:10.0.0.2`, what a dual-stack socket
 *  reports for IPv4 peers) becomes plain IPv4, and an IPv6 zone (`fe80::1%en0`) is dropped. Null when unparsable. */
export function normalizeAddress(address: string | undefined | null): { readonly address: string; readonly type: "ipv4" | "ipv6" } | null {
  if (!address) return null;
  const bare = address.replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped && isIPv4(mapped[1]!)) return { address: mapped[1]!, type: "ipv4" };
  if (isIPv4(bare)) return { address: bare, type: "ipv4" };
  if (isIPv6(bare)) return { address: bare.toLowerCase(), type: "ipv6" };
  return null;
}

/** True when a peer at `address` may talk to the remote listener. Unknown or unparsable → false (fail closed). */
export function isAllowedSource(address: string | undefined | null): boolean {
  const a = normalizeAddress(address);
  return !!a && SOURCES.check(a.address, a.type);
}

/** The part of a socket the connection guard looks at; a fake in tests. */
export type GuardedSocket = { readonly remoteAddress?: string | undefined; destroy(): unknown };

/** `connection` hook: a socket from outside the allowed networks is destroyed before TLS starts. Returns whether the
 *  socket was kept. */
export function guardConnection(socket: GuardedSocket, allow: (address: string | undefined) => boolean = isAllowedSource): boolean {
  if (allow(socket.remoteAddress)) return true;
  socket.destroy();
  return false;
}

/** This Mac's private IPv4 addresses (RFC 1918, not internal), in interface order, without duplicates. */
export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const found = Object.values(interfaces).flatMap((list) => list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal && LAN.check(i.address, "ipv4"))
    .map((i) => i.address);
  return [...new Set(found)];
}
