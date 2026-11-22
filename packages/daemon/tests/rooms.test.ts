/** Chat Room as it is kept and as the screens get it (docs/chatroom-v0.md §1–§5): names and faces, who a message is
 *  for, receipts, and the routes. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountRooms, seatState } from "../src/api/rooms.js";
import type { ApiDeps } from "../src/api/shared.js";
import { apart, faceOf, MIN_APART } from "../src/rooms/face.js";
import { freeHandle, handleFrom, mentions } from "../src/rooms/names.js";
import { RoomError, RoomStore } from "../src/rooms/store.js";
import type { TerminalInfo } from "../src/terminals/host.js";

const home = () => mkdtempSync(join(tmpdir(), "as-rooms-"));
const was = (name: string, agent = "claude-code") => ({ agent, name, cwd: `/work/${name}`, model: "fable", profile: null });

describe("a seat's name and face", () => {
  it("makes a handle from a name, of any script, and keeps it apart from the taken and the reserved", () => {
    expect(handleFrom("Mac App")).toBe("mac-app");
    expect(handleFrom("  fix: login/expiry  ")).toBe("fix-login-expiry");
    expect(handleFrom("重构 登录")).toBe("重构-登录");
    expect(handleFrom("!!!", "codex")).toBe("codex");
    expect(freeHandle("daemon", new Set(["daemon", "daemon-2"]))).toBe("daemon-3");
    expect(freeHandle("you", new Set())).toBe("you-1");
    expect(freeHandle("all", new Set())).toBe("all-1");
  });

  it("reads the @names of a text, and not an address or a package's scope", () => {
    expect(mentions("@daemon 看一下，@ios-app 也是；@Daemon 别忘了")).toEqual(["daemon", "ios-app"]);
    expect(mentions("mail a@b.com, install @types/node… (@web)")).toEqual(["types", "web"]);
    expect(mentions("x@y @all")).toEqual(["all"]);
  });

  it("gives a name the same face every time, a shape and not a bar, and one apart from those seated", () => {
    const a = faceOf("daemon");
    expect(faceOf("daemon")).toEqual(a);
    expect(a.rows).toHaveLength(5);
    for (const row of a.rows) { expect(row).toMatch(/^[#.]{5}$/); expect(row).toBe([...row].reverse().join("")); }
    expect(a.color).toBeGreaterThanOrEqual(0); expect(a.color).toBeLessThan(10);
    const lit = a.rows.join("").split("#").length - 1;
    expect(lit).toBeGreaterThanOrEqual(9); expect(lit).toBeLessThanOrEqual(17);
    // With its own face taken, it takes its next.
    const next = faceOf("daemon", [a]);
    expect(apart(next.rows, a.rows)).toBeGreaterThanOrEqual(MIN_APART);
    const names = ["daemon", "mac-app", "ios-app", "android", "web", "gate", "infra", "review", "docs", "tests", "design", "release"];
    const seated: ReturnType<typeof faceOf>[] = [];
    for (const n of names) { const f = faceOf(n, seated); for (const s of seated) expect(apart(f.rows, s.rows)).toBeGreaterThanOrEqual(MIN_APART); seated.push(f); }
  });
});

describe("rooms as kept", () => {
  it("seats sessions under names that stay, and gives a returning one its old seat", () => {
    const store = new RoomStore(home());
    const room = store.create({ name: "  重构   登录模块 ", topic: "接口先定" });
    expect(room.name).toBe("重构 登录模块");
    expect(room.seats.map((s) => s.handle)).toEqual(["you"]);
    const a = store.seat(room.id, { terminal: "t1", was: was("daemon") });
    const b = store.seat(room.id, { terminal: "t2", was: was("daemon") });
    expect([a.handle, b.handle]).toEqual(["daemon", "daemon-2"]);
    expect(a.canAdd).toBe(false);
    expect(() => store.seat(room.id, { terminal: "t1", was: was("daemon") })).toThrow(RoomError);
    store.unseat(room.id, "daemon");
    expect(store.roomsOf("t1")).toEqual([]);
    const back = store.seat(room.id, { terminal: "t1", was: was("renamed") });
    expect(back.handle).toBe("daemon");
    expect(back.face).toEqual(a.face);
    expect(() => store.unseat(room.id, "you")).toThrow(RoomError);
  });

  it("keeps the switch off for a session another session started", () => {
    const store = new RoomStore(home());
    const room = store.create({ name: "r" });
    store.seat(room.id, { terminal: "t1", was: was("lead"), canAdd: true });
    const child = store.seat(room.id, { terminal: "t2", was: was("helper"), byAgent: true, canAdd: true, by: "lead" });
    expect(child.canAdd).toBe(false);
    expect(() => store.setCanAdd(room.id, "helper", true)).toThrow(/不能再拉会话/);
    expect(store.setCanAdd(room.id, "lead", false).canAdd).toBe(false);
  });

  it("addresses a message by its @names, keeps a receipt per seat until it is dealt with, and survives a restart", () => {
    const dir = home();
    let at = 1000;
    const store = new RoomStore(dir, () => at++);
    const room = store.create({ name: "r" });
    store.seat(room.id, { terminal: "t1", was: was("daemon") });
    store.seat(room.id, { terminal: "t2", was: was("ios") });
    const m1 = store.post(room.id, { from: "you", text: "@daemon @nobody @you 接口改完了吗" });
    expect(m1).toMatchObject({ seq: 1, from: "you", to: ["daemon"] });
    const m2 = store.post(room.id, { from: "daemon", text: "改完了 @you，另见附注", to: ["@ios"], replyTo: 1 });
    expect([...m2.to].sort()).toEqual(["ios", "you"]);
    expect(store.post(room.id, { from: "you", text: "@all 停一下" }).to).toEqual(["daemon", "ios"]);
    expect(() => store.post(room.id, { from: "ios", text: "@all hi" })).toThrow(/只有用户/);
    expect(() => store.post(room.id, { from: "ios", text: "  " })).toThrow(RoomError);
    expect(() => store.post(room.id, { from: "ios", text: "x", replyTo: 9 })).toThrow(/#9/);
    expect(store.post(room.id, { from: "ios", text: "只是记一笔" }).to).toEqual([]);
    expect(store.get(room.id).receipts).toEqual({ 1: { daemon: "sent" }, 2: { ios: "sent" }, 3: { daemon: "sent", ios: "sent" } });
    store.setReceipt(room.id, 1, "daemon", "delivered");
    store.setReceipt(room.id, 3, "ios", null);
    store.setReceipt(room.id, 2, "ios", null);
    expect(store.get(room.id).receipts).toEqual({ 1: { daemon: "delivered" }, 3: { daemon: "sent" } });
    // The user's own words are seen; the two after them are not, and one of those is not for the user.
    expect(store.unread(room.id)).toEqual({ count: 1, forYou: false });
    expect(store.read(room.id, 99).readSeq).toBe(4);
    // A seat that leaves takes what was on its way to it.
    store.unseat(room.id, "daemon");
    expect(store.get(room.id).receipts).toEqual({});
    expect(() => store.post(room.id, { from: "daemon", text: "x" })).toThrow(/离开/);

    const again = new RoomStore(dir);
    expect(again.list().map((r) => r.id)).toEqual([room.id]);
    expect(again.messages(room.id).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(again.messages(room.id, { after: 2 }).map((m) => m.seq)).toEqual([3, 4]);
    expect(again.messages(room.id, { limit: 1 }).map((m) => m.seq)).toEqual([4]);
    expect(again.post(room.id, { from: "you", text: "继续" }).seq).toBe(5);
    again.remove(room.id);
    expect(new RoomStore(dir).list()).toEqual([]);
  });
});

function terminal(id: string, name: string, over: Partial<TerminalInfo> = {}): TerminalInfo {
  return { id, harness: "claude-code", cwd: "/w", workdir: `/w/${name}`, model: "fable", modelNow: null, modeNow: null, mode: "default", name, status: "idle", notices: [], profile: { id: "p", name: "Work", color: "teal" }, ...over } as unknown as TerminalInfo;
}

function made() {
  const terminals = new Map<string, TerminalInfo>([["t1", terminal("t1", "daemon")], ["t2", terminal("t2", "Mac App", { status: "working", modelNow: "opus" })], ["t3", terminal("t3", "old", { status: "exited" })]]);
  const store = new RoomStore(home());
  const changed: string[] = [];
  const app = new Hono();
  mountRooms(app, { rooms: store, roomsChanged: (id: string) => { changed.push(id); }, terminals: { host: { get: (id: string) => terminals.get(id) ?? null } } } as unknown as ApiDeps);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, etag: res.headers.get("etag"), body: res.status === 304 ? null : await res.json() as any };
  };
  return { call, terminals, store, changed };
}

describe("rooms for the screens", () => {
  it("says a terminal's state in the room's words", () => {
    expect(seatState(null)).toBe("exited");
    expect(seatState(terminal("a", "a", { status: "working" }))).toBe("busy");
    expect(seatState(terminal("a", "a", { status: "waiting" }))).toBe("waiting");
    expect(seatState(terminal("a", "a", { status: "working", notices: [{ id: "trouble", text: "Retrying in 4s", at: 1 }] }))).toBe("reconnecting");
    expect(seatState(terminal("a", "a", { status: "exited", notices: [{ id: "trouble", text: "x", at: 1 }] }))).toBe("exited");
  });

  it("makes a room with the sessions named, shows each seat as its terminal is now, and takes the user's words", async () => {
    const { call, terminals, changed } = made();
    const created = await call("POST", "/rooms", { name: "登录", topic: "先定接口", terminals: ["t1", "t2", "t3", "nope"] });
    expect(created.status).toBe(201);
    expect(created.body.problems).toHaveLength(2);
    const id = created.body.room.id as string;
    expect(created.body.seats.map((s: any) => [s.handle, s.state])).toEqual([["you", null], ["daemon", "idle"], ["mac-app", "busy"]]);
    expect(created.body.seats[2].card).toEqual({ agent: "claude-code", name: "Mac App", cwd: "/w/Mac App", model: "opus", profile: "Work", color: "teal", mode: "default", node: null });

    const said = await call("POST", `/rooms/${id}/messages`, { text: "@mac-app 模型要加 expiresAt" });
    expect(said.status).toBe(201);
    expect(said.body).toMatchObject({ message: { seq: 1, to: ["mac-app"] }, receipts: { "mac-app": "sent" } });
    expect(changed).toEqual([id]);

    const first = await call("GET", `/rooms/${id}`);
    expect(first.body.messages).toHaveLength(1);
    expect(first.body.receipts).toEqual({ 1: { "mac-app": "sent" } });
    // Unchanged: not sent again.
    expect((await call("GET", `/rooms/${id}`, undefined, { "if-none-match": first.etag! })).status).toBe(304);
    expect((await call("GET", `/rooms/${id}?after=1`)).body.messages).toEqual([]);

    // Its terminal gone, a seat shows as it was, ended.
    terminals.delete("t2");
    const later = await call("GET", `/rooms/${id}`);
    expect(later.body.seats[2]).toMatchObject({ handle: "mac-app", state: "exited", card: { name: "Mac App", model: "opus", mode: null } });

    const list = await call("GET", "/rooms");
    expect(list.body.rooms).toMatchObject([{ id, name: "登录", members: 3, unread: 0, forYou: false, last: { seq: 1, from: "you" } }]);
  });

  it("seats, switches, pauses, and refuses what a room can not have", async () => {
    const { call } = made();
    const id = (await call("POST", "/rooms", { name: "r" })).body.room.id as string;
    expect((await call("POST", "/rooms", { name: "   " })).status).toBe(400);
    expect((await call("POST", `/rooms/${id}/seats`, { terminal: "t3" })).status).toBe(409);
    expect((await call("POST", `/rooms/${id}/seats`, { terminal: "gone" })).status).toBe(404);
    expect((await call("POST", `/rooms/${id}/seats`, { terminal: "t1", canAdd: true })).body.seat).toMatchObject({ handle: "daemon", canAdd: true });
    expect((await call("POST", `/rooms/${id}/seats`, { terminal: "t1" })).status).toBe(409);
    expect((await call("PATCH", `/rooms/${id}/seats/daemon`, { canAdd: false })).body.seat.canAdd).toBe(false);
    expect((await call("PATCH", `/rooms/${id}/seats/you`, { canAdd: false })).status).toBe(400);
    expect((await call("PATCH", `/rooms/${id}`, { paused: true, topic: "新的" })).body.room).toMatchObject({ paused: true, topic: "新的" });
    expect((await call("POST", `/rooms/${id}/messages`, { text: "" })).status).toBe(400);
    expect((await call("POST", `/rooms/${id}/messages`, { text: "x", from: "daemon" })).status).toBe(400);
    expect((await call("POST", `/rooms/${id}/read`, { seq: 5 })).body).toEqual({ readSeq: 0 });
    expect((await call("DELETE", `/rooms/${id}/seats/daemon`)).status).toBe(200);
    expect((await call("GET", `/rooms/${id}`)).body.seats[1]).toMatchObject({ handle: "daemon" });
    expect((await call("GET", `/rooms/${id}`)).body.seats[1].left).not.toBeNull();
    expect((await call("DELETE", `/rooms/${id}`)).status).toBe(200);
    expect((await call("GET", `/rooms/${id}`)).status).toBe(404);
  });
});
