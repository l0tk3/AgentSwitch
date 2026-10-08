/** Clash Verge Rev as it is found on this Mac (docs/clash-v0.md §1, §6): where it keeps its subscriptions, which one is
 *  in use, and the socket its core (mihomo) is controlled through. Read only: nothing of Clash Verge's is written. */

import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export type VergeProfile = { readonly uid: string; readonly name: string; readonly type: string; readonly file: string;
  /** Where it is updated from, for one that is fetched (its query, which may hold a token, left out). */ readonly from?: string };
export type VergeProfiles = { readonly current: string | null; readonly profiles: readonly VergeProfile[] };

export const VERGE_DIR = "Library/Application Support/io.github.clash-verge-rev.clash-verge-rev";
/** A subscription's uid, as Clash Verge names its files. */
const UID = /^[A-Za-z0-9]{6,32}$/;

export function vergeDir(home: string = homedir()): string { return join(home, VERGE_DIR); }

/** The subscriptions Clash Verge has (not its merge, script, rules, proxies and groups extensions), and the current one. */
export function vergeProfiles(dir: string = vergeDir()): VergeProfiles | null {
  let doc: unknown;
  try { doc = parse(readFileSync(join(dir, "profiles.yaml"), "utf8")); } catch { return null; }
  const o = (doc && typeof doc === "object" ? doc : {}) as { current?: unknown; items?: unknown };
  const items = Array.isArray(o.items) ? o.items : [];
  const profiles = items.flatMap((it): VergeProfile[] => {
    const p = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    if (typeof p.uid !== "string" || !UID.test(p.uid) || (p.type !== "remote" && p.type !== "local")) return [];
    const from = typeof p.url === "string" ? origin(p.url) : null;
    return [{ uid: p.uid, name: typeof p.name === "string" && p.name ? p.name.slice(0, 120) : p.uid, type: p.type, file: typeof p.file === "string" ? p.file : `${p.uid}.yaml`, ...(from ? { from } : {}) }];
  });
  return { current: typeof o.current === "string" && UID.test(o.current) ? o.current : null, profiles };
}

/** A subscription's own text, as Clash Verge last fetched or kept it; null when it is not one of its subscriptions. */
export function vergeProfileText(uid: string, dir: string = vergeDir()): string | null {
  const profile = vergeProfiles(dir)?.profiles.find((p) => p.uid === uid);
  if (!profile || !/^[\w.-]+$/.test(profile.file)) return null;
  try { return readFileSync(join(dir, "profiles", profile.file), "utf8"); } catch { return null; }
}

/** The socket Clash Verge's core is controlled through: the one its service gives the core for this user, else the
 *  one its generated configuration names. Null when there is none (Clash Verge is not running). */
export function vergeSocket(dir: string = vergeDir(), uid: number = userInfo().uid): string | null {
  const service = `/var/run/clash-verge-service/users/${uid}/verge-mihomo.sock`;
  if (existsSync(service)) return service;
  try {
    const named = (parse(readFileSync(join(dir, "clash-verge.yaml"), "utf8")) as { "external-controller-unix"?: unknown })["external-controller-unix"];
    return typeof named === "string" && named.startsWith("/") && existsSync(named) ? named : null;
  } catch { return null; }
}

function origin(url: string): string | null {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return null; }
}
