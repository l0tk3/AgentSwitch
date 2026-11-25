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

describe("戳一下: a message given now (user #236)", () => {
  it("types what waits for a busy member into its terminal now, and says why when it can not", async () => {
    const store = new RoomStore(mkdtempSync(join(tmpdir(), "as-poke-")));
    const states = new Map<string, SeatState>([["t1", "busy"], ["t2", "busy"]]);
    const seat = (terminal: string): SeatLive | null => (states.has(terminal) ? { state: states.get(terminal)!, card: { agent: "claude-code", name: terminal === "t1" ? "api" : "ui", cwd: "/w", model: null, profile: null, mode: "default", node: null } } : null);
    const poked: [string, string][] = [];
    const delivery = new RoomDelivery({ store, seat, poke: async (terminal, text) => (terminal === "t2" ? { given: false, why: "它在等你回答或批准，先处理那个" } : (poked.push([terminal, text]), { given: true })) });
    const room = store.create({ name: "r" });
    for (const t of ["t1", "t2"]) store.seat(room.id, { terminal: t, was: seat(t)!.card });
    store.post(room.id, { from: "you", text: "@api @ui 先停一下" });
    delivery.look();
    expect(store.get(room.id).receipts).toEqual({ 1: { api: "queued", ui: "queued" } });
    expect(await delivery.poke(room.id, "api")).toEqual({ given: true });
    expect(poked[0]![1].startsWith("[Room r · #1]")).toBe(true);
    expect(await delivery.poke(room.id, "ui")).toEqual({ given: false, why: "它在等你回答或批准，先处理那个" });
    expect(store.get(room.id).receipts).toEqual({ 1: { api: "delivered", ui: "queued" } });
    expect(await delivery.poke(room.id, "api")).toMatchObject({ given: false });
    // Over the API: everyone something waits for, or one.
    const app = new Hono();
    mountRooms(app, { rooms: store, roomDelivery: delivery } as unknown as ApiDeps);
    const res = await app.request(`/rooms/${room.id}/poke`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(await res.json()).toEqual({ results: [{ handle: "ui", given: false, why: "它在等你回答或批准，先处理那个" }] });
  });
});

describe("giving a room's messages to sessions", () => {
  it("hands a busy session its messages when its turn ends, in an envelope that says who and to whom", () => {
    const { store, delivery, room, receipts } = made();
    store.post(room.id, { from: "you", text: "@mac-app 先别动接口" });
    store.post(room.id, { from: "daemon", text: "接口我改完了，/login 的返回多了一个 expiresAt 字段。", to: ["mac-app", "ios"], replyTo: 1 });
    delivery.look();
    expect(receipts()).toEqual({ 1: { "mac-app": "queued" }, 2: { "mac-app": "queued", ios: "sent" } });
    const text = delivery.atTurnEnd("t2")!;
    // The newest whole; the earlier one in a line, and the room to be read for the rest.
    expect(text.startsWith("[Room 重构登录模块 · #2]\nFrom: @daemon (Claude Code · Fable 5.2 · ~/proj/daemon)\nTo: @mac-app (you), @ios\nReply to: #1\n20:41\n\n接口我改完了")).toBe(true);
    expect(text).toContain("Also for you, earlier, not shown whole (1):\n  #1 from @you: @mac-app 先别动接口");
    expect(text).not.toContain("[Room 重构登录模块 · #1]");
    expect(text).toContain("What is From @you is the user's own words");
    expect(text).toContain("room_read");
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

  it("tells a member once, after ten things said with the default avatar, that it may choose one (user #417)", async () => {
    const pushed: string[] = [];
    const { store, delivery, room } = made(async (terminal, text) => { if (terminal === "t3") pushed.push(text); return true; });
    const ask = async () => { store.post(room.id, { from: "you", text: "@ios 继续" }); delivery.look(); await new Promise((r) => setTimeout(r, 0)); };
    for (let i = 0; i < 9; i++) store.post(room.id, { from: "ios", text: `第 ${i} 句` });
    await ask();
    expect(pushed.at(-1)).not.toContain("default avatar");
    store.post(room.id, { from: "ios", text: "第十句" });
    await ask();
    expect(pushed.at(-1)).toContain("you still have the default avatar");
    expect(store.get(room.id).stats.ios).toMatchObject({ posts: 10, tips: 1 });
    await ask();
    expect(pushed.at(-1)).not.toContain("default avatar");
    // One that chose its own is never told.
    store.setAvatar("t1", { classic: { kind: "emoji", emoji: "🦊", bg: 1 } });
    for (let i = 0; i < 12; i++) store.post(room.id, { from: "daemon", text: `第 ${i} 句` });
    const mine: string[] = [];
    const d2 = new RoomDelivery({ store, seat: () => ({ state: "idle", card: { agent: "claude-code", name: "daemon", cwd: "/w", model: "m", profile: "p", mode: "default", node: null } }), home: "/Users/x", push: async (_t, text) => { mine.push(text); return true; } });
    store.post(room.id, { from: "you", text: "@daemon 继续" });
    d2.look();
    await new Promise((r) => setTimeout(r, 0));
    expect(mine.join("")).not.toContain("default avatar");
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
  it("is there only while the session sits in a room", async () => {
    const { kit, store, room } = made();
    expect(kit.tools("t1").map((t) => t.name)).toEqual(["room_post", "room_read", "room_tasks", "room_info", "room_update"]);
    expect(kit.tools("t9")).toEqual([]);
    expect((await kit.call("t9", "room_post", { text: "hi" }))).toMatchObject({ isError: true, text: expect.stringContaining("sits in no Chat Room") });
    const before = kit.version("t1");
    store.unseat(room.id, "daemon");
    expect(kit.version("t1")).not.toBe(before);
    expect(kit.tools("t1")).toEqual([]);
  });

  it("posts as the calling session, tells it what each addressee's state means, and reads the room", async () => {
    const { kit, store, room, receipts } = made();
    const sent = (await kit.call("t1", "room_post", { text: "接口改完了 @mac-app，@you 请看", to: ["ios", "nobody"], reply_to: undefined }));
    expect(sent.isError).toBeUndefined();
    expect(sent.text).toContain("#1 sent in \"重构登录模块\"");
    expect(sent.text).toContain("@mac-app: busy: it gets the message when its current turn ends");
    expect(sent.text).toContain("@ios: idle: it gets the message now");
    expect(sent.text).toContain("@you: the user sees it in the room");
    expect(store.messages(room.id)[0]).toMatchObject({ from: "daemon", to: ["you", "mac-app", "ios"] });
    expect(receipts()).toEqual({ 1: { "mac-app": "queued", ios: "sent" } });
    expect((await kit.call("t1", "room_post", { text: "记一笔" })).text).toContain("addressed to nobody");
    expect((await kit.call("t2", "room_post", { text: "@all hi" })).text).toContain("addressed to nobody");
    expect((await kit.call("t1", "room_nope", {}))).toMatchObject({ isError: true });

    const read = (await kit.call("t2", "room_read", { from: "@daemon", limit: 5 })).text;
    expect(read).toContain("2 of 2 messages from @daemon");
    expect(read).toContain("#1 11-23 20:41 @daemon → @you @mac-app @ios: 接口改完了");
    expect((await kit.call("t2", "room_read", { search: "一笔", after: 1 })).text).toContain('1 of 1 message containing "一笔", after #1');
    expect((await kit.call("t2", "room_read", { seq: 1 })).text).toContain("#1 11-23 20:41 @daemon → @you @mac-app @ios\n接口改完了");

    const members = (await kit.call("t2", "room_members", {})).text;
    expect(members).toContain("4 members");
    expect(members).toContain("@mac-app (you) — Claude Code · Fable 5.2 · /Users/x/proj/mac-app · mode acceptEdits");
    expect(members).toContain("@you — the user");
  });

  it("keeps the room's pinned notes, one text any member replaces, and carries a message's files in its envelope", async () => {
    const { kit, store, delivery, room } = made();
    expect((await kit.call("t1", "room_notes", {})).text).toContain("no pinned notes yet");
    expect((await kit.call("t1", "room_notes", { text: "接口：/login 返回 expiresAt（毫秒）\n" })).text).toContain("are now your text");
    expect(store.get(room.id).notes).toMatchObject({ text: "接口：/login 返回 expiresAt（毫秒）", by: "daemon" });
    expect((await kit.call("t2", "room_notes", {})).text).toContain("last written by @daemon");
    expect((await kit.call("t2", "room_notes", { text: "" })).text).toContain("now empty");
    expect(store.get(room.id).notes).toBeNull();
    expect((await kit.call("t1", "room_post", { text: "@ios 看这个", files: ["/w/api.md", "/w/api.md"] })).isError).toBeUndefined();
    expect(await kit.call("t1", "room_post", { text: "@ios x", files: ["relative.md"] })).toMatchObject({ isError: true });
    expect(store.messages(room.id)[0]!.files).toEqual(["/w/api.md"]);
    expect(delivery.atTurnEnd("t3")).toContain("20:41\nFiles: /w/api.md\n\n@ios 看这个");
  });

  it("gives what the user says naming nobody to the room's admins; with no admin it calls nobody (user #363)", () => {
    const { store, room } = made();
    expect(store.post(room.id, { from: "you", text: "大家看一下" }).to).toEqual([]);
    store.setCanAdd(room.id, "mac-app", true);
    expect(store.post(room.id, { from: "you", text: "大家看一下" }).to).toEqual(["mac-app"]);
    expect(store.post(room.id, { from: "you", text: "@ios 你看" }).to).toEqual(["ios"]);
    expect(store.post(room.id, { from: "daemon", text: "记一笔" }).to).toEqual([]);
  });

  it("asks which room when the session sits in several, and takes that room by its name or id", async () => {
    const { kit, store } = made();
    const other = store.create({ name: "Release" });
    store.seat(other.id, { terminal: "t1", was: { agent: "codex", name: "daemon", cwd: "/w", model: null, profile: null } });
    expect((await kit.call("t1", "room_members", {}))).toMatchObject({ isError: true, text: expect.stringContaining("say which with `room`") });
    expect((await kit.call("t1", "room_members", { room: "release" })).text).toContain("Room \"Release\"");
    expect((await kit.call("t1", "room_members", { room: other.id })).text).toContain("Room \"Release\"");
    expect((await kit.call("t1", "room_members", { room: "nope" }))).toMatchObject({ isError: true });
  });

});

describe("a terminal's own programs", () => {
  it("are known by the terminal's hook token, and get the tools, the calls and the wake", async () => {
    const { kit, delivery, store, room } = made();
    const app = new Hono();
    const host = { get: (id: string) => (id === "c9" ? { harness: "codex" } : null), profileOf: (id: string, token: string) => { if (token !== `tok-${id}`) throw new Error("forbidden"); return { harness: "claude-code", profile: null }; } };
    mountRooms(app, { rooms: store, roomKit: kit, roomDelivery: delivery, roomWatchMs: 30, terminals: { host } } as unknown as ApiDeps);
    const ask = async (id: string, body: unknown, token = `tok-${id}`) => {
      const res = await app.request("/terminals/room", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as any };
    };
    expect((await ask("t1", { op: "tools" }, "wrong")).status).toBe(403);
    expect((await ask("t1", { op: "nope" })).status).toBe(400);
    expect(kit.has("t1")).toBe(false);
    const tools = await ask("t1", { op: "tools" });
    expect(tools.body.tools.map((t: any) => t.name)).toEqual(["room_post", "room_read", "room_tasks", "room_info", "room_update"]);
    expect(kit.has("t1")).toBe(true);
    expect((await ask("t9", { op: "tools" })).body).toEqual({ tools: [], version: "" });
    // Codex lists its tools once, at its start: it has them before it sits anywhere, and a call then says why not.
    expect((await ask("c9", { op: "tools" })).body.tools.map((t: any) => t.name)).toEqual(tools.body.tools.map((t: any) => t.name));
    expect((await ask("c9", { op: "call", name: "room_post", args: { text: "hi" } })).body).toMatchObject({ isError: true, text: expect.stringContaining("sits in no Chat Room") });
    // Unchanged: held its while, then the same; changed: told at once.
    expect((await ask("t1", { op: "watch", version: tools.body.version })).body.version).toBe(tools.body.version);
    expect((await ask("t9", { op: "watch", version: "room_post" })).body.version).toBe("");
    expect((await ask("t1", { op: "call", name: "room_post", args: { text: "@ios 好了" } })).body.text).toContain("#1 sent");
    expect(await ask("t3", { op: "wait" })).toMatchObject({ status: 200, body: { text: expect.stringContaining("@ios 好了") } });
    expect(store.get(room.id).receipts).toEqual({ 1: { ios: "delivered" } });
  });
});

describe("bringing sessions in (Admin)", () => {
  it("makes a room and sits in it, the switch still on, keeping its seat in the first", async () => {
    const { kit, store, room } = org();
    store.setCanAdd(room.id, "daemon", true);
    const made = await kit.call("t1", "room_create", { name: "发布检查", topic: "发版前过一遍" });
    expect(made.text).toContain("Room \"发布检查\"");
    const other = store.list().find((r) => r.name === "发布检查")!;
    expect(other).toMatchObject({ topic: "发版前过一遍", createdBy: "daemon" });
    expect(other.seats.map((s) => [s.handle, s.canAdd])).toEqual([["you", true], ["t1", true]]);
    expect(store.roomsOf("t1").map((s) => s.room.id).sort()).toEqual([room.id, other.id].sort());
  });

  function org() {
    const { store, delivery, room, states } = made();
    const started: unknown[] = [];
    const stopped: string[] = [];
    const seat = (terminal: string): SeatLive | null => (states.has(terminal) ? { state: states.get(terminal)!, card: { agent: terminal.startsWith("new") ? "codex" : "claude-code", name: terminal, cwd: `/w/${terminal}`, model: null, profile: null, mode: terminal === "t3" ? "bypassPermissions" : "default", node: null } } : null);
    const kit = new RoomKit({
      store, seat, delivery, now: () => 10 * 3_600_000, kitWaitMs: 0,
      org: () => ({
        profiles: async () => [{ agent: "claude-code", id: "default", name: "Default", kind: "subscription", health: { status: "healthy", checkedAt: 8 * 3_600_000, message: "" } }, { agent: "codex", id: "abc123", name: "Work", kind: "api", health: null }],
        models: async () => ({ "claude-code": [{ id: "opus", name: "Opus", description: "Opus 5.5" }], pi: [] }),
        sessions: async () => ({ running: [{ terminal: "t1", agent: "claude-code", name: "daemon", cwd: "/w/d", state: "idle", profile: null }, { terminal: "t8", agent: "codex", name: "spare", cwd: "/w/s", state: "idle", profile: "Work" }], resumable: [{ agent: "codex", id: "sess-1", title: "fix login", cwd: "/w/l", updatedAt: 9 * 3_600_000, profile: null }] }),
        check: async (agent, profile) => ({ status: "unhealthy", checkedAt: 1, message: `${agent}/${profile} signed out` }),
        start: async (req) => { started.push(req); const id = `new${started.length}`; states.set(id, "idle"); return id; },
        stop: async (t) => { stopped.push(t); return true; },
        rename: async () => undefined,
        resume: async (terminal) => { const id = `back-${terminal}`; states.set(id, "idle"); return { id }; },
      }),
    });
    return { kit, store, room, states, started, stopped };
  }

  it("makes a room with its members at once (拉群), and dissolves it: the sessions started for it end, the others go on", async () => {
    const { kit, store, room, states, stopped } = org();
    store.setCanAdd(room.id, "daemon", true);
    states.set("t8", "idle");
    const made = await kit.call("t1", "room_admin", { action: "create", name: "登录重构", terminals: ["t8", "nope", "t1"] });
    expect(made.text).toContain("@t8 now sits in");
    expect(made.text).toContain("nope: not brought in");
    const other = store.list().find((r) => r.name === "登录重构")!;
    expect(other.seats.map((s) => s.handle)).toEqual(["you", "t1", "t8"]);
    expect((await kit.call("t1", "room_admin", { action: "add", room: other.id, agent: "codex", cwd: "/w/x" })).text).toContain("@new1 now sits in");
    const gone = await kit.call("t1", "room_admin", { action: "dissolve", room: other.id });
    expect(gone.text).toContain("is dissolved");
    expect(stopped).toEqual(["new1"]);
    expect(store.list().some((r) => r.id === other.id)).toBe(false);
    expect(states.get("t8")).toBe("idle");
    // The desk is not dissolved, by an admin or the user.
    const desk = store.create({ name: "调度台", desk: true });
    expect(() => store.remove(desk.id)).toThrow("调度台不能解散");
  });

  it("has the organizing tools only with the switch on, and refuses a call the moment it is off", async () => {
    const { kit, store, room } = org();
    expect(kit.tools("t1").map((t) => t.name)).toEqual(["room_post", "room_read", "room_tasks", "room_info", "room_update"]);
    expect(await kit.call("t1", "profiles", {})).toMatchObject({ isError: true, text: expect.stringContaining("is not an admin of the room") });
    store.setCanAdd(room.id, "daemon", true);
    expect(kit.tools("t1").map((t) => t.name)).toEqual(["room_post", "room_read", "room_tasks", "room_info", "room_update", "room_admin"]);
    expect((await kit.call("t1", "profiles", {})).text).toBe("2 profiles:\nclaude-code · default · \"Default\" · subscription · healthy, checked 2 h ago\ncodex · abc123 · \"Work\" · API key · not checked yet");
    expect((await kit.call("t1", "models", { agent: "claude-code" })).text).toBe("claude-code:\n  opus — Opus · Opus 5.5");
    const sessions = (await kit.call("t1", "sessions", {})).text;
    expect(sessions).toContain("t1 · claude-code · \"daemon\" · /w/d · idle · (you)");
    expect(sessions).toContain("codex · sess-1 · \"fix login\" · /w/l · 1 h ago");
    expect((await kit.call("t1", "profile_check", { agent: "codex", profile: "abc123" })).text).toContain("unhealthy — codex/abc123 signed out");
    expect((await kit.call("t1", "rooms", {})).text).toContain("\"重构登录模块\"");
    store.setCanAdd(room.id, "daemon", false);
    expect(await kit.call("t1", "room_add", { agent: "codex", cwd: "/w" })).toMatchObject({ isError: true });
  });

  it("seats a running session, starts new ones one level deep and four at most, in bypass unless told otherwise", async () => {
    const { kit, store, room, states, started } = org();
    store.setCanAdd(room.id, "daemon", true);
    states.set("t8", "idle");
    expect((await kit.call("t1", "room_add", { terminal: "t8" })).text).toContain("@t8 now sits in");
    expect(store.get(room.id).seats.find((s) => s.handle === "t8")).toMatchObject({ addedBy: "daemon", byAgent: false, canAdd: false });
    expect(await kit.call("t1", "room_add", { terminal: "t1" })).toMatchObject({ isError: true });
    expect(await kit.call("t1", "room_add", { terminal: "nope" })).toMatchObject({ isError: true });
    const added = await kit.call("t1", "room_add", { agent: "codex", cwd: "/w/x", model: "gpt", resume: "sess-1" });
    expect(added.text).toContain("@new1 now sits in");
    // Resumed or new, a session started for a room runs in bypass unless the caller gives a mode.
    expect(started).toEqual([{ agent: "codex", cwd: "/w/x", model: "gpt", mode: "bypass", resume: "sess-1" }]);
    const child = store.get(room.id).seats.find((s) => s.handle === "new1")!;
    expect(child).toMatchObject({ byAgent: true, starter: "t1", canAdd: false, addedBy: "daemon" });
    // One level: the session it started has no organizing tools, and its switch can not be turned on.
    expect(kit.tools("new1").map((t) => t.name)).toEqual(["room_post", "room_read", "room_tasks", "room_info", "room_update"]);
    expect(() => store.setCanAdd(room.id, "new1", true)).toThrow();
    for (let i = 0; i < 3; i++) expect((await kit.call("t1", "room_add", { agent: "codex", cwd: "/w" })).isError).toBeUndefined();
    expect(await kit.call("t1", "room_add", { agent: "codex", cwd: "/w" })).toMatchObject({ isError: true, text: expect.stringContaining("the most you may") });
    // A mode given is kept; bypass needs no bypass of the caller's own.
    store.setCanAdd(room.id, "ios", true);
    expect((await kit.call("t3", "room_add", { agent: "codex", cwd: "/w", mode: "manual" })).isError).toBeUndefined();
    expect(started.at(-1)).toMatchObject({ mode: "manual" });
  });
});
