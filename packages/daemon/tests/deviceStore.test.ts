/** Paired devices (remote/deviceStore.ts) in `agentswitch.db`, where the old Dispatch's store kept them beside its own
 *  tables until 2026-11-25; and what is still read of those tables: the sessions its executors made. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { oldDispatchSessionIds } from "../src/daemon.js";
import { DeviceStore } from "../src/remote/deviceStore.js";

describe("the device store", () => {
  it("creates, lists newest first, touches and revokes; the token is kept as its hash alone", () => {
    let now = 1000;
    const store = new DeviceStore({ dbPath: ":memory:", now: () => now });
    const a = store.createDevice({ name: "iPhone", platform: "ios", tokenHash: "h-a" });
    now = 2000;
    const b = store.createDevice({ name: "Studio", platform: "mac", tokenHash: "h-b" });
    expect(a).toEqual({ id: a.id, name: "iPhone", platform: "ios", createdAt: 1000, lastSeenAt: null, revokedAt: null });
    expect(store.listDevices().map((d) => d.id)).toEqual([b.id, a.id]);
    expect(store.deviceTokenHashes()).toEqual(expect.arrayContaining([{ id: a.id, tokenHash: "h-a" }, { id: b.id, tokenHash: "h-b" }]));
    store.touchDevice(a.id, 2500);
    expect(store.getDevice(a.id)?.lastSeenAt).toBe(2500);
    now = 3000;
    expect(store.revokeDevice(a.id)).toMatchObject({ id: a.id, revokedAt: 3000 });
    expect(store.revokeDevice("nope")).toBeUndefined();
    expect(store.getDevice("nope")).toBeUndefined();
    store.close();
  });

  it("the pairings made before stay: the same table of a database the old Dispatch made, its own tables left as they are", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agentswitch-devices-")), "agentswitch.db");
    const old = new DatabaseSync(dbPath);
    old.exec("CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER)");
    old.exec("INSERT INTO devices (id, name, platform, token_hash, created_at) VALUES ('d1', 'iPhone', 'ios', 'h1', 5)");
    old.exec("CREATE TABLE thread_events (thread_id TEXT, seq INTEGER, ts INTEGER, type TEXT, payload TEXT)");
    const say = old.prepare("INSERT INTO thread_events (thread_id, seq, ts, type, payload) VALUES ('t1', ?, 0, ?, ?)");
    say.run(1, "session", JSON.stringify({ harness: "opencode", sessionId: "ses_1" }));
    say.run(2, "session", JSON.stringify({ harness: "codex", sessionId: "0199-abc" }));
    say.run(3, "session", "{not json");
    say.run(4, "summary", JSON.stringify({ sessionId: "not-a-session-event" }));
    say.run(5, "session", JSON.stringify({ harness: "opencode" }));
    old.close();

    const store = new DeviceStore({ dbPath });
    expect(store.listDevices()).toMatchObject([{ id: "d1", name: "iPhone", platform: "ios", createdAt: 5 }]);
    store.createDevice({ name: "iPad", platform: "ipados", tokenHash: "h2" });
    store.close();
    expect(new DeviceStore({ dbPath }).listDevices()).toHaveLength(2);
    // The sessions its executors made are still known, so the list of sessions leaves them out.
    expect(oldDispatchSessionIds(dbPath)).toEqual(new Set(["ses_1", "0199-abc"]));
  });

  it("where the old Dispatch never ran there are no such sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-devices-"));
    expect(oldDispatchSessionIds(join(dir, "missing.db"))).toEqual(new Set());
    new DeviceStore({ dbPath: join(dir, "agentswitch.db") }).close();
    expect(oldDispatchSessionIds(join(dir, "agentswitch.db"))).toEqual(new Set());
  });
});
