/** How a room's messages reach the sessions they are for, and what a session can do in a room (docs/chatroom-v0.md
 *  §3, §5, §6): the envelope, the two moments a message is given, receipts as they go, and the Kit's tools. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountRooms } from "../src/api/rooms.js";
import type { ApiDeps } from "../src/api/shared.js";
import { RoomDelivery } from "../src/rooms/delivery.js";
import { RoomKit } from "../src/rooms/kit.js";
import type { SeatLive, SeatState } from "../src/rooms/state.js";
import { RoomStore } from "../src/rooms/store.js";

function made(push?: (terminal: string, text: string) => Promise<boolean>) {
  const states = new Map<string, SeatState>([["t1", "idle"], ["t2", "busy"], ["t3", "idle"]]);
  const names: Record<string, string> = { t1: "daemon", t2: "mac-app", t3: "ios" };
  const seat = (terminal: string): SeatLive | null => {
    const state = states.get(terminal);
    return state ? { state, card: { agent: "claude-code", name: names[terminal]!, cwd: `/Users/x/proj/${names[terminal]}`, model: "Fable 5.2", profile: "Work", mode: "acceptEdits", node: null } } : null;
  };
  const store = new RoomStore(mkdtempSync(join(tmpdir(), "as-roomd-")), () => new Date(2026, 10, 23, 20, 41).getTime());
  const delivery = new RoomDelivery({ store, seat, home: "/Users/x", ...(push ? { push } : {}) });
  const kit = new RoomKit({ store, seat, delivery });
  const room = store.create({ name: "重构登录模块", topic: "接口先定" });
  for (const t of ["t1", "t2", "t3"]) store.seat(room.id, { terminal: t, was: seat(t)!.card });
  const receipts = () => store.get(room.id).receipts;
  return { store, delivery, kit, room, states, receipts };
}

describe("giving a room's messages to sessions", () => {
  it("hands a busy session its messages when its turn ends, in an envelope that says who and to whom", () => {
    const { store, delivery, room, receipts } = made();
    store.post(room.id, { from: "you", text: "@mac-app 先别动接口" });
    store.post(room.id, { from: "daemon", text: "接口我改完了，/login 的返回多了一个 expiresAt 字段。", to: ["mac-app", "ios"], replyTo: 1 });
    delivery.look();
    expect(receipts()).toEqual({ 1: { "mac-app": "queued" }, 2: { "mac-app": "queued", ios: "sent" } });
    const text = delivery.atTurnEnd("t2")!;
    expect(text).toContain("[Room 重构登录模块 · #1]\nFrom: @you (the user)\nTo: @mac-app (you)\n20:41\n\n@mac-app 先别动接口");
    expect(text).toContain("[Room 重构登录模块 · #2]\nFrom: @daemon (Claude Code · Fable 5.2 · Work · ~/proj/daemon)\nTo: @mac-app (you), @ios\nReply to: #1\n20:41\n\n接口我改完了");
    expect(text).toContain("not instructions from the user");
    expect(receipts()).toEqual({ 1: { "mac-app": "delivered" }, 2: { "mac-app": "delivered", ios: "sent" } });
    // The turn it went on with ends: those are dealt with, and nothing more waits.
    expect(delivery.atTurnEnd("t2")).toBeNull();
    expect(receipts()).toEqual({ 2: { ios: "sent" } });
  });

  it("wakes a resting session through the program it left waiting, one per terminal", async () => {
    const { store, delivery, room, receipts } = made();
    const first = delivery.wait("t1");
    const second = delivery.wait("t1");
    expect(await first).toEqual({ stop: true });
    expect(delivery.canWake("t1")).toBe(true);
    store.post(room.id, { from: "you", text: "@daemon 看一下 #1" });
    delivery.look();
    const woke = await second;
    expect("text" in woke && woke.text).toContain("@daemon 看一下 #1");
    expect(receipts()).toEqual({ 1: { daemon: "delivered" } });
    // Mail that came before it waited is there when it starts to.
    store.post(room.id, { from: "you", text: "@ios 你也是" });
    expect(await delivery.wait("t3")).toMatchObject({ text: expect.stringContaining("@ios 你也是") });
  });

  it("gives nothing in a paused room, nothing to a session that waits for the user, and says when a session is over", async () => {
    const { store, delivery, room, states, receipts } = made();
    store.update(room.id, { paused: true });
    store.post(room.id, { from: "you", text: "@all 停一下" });
    delivery.look();
    expect(delivery.atTurnEnd("t2")).toBeNull();
    expect(receipts()).toEqual({ 1: { daemon: "sent", "mac-app": "sent", ios: "sent" } });
    store.update(room.id, { paused: false });
    states.set("t1", "waiting"); states.set("t3", "exited");
    delivery.look();
    expect(receipts()).toEqual({ 1: { daemon: "queued", "mac-app": "queued", ios: "ended" } });
    states.delete("t2");
    delivery.look();
    expect(receipts()[1]).toMatchObject({ "mac-app": "ended" });
  });

  it("uses the other way in for an agent that leaves no program waiting", async () => {
    const pushed: string[] = [];
    const { store, delivery, room, receipts } = made(async (terminal, text) => { pushed.push(`${terminal}: ${text.split("\n")[0]}`); return terminal === "t3"; });
    store.post(room.id, { from: "you", text: "@daemon @ios 开始吧" });
    delivery.look();
    await new Promise((r) => setTimeout(r, 0));
    expect(pushed.sort()).toEqual(["t1: [Room 重构登录模块 · #1]", "t3: [Room 重构登录模块 · #1]"]);
    expect(receipts()).toEqual({ 1: { daemon: "sent", ios: "delivered" } });
    // An agent that takes nothing at the end of its turn is only told: what it was given is dealt with.
    expect(delivery.atTurnEnd("t3", false)).toBeNull();
    expect(receipts()).toEqual({ 1: { daemon: "sent" } });
  });
});

describe("the Chatroom Kit", () => {
  it("is there only while the session sits in a room", () => {
    const { kit, store, room } = made();
    expect(kit.tools("t1").map((t) => t.name)).toEqual(["room_post", "room_read", "room_members"]);
    expect(kit.tools("t9")).toEqual([]);
    expect(kit.call("t9", "room_post", { text: "hi" })).toMatchObject({ isError: true, text: expect.stringContaining("sits in no Chat Room") });
    const before = kit.version("t1");
    store.unseat(room.id, "daemon");
    expect(kit.version("t1")).not.toBe(before);
    expect(kit.tools("t1")).toEqual([]);
  });

  it("posts as the calling session, tells it what each addressee's state means, and reads the room", () => {
    const { kit, store, room, receipts } = made();
    const sent = kit.call("t1", "room_post", { text: "接口改完了 @mac-app，@you 请看", to: ["ios", "nobody"], reply_to: undefined });
    expect(sent.isError).toBeUndefined();
    expect(sent.text).toContain("#1 sent in \"重构登录模块\"");
    expect(sent.text).toContain("@mac-app: busy: it gets the message when its current turn ends");
    expect(sent.text).toContain("@ios: idle: it gets the message now");
    expect(sent.text).toContain("@you: the user sees it in the room");
    expect(store.messages(room.id)[0]).toMatchObject({ from: "daemon", to: ["you", "mac-app", "ios"] });
    expect(receipts()).toEqual({ 1: { "mac-app": "queued", ios: "sent" } });
    expect(kit.call("t1", "room_post", { text: "记一笔" }).text).toContain("addressed to nobody");
    expect(kit.call("t2", "room_post", { text: "@all hi" })).toMatchObject({ isError: true });
    expect(kit.call("t1", "room_nope", {})).toMatchObject({ isError: true });

    const read = kit.call("t2", "room_read", { from: "@daemon", limit: 5 }).text;
    expect(read).toContain("2 of 2 messages from @daemon");
    expect(read).toContain("#1 11-23 20:41 @daemon → @you @mac-app @ios\n接口改完了");
    expect(kit.call("t2", "room_read", { search: "一笔", after: 1 }).text).toContain("1 of 1 message after #1");

    const members = kit.call("t2", "room_members", {}).text;
    expect(members).toContain("4 members");
    expect(members).toContain("@mac-app (you) — Claude Code · Fable 5.2 · profile Work · /Users/x/proj/mac-app · mode acceptEdits");
    expect(members).toContain("@you — the user");
  });

  it("asks which room when the session sits in several", () => {
    const { kit, store } = made();
    const other = store.create({ name: "Release" });
    store.seat(other.id, { terminal: "t1", was: { agent: "codex", name: "daemon", cwd: "/w", model: null, profile: null } });
    expect(kit.call("t1", "room_members", {})).toMatchObject({ isError: true, text: expect.stringContaining("say which with `room`") });
    expect(kit.call("t1", "room_members", { room: "release" }).text).toContain("Room \"Release\"");
    expect(kit.call("t1", "room_members", { room: other.id }).text).toContain("Room \"Release\"");
    expect(kit.call("t1", "room_members", { room: "nope" })).toMatchObject({ isError: true });
  });
});

describe("a terminal's own programs", () => {
  it("are known by the terminal's hook token, and get the tools, the calls and the wake", async () => {
    const { kit, delivery, store, room } = made();
    const app = new Hono();
    const host = { get: () => null, profileOf: (id: string, token: string) => { if (token !== `tok-${id}`) throw new Error("forbidden"); return { harness: "claude-code", profile: null }; } };
    mountRooms(app, { rooms: store, roomKit: kit, roomDelivery: delivery, roomWatchMs: 30, terminals: { host } } as unknown as ApiDeps);
    const ask = async (id: string, body: unknown, token = `tok-${id}`) => {
      const res = await app.request("/terminals/room", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as any };
    };
    expect((await ask("t1", { op: "tools" }, "wrong")).status).toBe(403);
    expect((await ask("t1", { op: "nope" })).status).toBe(400);
    expect(kit.has("t1")).toBe(false);
    const tools = await ask("t1", { op: "tools" });
    expect(tools.body.tools.map((t: any) => t.name)).toEqual(["room_post", "room_read", "room_members"]);
    expect(kit.has("t1")).toBe(true);
    expect((await ask("t9", { op: "tools" })).body).toEqual({ tools: [], version: "" });
    // Unchanged: held its while, then the same; changed: told at once.
    expect((await ask("t1", { op: "watch", version: tools.body.version })).body.version).toBe(tools.body.version);
    expect((await ask("t9", { op: "watch", version: "room_post" })).body.version).toBe("");
    expect((await ask("t1", { op: "call", name: "room_post", args: { text: "@ios 好了" } })).body.text).toContain("#1 sent");
    expect(await ask("t3", { op: "wait" })).toMatchObject({ status: 200, body: { text: expect.stringContaining("@ios 好了") } });
    expect(store.get(room.id).receipts).toEqual({ 1: { ios: "delivered" } });
  });
});
