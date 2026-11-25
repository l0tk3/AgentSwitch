/** The devices paired with this node (docs/app-v0.md §2): the `devices` table of `agentswitch.db`, where it has always
 *  been — the pairings made before stay. Apart from the task engine's store, which kept it until 2026-11-25. */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Device = {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  readonly revokedAt: number | null;
};

/** What pairing and the remote listener need of where devices are kept. */
export type Devices = {
  createDevice(input: { readonly name: string; readonly platform: string; readonly tokenHash: string }): Device;
  getDevice(id: string): Device | undefined;
  listDevices(): Device[];
  deviceTokenHashes(): { readonly id: string; readonly tokenHash: string }[];
  revokeDevice(id: string): Device | undefined;
  touchDevice(id: string, ts?: number): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);`;

type Row = Record<string, unknown>;

export class DeviceStore implements Devices {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(opts: { readonly dbPath: string; readonly now?: () => number }) {
    if (opts.dbPath !== ":memory:") mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.now = opts.now ?? Date.now;
  }

  createDevice(input: { readonly name: string; readonly platform: string; readonly tokenHash: string }): Device {
    const id = randomUUID().slice(0, 8);
    this.db.prepare("INSERT INTO devices (id, name, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, input.name, input.platform, input.tokenHash, this.now());
    return this.getDevice(id)!;
  }

  getDevice(id: string): Device | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return r ? toDevice(r) : undefined;
  }

  listDevices(): Device[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY created_at DESC, id").all() as Row[]).map(toDevice);
  }

  /** Every device's token hash, revoked ones included, for the caller's constant-time comparison. */
  deviceTokenHashes(): { readonly id: string; readonly tokenHash: string }[] {
    return (this.db.prepare("SELECT id, token_hash FROM devices").all() as Row[]).map((r) => ({ id: String(r.id), tokenHash: String(r.token_hash) }));
  }

  /** Revocation is permanent; revoking twice keeps the first time. Undefined when there is no such device. */
  revokeDevice(id: string): Device | undefined {
    this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(this.now(), id);
    return this.getDevice(id);
  }

  touchDevice(id: string, ts: number = this.now()): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(ts, id);
  }

  close(): void { this.db.close(); }
}

function toDevice(r: Row): Device {
  return {
    id: String(r.id), name: String(r.name), platform: String(r.platform), createdAt: Number(r.created_at),
    lastSeenAt: r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
  };
}
