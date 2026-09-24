/** Device tokens (app-v0 §2 设备令牌): 32 random bytes as base64url, stored only as SHA-256, compared in constant time;
 *  a revoked device gets 401 at once. Also who is online, for GET /remote/info. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../engine/store.js";
import type { Device } from "../engine/types.js";

const TOKEN_BYTES = 32;
/** A device's last_seen_at is written at most this often; every request still authenticates against the table. */
export const LAST_SEEN_THROTTLE_MS = 60_000;
/** A device seen this recently, or with a request open now (an event stream), counts as online. */
export const ONLINE_WINDOW_MS = 5 * 60_000;
const BEARER = /^Bearer[ \t]+([A-Za-z0-9_-]{16,256})[ \t]*$/;

export function newToken(random: (n: number) => Buffer = randomBytes): string {
  return random(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new device row for a token; only the token's hash is stored. */
export function registerDevice(store: Store, input: { readonly name: string; readonly platform: string }, random?: (n: number) => Buffer): { readonly device: Device; readonly token: string } {
  const token = newToken(random);
  return { device: store.createDevice({ ...input, tokenHash: hashToken(token) }), token };
}

/** The device an `Authorization: Bearer <token>` header belongs to, or null (no header, wrong token, revoked). Every
 *  stored hash is compared with timingSafeEqual, revoked devices included, so timing says nothing about which failed.
 *  A match refreshes last_seen_at, at most once per LAST_SEEN_THROTTLE_MS. */
export function authenticate(store: Store, header: string | undefined, now: number = Date.now()): Device | null {
  const token = header ? BEARER.exec(header)?.[1] : undefined;
  if (!token) return null;
  const presented = Buffer.from(hashToken(token), "hex");
  let matchId: string | null = null;
  for (const row of store.deviceTokenHashes()) {
    const stored = Buffer.from(row.tokenHash, "hex");
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) matchId = row.id;
  }
  const device = matchId ? store.getDevice(matchId) : undefined;
  if (!device || device.revokedAt !== null) return null;
  if (device.lastSeenAt === null || now - device.lastSeenAt >= LAST_SEEN_THROTTLE_MS) {
    store.touchDevice(device.id, now);
    return { ...device, lastSeenAt: now };
  }
  return device;
}

/** Open requests per device (an SSE stream stays open for as long as the phone watches a task), each with a way to
 *  cut it: revoking a device ends its open streams too, not only its next request. */
export class Presence {
  private readonly open = new Map<string, Set<() => void>>();

  /** Count one open request; `cut` closes it on revocation. The returned function ends it (idempotent). */
  enter(deviceId: string, cut: () => void = () => undefined): () => void {
    const entry = () => cut();
    const set = this.open.get(deviceId) ?? new Set<() => void>();
    this.open.set(deviceId, new Set([...set, entry]));
    return () => {
      const current = this.open.get(deviceId);
      if (!current?.has(entry)) return;
      const rest = new Set([...current].filter((e) => e !== entry));
      if (rest.size) this.open.set(deviceId, rest);
      else this.open.delete(deviceId);
    };
  }

  connected(deviceId: string): boolean {
    return (this.open.get(deviceId)?.size ?? 0) > 0;
  }

  /** Cut every open request of a device (after revocation). Returns how many there were. */
  disconnect(deviceId: string): number {
    const current = [...(this.open.get(deviceId) ?? [])];
    this.open.delete(deviceId);
    for (const cut of current) {
      try { cut(); } catch { /* a socket that is already gone */ }
    }
    return current.length;
  }

  /** Non-revoked devices with a request open now or seen within ONLINE_WINDOW_MS. */
  online(devices: readonly Device[], now: number = Date.now()): Device[] {
    return devices.filter((d) => d.revokedAt === null && (this.connected(d.id) || (d.lastSeenAt !== null && now - d.lastSeenAt <= ONLINE_WINDOW_MS)));
  }
}
