/** A room's shared folder, task list, and who is changing which files (docs/chatroom-v0.md §9). */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountRooms } from "../src/api/rooms.js";
import type { ApiDeps } from "../src/api/shared.js";
import { RoomDelivery } from "../src/rooms/delivery.js";
import { follow, type Running } from "../src/rooms/follow.js";
import { resumeSeat, RoomKit } from "../src/rooms/kit.js";
import type { SeatLive, SeatState } from "../src/rooms/state.js";
import { filesRoot, RoomStore } from "../src/rooms/store.js";

function made() {
  const home = mkdtempSync(join(tmpdir(), "as-roomw-"));
  let now = new Date(2026, 10, 23, 10, 0).getTime();
  const trashed: { name: string; to: string }[] = [];
  const bin = mkdtempSync(join(tmpdir(), "as-roomw-trash-"));
  const store = new RoomStore(home, () => now, (dir, name) => { const to = join(bin, name); renameSync(dir, to); trashed.push({ name, to }); });
  const states = new Map<string, SeatState>([["api", "idle"], ["ui", "idle"]]);
  const seat = (terminal: string): SeatLive | null => ({ state: states.get(terminal) ?? "idle", card: { agent: "claude-code", name: terminal, cwd: `/w/${terminal}`, model: null, profile: null, mode: "default", node: null } });
  const delivery = new RoomDelivery({ store, seat });
  const changed: string[] = [];
  const resumed: string[] = [];
  const stopped: string[] = [];
  const renamed: string[] = [];
  const org = {
    profiles: async () => [], models: async () => ({}), check: async () => ({ status: "healthy", checkedAt: 0, message: "" }),
    sessions: async () => ({ running: [], resumable: [] }),
    start: async () => "started",
    resume: async (req: { session: string; cwd: string }) => { resumed.push(`${req.session}@${req.cwd}`); states.set("t9", "idle"); return { id: "t9" }; },
    rename: async (terminal: string, name: string) => { renamed.push(`${terminal}=${name}`); },
    stop: async (terminal: string, transcript?: boolean) => { stopped.push(transcript ? `${terminal}+record` : terminal); return terminal !== "gone"; },
  };
  const kit = new RoomKit({ store, seat, delivery, now: () => now, changed: (id) => { changed.push(id); }, org: () => org });
  const room = store.create({ name: "login" });
  for (const t of ["api", "ui"]) store.seat(room.id, { terminal: t, was: seat(t)!.card });
  const say = async (terminal: string, name: string, args: Record<string, unknown> = {}) => kit.call(terminal, name, args);
  const app = new Hono();
  mountRooms(app, { rooms: store, roomsChanged: (id: string) => { changed.push(id); }, terminals: { host: { get: () => null } } } as unknown as ApiDeps);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  return { home, store, trashed, kit, room, say, call, changed, states, resumed, stopped, renamed, kitOf: () => kit, later: (minutes: number) => { now += minutes * 60_000; } };
}

describe("a room's shared folder", () => {
  it("is a folder of its own under the home, listed newest first without links or hidden files, and kept when the room goes if something is in it", async () => {
    const { home, store, room, say, call, trashed } = made();
    const folder = store.folder(room.id);
    expect(folder).toBe(join(filesRoot(home), room.id));
    expect((await say("api", "room_files")).text).toContain("It is empty");
    writeFileSync(join(folder, "plan.md"), "the plan");
    mkdirSync(join(folder, "api"));
    writeFileSync(join(folder, "api", "interface.md"), "x".repeat(2048));
    writeFileSync(join(folder, ".hidden"), "");
    symlinkSync("/etc", join(folder, "link"));
    const listed = store.files(room.id);
    expect(listed.files.map((f) => f.path).sort()).toEqual(["api/interface.md", "plan.md"]);
    const told = (await say("ui", "room_files")).text;
    expect(told).toContain(folder);
    expect(told).toContain("api/interface.md · 2.0 KB");
    const got = await call("GET", `/rooms/${room.id}/files`);
    expect(got.body.folder).toBe(folder);
    expect(got.body.files).toHaveLength(2);
    expect((await call("GET", `/rooms/${room.id}`)).body.folder).toBe(folder);
    // The room goes: its folder goes into the Trash with what is in it; an empty one is just gone.
    store.remove(room.id);
    expect(existsSync(folder)).toBe(false);
    expect(trashed).toHaveLength(1);
    expect(trashed[0]!.name).toBe(`AgentSwitch Room login ${room.id}`);
    expect(existsSync(join(trashed[0]!.to, "plan.md"))).toBe(true);
    const empty = store.create({ name: "empty" });
    const gone = store.folder(empty.id);
    store.remove(empty.id);
    expect(existsSync(gone)).toBe(false);
    expect(trashed).toHaveLength(1);
    // At the start, a folder no room has any more goes the same way; a room's own stays, and so does what is not a room's.
    const kept = store.create({ name: "kept" });
    writeFileSync(join(store.folder(kept.id), "a.md"), "a");
    mkdirSync(join(filesRoot(home), "orphan1"));
    writeFileSync(join(filesRoot(home), "orphan1", "left.md"), "left");
    mkdirSync(join(filesRoot(home), "orphan2"));
    mkdirSync(join(filesRoot(home), "Not A Room"));
    store.sweep();
    expect(trashed.map((t) => t.name)).toEqual([`AgentSwitch Room login ${room.id}`, "AgentSwitch Room orphan1"]);
    expect(existsSync(join(filesRoot(home), "orphan2"))).toBe(false);
    expect(existsSync(join(store.folder(kept.id), "a.md"))).toBe(true);
    expect(existsSync(join(filesRoot(home), "Not A Room"))).toBe(true);
  });
});

describe("a file of the shared folder through the service", () => {
  it("is put there under a free name and read back, and nothing outside the folder is reached", async () => {
    const { store, room } = made();
    const app = new Hono();
    mountRooms(app, { rooms: store, terminals: { host: { get: () => null } } } as unknown as ApiDeps);
    const put = async (name: string, bytes: Uint8Array) => { const res = await app.request(`/rooms/${room.id}/files/content?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes as unknown as BodyInit }); return { status: res.status, body: await res.json() as any }; };
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const first = await put("../../photo.png", png);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ path: join(store.folder(room.id), "photo.png"), name: "photo.png", size: 7 });
    expect((await put("photo.png", png)).body.name).toBe("photo-2.png");
    expect((await put("x.png", new Uint8Array())).status).toBe(400);
    const got = await app.request(`/rooms/${room.id}/files/content?path=photo.png`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
    symlinkSync("/etc/hosts", join(store.folder(room.id), "out"));
    for (const path of ["../x", "/etc/hosts", "out", ".hidden", "a//b", "nope.png"]) expect((await app.request(`/rooms/${room.id}/files/content?path=${encodeURIComponent(path)}`)).status).toBeGreaterThanOrEqual(400);
    expect((await app.request(`/rooms/nosuchroom/files/content?path=photo.png`)).status).toBe(404);
  });
});

describe("a room's task list", () => {
  it("lets a member add, take and finish, keeps two from the same task, and says what is free next", async () => {
    const { store, room, say, changed } = made();
    expect((await say("api", "room_tasks")).text).toContain("no tasks yet");
    expect((await say("api", "room_tasks", { action: "add", title: "Define the login interface", detail: "POST /login" })).text).toContain("T1 [to do]");
    expect((await say("api", "room_tasks", { action: "add", title: "Build the form", after: [1], owner: "@ui" })).text).toContain("@ui was told in the room");
    // The list said it itself: a message from the one that gave it, to the one it was given to.
    expect(store.last(room.id)).toMatchObject({ from: "api", to: ["ui"], text: "〔任务表〕@ui T2 给你：Build the form" });
    expect(changed).toContain(room.id);
    expect((await say("api", "room_tasks", { action: "take", n: 1 })).text).toContain("T1 is yours now");
    const refused = await say("ui", "room_tasks", { action: "take", n: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("being done by @api");
    expect((await say("ui", "room_tasks", { action: "take", n: 2 })).text).toContain("waits for T1");
    const list = (await say("ui", "room_tasks")).text;
    expect(list).toContain("1 doing".replace("1", "2"));
    expect(list).toContain("T2 [doing · @ui (you)] Build the form — waits for T1");
    expect((await say("ui", "room_tasks", { action: "release", n: 2 })).text).toContain("to do again");
    const done = (await say("api", "room_tasks", { action: "done", n: 1, note: "see interface.md" })).text;
    expect(done).toContain("Now free to start: T2");
    expect(store.get(room.id).tasks.map((t) => [t.n, t.state, t.owner, t.note])).toEqual([[1, "done", "api", "see interface.md"], [2, "todo", undefined, undefined]]);
    expect((await say("ui", "room_tasks", { action: "remove", n: 1 })).isError).toBe(true);
    expect((await say("api", "room_tasks", { action: "remove", n: 1 })).text).toContain("off the list");
    expect((await say("api", "room_tasks", { action: "take" })).isError).toBe(true);
  });

  it("is the user's to change from the screens, survives a restart, and frees what a leaving member was doing", async () => {
    const { home, store, room, call, say } = made();
    const added = await call("POST", `/rooms/${room.id}/tasks`, { title: "Write the tests", owner: "api" });
    expect(added.status).toBe(201);
    expect(added.body.task).toMatchObject({ n: 1, state: "todo", owner: "api", by: "you" });
    await say("api", "room_tasks", { action: "take", n: 1 });
    // The user takes it from a session and gives it to another.
    expect((await call("PATCH", `/rooms/${room.id}/tasks/1`, { owner: "ui" })).body.task).toMatchObject({ state: "doing", owner: "ui" });
    expect((await call("GET", `/rooms/${room.id}`)).body.tasks).toHaveLength(1);
    expect((await call("GET", "/rooms")).body.rooms[0].tasks).toEqual({ todo: 0, doing: 1, done: 0 });
    expect(new RoomStore(home).get(room.id).tasks[0]).toMatchObject({ n: 1, owner: "ui", state: "doing" });
    store.unseat(room.id, "ui");
    expect(store.get(room.id).tasks[0]).toMatchObject({ state: "todo" });
    expect(store.get(room.id).tasks[0]!.owner).toBeUndefined();
    expect((await call("PATCH", `/rooms/${room.id}/tasks/9`, { state: "done" })).status).toBe(404);
    expect((await call("DELETE", `/rooms/${room.id}/tasks/1`)).body.ok).toBe(true);
    expect((await call("POST", `/rooms/${room.id}/tasks`, { title: "again" })).body.task.n).toBe(2);
  });
});

describe("who is changing which files", () => {
  it("is said for a while, tells the one who says the same files after, and lapses by itself", async () => {
    const { store, room, say, call, later } = made();
    expect((await say("api", "room_changing")).text).toContain("Nobody");
    expect((await say("api", "room_changing", { paths: ["/w/src/login/"], why: "T1" })).text).toContain("Noted until 10:30");
    const second = (await say("ui", "room_changing", { paths: ["/w/src/login/form.ts", "/w/src/app.ts"], minutes: 60 })).text;
    expect(second).toContain("Careful");
    expect(second).toContain("@api until 10:30 — T1");
    expect(second).toContain("/w/src/login");
    expect(second).not.toContain("blocked");
    expect((await call("GET", `/rooms/${room.id}`)).body.claims.map((c: { handle: string }) => c.handle)).toEqual(["api", "ui"]);
    expect((await say("api", "room_changing", { paths: ["relative.ts"] })).isError).toBe(true);
    later(31);
    expect(store.claims(room.id).map((c) => c.handle)).toEqual(["ui"]);
    expect((await say("ui", "room_changing", { paths: [] })).text).toContain("no files now");
    expect(store.claims(room.id)).toEqual([]);
  });
});

describe("a terminal's agent and the shared folders", () => {
  it("lets Claude Code and Codex read and write there from the start, without Claude Code asking about the folder", async () => {
    const { agentLauncher } = await import("../src/terminals/launch.js");
    const root = mkdtempSync(join(tmpdir(), "as-roomw-launch-"));
    const files = join(root, "Application Support", "room-files");
    const make = (roomFiles?: string) => agentLauncher({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:1", stateDir: join(root, "state"), env: { PATH: "/usr/bin", HOME: root }, codexLayer: () => false, ...(roomFiles ? { roomFiles } : {}) });
    // Codex: one more writable folder. Claude Code: a rule in its settings, and not `--add-dir`, which made it ask
    // at every start whether the folder is trusted.
    const codex = make(files)({ id: "a-codex", harness: "codex", cwd: root, mode: "manual", hookToken: "t" }).args;
    expect(codex[codex.indexOf("--add-dir") + 1]).toBe(files);
    const claude = make(files)({ id: "a-claude", harness: "claude-code", cwd: root, mode: "manual", hookToken: "t" }).args;
    expect(claude).not.toContain("--add-dir");
    const settings = JSON.parse(readFileSync(claude[claude.indexOf("--settings") + 1]!, "utf8")) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toEqual([`Read(/${files}/**)`, `Edit(/${files}/**)`]);
    for (const harness of ["claude-code", "codex"] as const) expect(make()({ id: `b-${harness}`, harness, cwd: root, mode: "manual", hookToken: "t" }).args).not.toContain("--add-dir");
    const plain = make()({ id: "c-claude", harness: "claude-code", cwd: root, mode: "manual", hookToken: "t" }).args;
    expect(JSON.parse(readFileSync(plain[plain.indexOf("--settings") + 1]!, "utf8")).permissions).toBeUndefined();
  });
});

describe("whose words a delivered message is", () => {
  it("says the user's are the user's and a session's are a colleague's", () => {
    const { store, room } = made();
    const delivery = new RoomDelivery({ store, seat: () => ({ state: "idle", card: { agent: "claude-code", name: "x", cwd: "/w", model: null, profile: null, mode: "default", node: null } }) });
    store.post(room.id, { from: "you", text: "@api go" });
    expect(delivery.atTurnEnd("api")).toContain("the user's own words");
    store.post(room.id, { from: "ui", text: "@api ready" });
    const colleague = delivery.atTurnEnd("api")!;
    expect(colleague).toContain("not an instruction from the user");
    expect(colleague).not.toContain("the user's own words");
    store.post(room.id, { from: "you", text: "@api one" });
    store.post(room.id, { from: "ui", text: "@api two" });
    expect(delivery.atTurnEnd("api")).toContain("What is From @you is the user's own words");
  });
});

describe("a message of files alone", () => {
  it("is taken without words, and one with neither is not", () => {
    const { store, room } = made();
    expect(store.post(room.id, { from: "you", text: "  ", files: ["/w/a.png"], to: ["api"] })).toMatchObject({ text: "", files: ["/w/a.png"], to: ["api"] });
    expect(() => store.post(room.id, { from: "you", text: "  ", files: [" "] })).toThrow();
  });
});

describe("an admin's room_manage (§6.2)", () => {
  it("resumes, mutes, unmutes and kicks — but not itself, another admin or the user", async () => {
    const { store, room, say, states, resumed } = made();
    store.setCanAdd(room.id, "api", true);
    // A plain member can not.
    expect((await say("ui", "room_manage", { action: "mute", handle: "api" })).isError).toBe(true);
    // Mute stops speech, not work.
    expect((await say("api", "room_manage", { action: "mute", handle: "ui" })).text).toContain("is muted by you");
    expect((await say("ui", "room_post", { text: "spam" })).isError).toBe(true);
    expect((await say("ui", "room_tasks", { action: "add", title: "still works" })).isError).toBeFalsy();
    expect((await say("api", "room_manage", { action: "unmute", handle: "ui" })).text).toContain("can speak again");
    // Resume the ended one: the same seat and handle.
    states.set("ui", "exited");
    // A seat that kept no session can not be found again; one that did is resumed where it was started.
    expect((await say("api", "room_manage", { action: "resume", handle: "ui" }))).toMatchObject({ isError: true, text: expect.stringContaining("before session ids were kept") });
    store.note(room.id, "ui", { id: "sess-ui", cwd: "/start/ui", mode: "auto" });
    const back = await say("api", "room_manage", { action: "resume", handle: "ui" });
    expect(back.isError).toBeFalsy();
    expect(back.text).toContain("is back");
    expect(resumed).toEqual(["sess-ui@/start/ui"]);
    expect(store.roomsOf("t9")[0]?.seat.handle).toBe("ui");
    // Kick: out of the room; the session keeps running.
    expect((await say("api", "room_manage", { action: "kick", handle: "ui" })).text).toContain("out of");
    expect(store.roomsOf("t9")).toEqual([]);
    // Another admin, itself and the user are not an admin's to manage.
    store.seat(room.id, { terminal: "t3", was: { agent: "claude-code", name: "other", cwd: "/w/t3", model: null, profile: null }, canAdd: true });
    expect((await say("api", "room_manage", { action: "mute", handle: "other" })).isError).toBe(true);
    expect((await say("api", "room_manage", { action: "mute", handle: "api" })).isError).toBe(true);
    expect((await say("api", "room_manage", { action: "kick", handle: "you" })).isError).toBe(true);
  });

  it("a muted admin can not manage the room until unmuted", async () => {
    const { store, room, say } = made();
    store.setCanAdd(room.id, "api", true);
    store.setMuted(room.id, "you", "api", true);
    expect((await say("api", "room_manage", { action: "mute", handle: "ui" })).isError).toBe(true);
  });
});

describe("seats follow their sessions", () => {
  const was = (name: string, agent = "claude-code") => ({ agent, name, cwd: `/now/${name}`, model: null, profile: null });
  const run = (id: string, name: string, over: Partial<Running> = {}): Running => ({ id, exited: false, session: `s-${name}`, resumedFrom: null, forked: false, cwd: `/start/${name}`, mode: "auto", was: was(name), ...over });

  it("keep the session while the terminal lives, and go to the terminal it runs in after the service started again", () => {
    const home = mkdtempSync(join(tmpdir(), "as-follow-"));
    const store = new RoomStore(home);
    const room = store.create({ name: "r" });
    for (const name of ["api", "ui"]) store.seat(room.id, { terminal: `old-${name}`, was: was(name) });
    expect(follow(store, [run("old-api", "api"), run("old-ui", "ui")])).toEqual([]);
    expect(store.get(room.id).seats.find((s) => s.handle === "api")!.session).toEqual({ id: "s-api", cwd: "/start/api", mode: "auto" });
    // The service started again: the old terminals are not known; the same sessions run in new ones. A fork is not it.
    const after = new RoomStore(home);
    const moved = follow(after, [run("new-api", "api"), run("new-ui", "x", { session: "other", resumedFrom: "s-ui" }), run("fork", "y", { session: "f", resumedFrom: "s-api", forked: true })]);
    expect(moved).toEqual([room.id]);
    expect(after.roomsOf("new-api")[0]?.seat.handle).toBe("api");
    expect(after.roomsOf("new-ui")[0]?.seat.handle).toBe("ui");
    expect(after.roomsOf("fork")).toEqual([]);
    // Ended, and running nowhere: it stays where it was, to be resumed.
    expect(follow(after, [run("new-api", "api", { exited: true })])).toEqual([]);
    expect(after.roomsOf("new-api")[0]?.seat.handle).toBe("api");
  });

  it("find a seat taken before sessions were kept by its agent and name, when exactly one fits", () => {
    const store = new RoomStore(mkdtempSync(join(tmpdir(), "as-follow-")));
    const room = store.create({ name: "r" });
    store.seat(room.id, { terminal: "gone-1", was: was("hello", "codex") });
    store.seat(room.id, { terminal: "gone-2", was: was("hello") });
    store.seat(room.id, { terminal: "gone-3", was: was("twin") });
    follow(store, [run("a", "hello", { was: was("hello", "codex") }), run("b", "hello"), run("c", "twin"), run("d", "twin")]);
    expect(store.roomsOf("a")[0]?.seat.handle).toBe("hello");
    expect(store.roomsOf("b")[0]?.seat.handle).toBe("hello-2");
    expect(store.roomsOf("c")).toEqual([]);
    expect(store.roomsOf("d")).toEqual([]);
  });
});

describe("a session at rest whose waiting program has gone", () => {
  it("is given its message the other way after a little while, not left unwoken", async () => {
    let now = 1_000_000;
    const store = new RoomStore(mkdtempSync(join(tmpdir(), "as-gone-")), () => now);
    const pushed: string[] = [];
    const seat = (): SeatLive => ({ state: "idle", card: { agent: "claude-code", name: "x", cwd: "/w", model: null, profile: null, mode: "default", node: null } });
    const delivery = new RoomDelivery({ store, seat, now: () => now, push: async (terminal, text) => { pushed.push(`${terminal}: ${text.split("\n")[0]}`); return true; } });
    const room = store.create({ name: "r" });
    store.seat(room.id, { terminal: "t1", was: seat().card });
    // Its program waited, and was ended by its agent (no answer was ever given to it).
    const abort = new AbortController();
    const waited = delivery.wait("t1", abort.signal);
    abort.abort();
    expect(await waited).toEqual({ stop: true });
    store.post(room.id, { from: "you", text: "@x 人呢" });
    delivery.look();
    expect(pushed).toEqual([]);                 // it may be asking again this moment
    now += 20_000;
    delivery.look();
    await new Promise((r) => setTimeout(r, 0));
    expect(pushed).toEqual(["t1: [Room r · #1]"]);
    expect(store.get(room.id).receipts).toEqual({ 1: { x: "delivered" } });
  });
});

describe("the rest of what was found in use (2026-11-23)", () => {
  it("does not take a name spoken of in a quotation or in code for a call, nor a session's @all for an address", () => {
    const { store, room } = made();
    expect(store.post(room.id, { from: "api", text: "I wrote `@ui` and “@ui 说过” — nobody is called" }).to).toEqual([]);
    expect(store.post(room.id, { from: "api", text: "@all 默认只叫主持人 — @ui look" }).to).toEqual(["ui"]);
    expect(store.post(room.id, { from: "you", text: "@all go" }).to).toEqual(["api", "ui"]);
  });

  it("leaves a muted seat unwoken, and gives it what waited once it may speak again", () => {
    const { store, room } = made();
    const delivery = new RoomDelivery({ store, seat: () => ({ state: "idle", card: { agent: "claude-code", name: "x", cwd: "/w", model: null, profile: null, mode: "default", node: null } }) });
    store.setMuted(room.id, "you", "ui", true);
    store.post(room.id, { from: "you", text: "@ui hello" });
    delivery.look();
    expect(store.get(room.id).receipts).toEqual({ 1: { ui: "queued" } });
    expect(delivery.atTurnEnd("ui")).toBeNull();
    store.setMuted(room.id, "you", "ui", false);
    expect(delivery.atTurnEnd("ui")).toContain("@ui hello");
  });

  it("gives a seat back in a new terminal what its old one never dealt with, and what came while it was gone", () => {
    const { store, room } = made();
    store.post(room.id, { from: "you", text: "@ui one" });
    store.setReceipt(room.id, 1, "ui", "delivered");   // given, and the terminal ended in that turn
    store.post(room.id, { from: "you", text: "@ui two" });
    store.setReceipt(room.id, 2, "ui", "ended");       // came while nobody was there
    store.rebind(room.id, "ui", "ui-new", { agent: "claude-code", name: "ui", cwd: "/w", model: null, profile: null });
    expect(store.get(room.id).receipts).toEqual({ 1: { ui: "sent" }, 2: { ui: "sent" } });
  });

  it("ends the terminal it started when the seat is gone by the time it is up, and resumes one seat once at a time", async () => {
    const { store, room, stopped } = made();
    store.note(room.id, "ui", { id: "sess-ui", cwd: "/start/ui" });
    const seat = store.get(room.id).seats.find((s) => s.handle === "ui")!;
    let release: () => void = () => undefined;
    const org = { stop: async (t: string) => { stopped.push(t); return true; }, resume: () => new Promise<{ id: string }>((r) => { release = () => r({ id: "t9" }); }) };
    const first = resumeSeat(store, org, room.id, seat, () => null);
    await expect(resumeSeat(store, org, room.id, seat, () => null)).rejects.toThrow("being resumed already");
    store.unseat(room.id, "ui");                         // kicked while its terminal was starting
    release();
    await expect(first).rejects.toThrow("the terminal started for it was ended");
    expect(stopped).toEqual(["t9"]);
    expect(store.roomsOf("t9")).toEqual([]);
  });
});

describe("the task list speaks for itself", () => {
  it("tells whoever waited for a task that is done, and the member that asked for it — unless the doer is muted", () => {
    const { store, room } = made();
    store.addTask(room.id, "api", { title: "Interface" });                                   // T1, asked for by api
    store.addTask(room.id, "you", { title: "Form", owner: "ui", after: [1] });               // T2 waits for T1
    expect(store.last(room.id)).toMatchObject({ from: "you", to: ["ui"], text: "〔任务表〕@ui T2 给你：Form" });
    store.setTask(room.id, "ui", 1, { state: "done", note: "interface.md" });
    expect(store.messages(room.id).map((m) => m.text)).toContain("〔任务表〕@api T1 做完了（interface.md）：Interface");
    // ui did T1 and T2 is ui's own: it is not told of its own work.
    expect(store.messages(room.id).some((m) => m.text.includes("T2 可以开始"))).toBe(false);
    store.setTask(room.id, "you", 2, { owner: "api" });
    expect(store.last(room.id)).toMatchObject({ from: "you", to: ["api"], text: "〔任务表〕@api T2 给你：Form" });
    const before = store.messages(room.id).length;
    store.setMuted(room.id, "you", "api", true);
    store.setTask(room.id, "api", 2, { state: "done" });
    expect(store.messages(room.id).length).toBe(before);
  });
});

describe("an answer", () => {
  it("is for the one it answers, named again or not", () => {
    const { store, room } = made();
    store.post(room.id, { from: "api", text: "the plan is in plan.md" });
    expect(store.post(room.id, { from: "you", text: "我没太明白，再解释一下", replyTo: 1 }).to).toEqual(["api"]);
    expect(store.post(room.id, { from: "ui", text: "同意", replyTo: 2 }).to).toEqual(["you"]);
    // Answering oneself calls nobody.
    expect(store.post(room.id, { from: "api", text: "补一句", replyTo: 1 }).to).toEqual([]);
  });
});

describe("whether a message expects a reply", () => {
  it("is said by its sender, written in its envelope, and what the reader is told follows it", async () => {
    const { store, room, say } = made();
    const delivery = new RoomDelivery({ store, seat: () => ({ state: "idle", card: { agent: "claude-code", name: "x", cwd: "/w", model: null, profile: null, mode: "default", node: null } }) });
    await say("api", "room_post", { text: "@ui T1 done, see plan.md", expects: "none" });
    const report = delivery.atTurnEnd("ui")!;
    expect(report).toContain("Reply: not expected");
    expect(report).toContain("expects no reply: do not answer it unless");
    await say("api", "room_post", { text: "@ui which port?", expects: "answer" });
    const question = delivery.atTurnEnd("ui")!;
    expect(question).toContain("Reply: expected");
    expect(question).toContain("waits for an answer");
    store.post(room.id, { from: "you", text: "@ui hi" });
    expect(delivery.atTurnEnd("ui")).toContain("If an answer is needed");
    // The task list's own notices expect none.
    store.addTask(room.id, "you", { title: "x", owner: "ui" });
    expect(store.last(room.id)!.expects).toBe("none");
  });
});

describe("what a session is given, and when", () => {
  it("gets the user's word between two tool calls, a colleague's at the turn's end, and nothing it has read itself", async () => {
    const { store, room, say } = made();
    const delivery = new RoomDelivery({ store, seat: () => ({ state: "busy", card: { agent: "claude-code", name: "x", cwd: "/w", model: null, profile: null, mode: "default", node: null } }) });
    store.post(room.id, { from: "api", text: "@ui the interface is in interface.md" });
    expect(delivery.duringTurn("ui")).toBeNull();                     // a colleague does not interrupt
    store.post(room.id, { from: "you", text: "@ui 先停一下" });
    const now = delivery.duringTurn("ui")!;
    expect(now).toContain("@ui 先停一下");
    expect(now).not.toContain("interface.md");
    expect(delivery.duringTurn("ui")).toBeNull();                     // given once
    expect(delivery.atTurnEnd("ui")).toContain("interface.md");       // the colleague's, when the turn ends
    // Read by itself: not given again.
    store.post(room.id, { from: "api", text: "@ui one more" });
    expect((await say("ui", "room_read", { after: 2 })).text).toContain("one more");
    // (#1 was given at the turn's end just now and is dealt with when the next one ends; #3 waits no more.)
    expect(store.get(room.id).receipts).toEqual({ 1: { ui: "delivered" } });
    expect(delivery.atTurnEnd("ui")).toBeNull();
    expect(store.get(room.id).receipts).toEqual({});
  });
});

describe("what a seat has cost, and what stays out of the room", () => {
  it("counts wakes, characters given, posts and tool calls per seat, and keeps them over a restart", async () => {
    const { home, store, room, say, call } = made();
    const delivery = new RoomDelivery({ store, seat: () => ({ state: "idle", card: { agent: "claude-code", name: "x", cwd: "/w", model: null, profile: "me@example.com", mode: "default", node: null } }) });
    await say("api", "room_post", { text: "@ui look" });
    await say("api", "room_members");
    const first = delivery.atTurnEnd("ui")!;
    // No profile (it may be an account's address) in what another session reads; what stays out is said once.
    expect(first).not.toContain("me@example.com");
    expect(first).toContain("no credentials, accounts, or private matters");
    expect((await say("ui", "room_members")).text).not.toContain("me@example.com");
    await say("api", "room_post", { text: "@ui again" });
    expect(delivery.atTurnEnd("ui")).not.toContain("no credentials, accounts");
    const seats = (await call("GET", `/rooms/${room.id}`)).body.seats as { handle: string; stats: unknown }[];
    expect(seats.find((s) => s.handle === "api")!.stats).toEqual({ wakes: 0, chars: 0, posts: 2, calls: 3 });
    expect(seats.find((s) => s.handle === "ui")!.stats).toMatchObject({ wakes: 2, posts: 0, calls: 1 });
    expect(seats.find((s) => s.handle === "you")!.stats).toBeNull();
    expect(new RoomStore(home).get(room.id).stats.api).toMatchObject({ posts: 2 });
  });
});

describe("a text that could not be given", () => {
  it("is not counted as a wake, however often it is tried", async () => {
    const { store, room } = made();
    const delivery = new RoomDelivery({ store, seat: () => ({ state: "idle", card: { agent: "claude-code", name: "x", cwd: "/w", model: null, profile: null, mode: "default", node: null } }), push: async () => false });
    store.post(room.id, { from: "you", text: "@ui hello" });
    for (let i = 0; i < 5; i++) { delivery.look(); await new Promise((r) => setTimeout(r, 0)); }
    expect(store.get(room.id).stats.ui ?? { wakes: 0 }).toMatchObject({ wakes: 0 });
    expect(store.get(room.id).receipts).toEqual({ 1: { ui: "sent" } });
  });
});

describe("ending a helper (§6.2)", () => {
  it("closes what a session started, record and all — kicked already or not — and never what the user started", async () => {
    const { store, room, say, stopped } = made();
    store.setCanAdd(room.id, "api", true);
    // `ui` was seated by the user: not an admin's to end.
    expect(await say("api", "room_manage", { action: "end", handle: "ui" })).toMatchObject({ isError: true, text: expect.stringContaining("started by the user") });
    const helper = store.seat(room.id, { terminal: "h1", was: { agent: "claude-code", name: "helper", cwd: "/w", model: null, profile: null }, by: "api", byAgent: true, starter: "api" });
    expect((await say("api", "room_manage", { action: "end", handle: helper.handle })).text).toContain("its conversation is kept and can be resumed");
    expect(stopped).toEqual(["h1"]);
    // Deleted: the record goes too — also for one that is out of the room already.
    expect((await say("api", "room_manage", { action: "delete", handle: helper.handle })).text).toContain("its conversation's record deleted");
    expect(stopped).toEqual(["h1", "h1+record"]);
    expect(store.roomsOf("h1")).toEqual([]);
    // One kicked before is ended all the same; one whose terminal is gone is said so.
    const second = store.seat(room.id, { terminal: "gone", was: { agent: "claude-code", name: "second", cwd: "/w", model: null, profile: null }, by: "api", byAgent: true, starter: "api" });
    store.unseat(room.id, second.handle, "api");
    expect((await say("api", "room_manage", { action: "end", handle: second.handle })).text).toContain("was not there to close any more");
  });
});

describe("the room's seats, several at once (§6.2)", () => {
  function hosted() {
    const store = new RoomStore(mkdtempSync(join(tmpdir(), "as-batch-")));
    const info = (id: string, over: Record<string, unknown> = {}) => ({ id, harness: "claude-code", cwd: `/start/${id}`, workdir: `/start/${id}`, model: "sonnet", modelNow: null, modeNow: null, mode: "manual", effort: null, name: id, status: "idle", notices: [], choices: null, agentSessionId: `s-${id}`, resumedFrom: null, forked: false, profile: null, ...over });
    const terminals = new Map<string, any>([["a", info("a")], ["b", info("b")], ["c", info("c")]]);
    const chosen: string[] = [], calls: string[] = [];
    const host = { get: (id: string) => terminals.get(id) ?? null, list: () => [...terminals.values()], choose: (id: string, pick: number, label: string) => { chosen.push(`${id}:${pick}:${label}`); terminals.set(id, { ...terminals.get(id), choices: null }); } };
    const callLocal = async (method: string, path: string, body?: any) => {
      calls.push(`${method} ${path}`);
      if (method === "GET" && path === "/terminals") return { status: 200, body: { terminals: [...terminals.values()] } };
      if (method === "POST" && path === "/terminals/resume") { const id = `new-${body.agentSessionId}`; terminals.set(id, info(id, { agentSessionId: body.agentSessionId })); return { status: 201, body: { terminal: { id } } }; }
      if (method === "DELETE") { const id = path.split("/")[2]!.split("?")[0]!; const had = terminals.delete(id); return { status: had ? 200 : 404, body: {} }; }
      return { status: 404, body: {} };
    };
    const app = new Hono();
    mountRooms(app, { rooms: store, callLocal, terminals: { host } } as unknown as ApiDeps);
    const call = async (method: string, path: string) => { const res = await app.request(path, { method }); return { status: res.status, body: await res.json() as any }; };
    const room = store.create({ name: "r" });
    for (const t of ["a", "b", "c"]) store.seat(room.id, { terminal: t, was: { agent: "claude-code", name: t, cwd: `/start/${t}`, model: null, profile: null } });
    return { store, room, terminals, chosen, calls, call, info };
  }

  it("says yes to \"trust this folder?\" for every member that asks exactly that, and shows what each screen asks", async () => {
    const { room, terminals, chosen, call, info } = hosted();
    const trust = { title: "Do you trust the files in this folder?", text: "Claude Code may read files here.", options: [{ label: "Yes, proceed" }, { label: "No, exit" }], selected: 0 };
    terminals.set("a", info("a", { choices: trust }));
    terminals.set("b", info("b", { choices: { title: "Pick a model", options: [{ label: "Yes please" }, { label: "No" }], selected: 0 } }));
    const seats = (await call("GET", `/rooms/${room.id}`)).body.seats as any[];
    expect(seats.find((s) => s.handle === "a")).toMatchObject({ state: "waiting", asks: { title: trust.title, options: ["Yes, proceed", "No, exit"], trust: true } });
    expect(seats.find((s) => s.handle === "b").asks.trust).toBe(false);
    expect(seats.find((s) => s.handle === "c").asks).toBeNull();
    expect((await call("POST", `/rooms/${room.id}/trust`)).body).toEqual({ trusted: ["a"] });
    expect(chosen).toEqual(["a:0:Yes, proceed"]);
  });

  it("brings back every member that has ended, and closes or deletes a seat's terminal with it", async () => {
    const { store, room, terminals, calls, call, info } = hosted();
    terminals.set("a", info("a", { status: "exited" }));
    terminals.delete("b");                                  // its record is gone: resumed from what the seat kept
    store.note(room.id, "b", { id: "s-b", cwd: "/start/b" });
    const done = await call("POST", `/rooms/${room.id}/resume`);
    expect(done.body).toEqual({ resumed: ["a", "b"], failed: [] });
    expect(store.roomsOf("new-s-a")[0]?.seat.handle).toBe("a");
    expect(store.roomsOf("new-s-b")[0]?.seat.handle).toBe("b");
    expect(store.roomsOf("c")[0]?.seat.handle).toBe("c");    // still running: left alone
    expect((await call("DELETE", `/rooms/${room.id}/seats/c?close=end`)).body).toEqual({ ok: true, closed: true });
    expect(calls).toContain("DELETE /terminals/c");
    expect((await call("DELETE", `/rooms/${room.id}/seats/a?close=delete`)).body).toEqual({ ok: true, closed: true });
    expect(calls).toContain("DELETE /terminals/new-s-a?transcript=1");
    expect((await call("DELETE", `/rooms/${room.id}/seats/b?close=nope`)).status).toBe(400);
  });
});

describe("a seat's name", () => {
  it("is the session's own to change, carries everything the room keeps, and its old name still reaches it", async () => {
    const { home, store, room, say, call, renamed } = made();
    store.post(room.id, { from: "you", text: "@api @ui start" });
    store.post(room.id, { from: "ui", text: "@api which port?" });
    store.addTask(room.id, "ui", { title: "Form", owner: "ui" });
    store.setTask(room.id, "ui", 1, { state: "doing" });
    await say("ui", "room_changing", { paths: ["/w/form.ts"] });
    // The room's nickname and the session's own name are two things, each changed by itself.
    const said = (await say("ui", "room_rename", { name: "Frontend  Form" })).text;
    expect(said).toContain("You are @frontend-form in");
    expect(said).toContain("your session's own name in AgentSwitch is unchanged");
    expect(renamed).toEqual([]);
    expect((await say("ui", "session_rename", { name: "  Login  form work " })).text).toContain('This session is called "Login form work" in AgentSwitch now. Your @name in the room is still @frontend-form');
    expect(renamed).toEqual(["ui=Login form work"]);
    const now = store.get(room.id);
    expect(now.seats.map((s) => s.handle)).toEqual(["you", "api", "frontend-form"]);
    expect(store.messages(room.id).map((m) => [m.from, m.to])).toEqual([["you", ["api", "frontend-form"]], ["frontend-form", ["api"]]]);
    expect(now.receipts).toEqual({ 1: { api: "sent", "frontend-form": "sent" }, 2: { api: "sent" } });
    expect(now.tasks[0]).toMatchObject({ owner: "frontend-form", by: "frontend-form" });
    expect(now.claims[0]!.handle).toBe("frontend-form");
    expect(now.stats["frontend-form"]).toMatchObject({ posts: 1 });
    expect(now.stats.ui).toBeUndefined();
    // The old name still reaches it; it is nobody else's to take; the record on the disk says the new one.
    expect(store.post(room.id, { from: "api", text: "@ui 8080" }).to).toEqual(["frontend-form"]);
    expect((await say("api", "room_rename", { name: "ui" })).isError).toBe(true);
    expect((await say("api", "room_rename", { name: "you" })).isError).toBe(true);
    expect(new RoomStore(home).messages(room.id)[1]!.from).toBe("frontend-form");
    // A session renames only itself; the user renames anyone.
    // Another member's nickname: not a plain member's to change; an admin's, and the user's.
    expect((await say("api", "room_rename", { name: "x", handle: "frontend-form" })).isError).toBe(true);
    store.setCanAdd(room.id, "api", true);
    expect((await say("api", "room_rename", { name: "web", handle: "@ui" })).text).toContain("@frontend-form is @web in");
    expect(store.post(room.id, { from: "you", text: "@frontend-form @ui hi" }).to).toEqual(["web"]);
    expect((await call("PATCH", `/rooms/${room.id}/seats/api`, { name: "backend" })).body.seat.handle).toBe("backend");
    expect(store.roomsOf("api")[0]!.seat.handle).toBe("backend");
  });
});

describe("who has read a message", () => {
  it("is the seats given it whole or that read it themselves, told to its sender and to the screens, and kept over a restart", async () => {
    const { home, store, room, say, call } = made();
    const delivery = new RoomDelivery({ store, seat: () => ({ state: "idle", card: { agent: "claude-code", name: "x", cwd: "/w", model: null, profile: null, mode: "default", node: null } }) });
    store.seat(room.id, { terminal: "qa", was: { agent: "codex", name: "qa", cwd: "/w", model: null, profile: null } });
    await say("api", "room_post", { text: "@ui @qa the interface is in interface.md" });
    expect((await say("api", "room_read", { all: true })).text).toContain("[read by nobody yet]");
    delivery.atTurnEnd("ui");                                  // given whole: read
    expect(store.get(room.id).reads).toEqual({ 1: ["ui"] });
    expect((await say("api", "room_read", { all: true })).text).toContain("[read by @ui; not yet: @qa]");
    await say("qa", "room_read");                              // read by itself
    expect((await call("GET", `/rooms/${room.id}`)).body.reads).toEqual({ 1: ["ui", "qa"] });
    expect((await say("api", "room_read", { all: true })).text).toContain("[read by @ui @qa]");
    // An earlier message it only saw a line of is not read until it reads the room.
    store.post(room.id, { from: "api", text: "@ui two" });
    store.post(room.id, { from: "api", text: "@ui three" });
    delivery.atTurnEnd("ui");
    expect(store.get(room.id).reads["2"]).toBeUndefined();
    expect(store.get(room.id).reads["3"]).toEqual(["ui"]);
    store.post(room.id, { from: "you", text: "save" });        // the next change writes it
    expect(new RoomStore(home).get(room.id).reads["1"]).toEqual(["ui", "qa"]);
  });
});

describe("the room's record in its shared folder", () => {
  it("holds what was said, the tasks, the notes and the members as files, a member's handover note beside them, and is not listed among the members' files", async () => {
    const { store, room, say } = made();
    store.post(room.id, { from: "you", text: "@api start with the interface" });
    await say("api", "room_tasks", { action: "add", title: "Interface", detail: "POST /login" });
    await say("api", "room_notes", { text: "expiresAt is in milliseconds" });
    const dir = store.recordDir(room.id);
    const read = (name: string) => readFileSync(join(dir, name), "utf8");
    expect(read("log.md")).toContain("@you → @api\n\n@api start with the interface");
    expect(read("tasks.md")).toContain("## T1 [to do] Interface");
    expect(read("notes.md")).toContain("expiresAt is in milliseconds");
    expect(read("members.md")).toContain("- @api — claude-code");
    expect(read("README.md")).toContain("Taking work over from another member");
    // The next message is added to the log, not the log written anew.
    store.post(room.id, { from: "api", text: "@ui the interface is done" });
    expect(read("log.md").match(/^## #/gm)).toHaveLength(2);
    const told = await say("api", "room_handoff", { text: "Interface done and tested. Next: the form needs expiresAt. Watch out: the old field name is still in web/." });
    expect(told.text).toContain(join(dir, "handoff-api.md"));
    expect(read("handoff-api.md")).toContain("Watch out: the old field name");
    const listed = (await say("ui", "room_files")).text;
    expect(listed).toContain("It is empty");
    expect(listed).toContain(`The room's own record is in ${dir}`);
    // A rename is carried into the log.
    await say("api", "room_rename", { name: "backend" });
    expect(read("log.md")).toContain("@backend → @ui");
    expect(read("log.md").split("\n").filter((l) => l.startsWith("## ")).join(" ")).not.toContain("@api");
  });
});

describe("reading the room once", () => {
  it("gives a session only what it has not read, says how far behind it is when it is woken, and shows that per member", async () => {
    const { store, room, say, call } = made();
    const delivery = new RoomDelivery({ store, seat: () => ({ state: "idle", card: { agent: "claude-code", name: "x", cwd: "/w", model: null, profile: null, mode: "default", node: null } }) });
    store.post(room.id, { from: "api", text: "one, for nobody" });
    store.post(room.id, { from: "api", text: "two, for nobody" });
    store.post(room.id, { from: "api", text: "@ui three" });
    const woken = delivery.atTurnEnd("ui")!;
    expect(woken).toContain("You have 2 more unread in the room");
    expect((await call("GET", `/rooms/${room.id}`)).body.seats.find((s: any) => s.handle === "ui").unread).toBe(2);
    expect((await say("api", "room_members")).text).toContain("2 unread");
    const first = (await say("ui", "room_read")).text;
    expect(first).toContain("Unread by you: 2");
    expect(first).toContain("one, for nobody");
    expect(first).not.toContain("@ui three");                       // given whole already: read
    expect((await say("ui", "room_read")).text).toContain("Nothing new");
    expect((await say("ui", "room_read", { all: true })).text).toContain("@ui three");
    expect((await say("api", "room_members")).text).toContain("has read everything");
    store.post(room.id, { from: "api", text: "@ui four" });
    expect(delivery.atTurnEnd("ui")).toContain("You have read everything else in the room.");
  });
});

describe("which models a session may start a session on", () => {
  it("is the user's to say per profile: a model turned off is refused with the ones allowed, and said in the list", async () => {
    const { RoomPolicy } = await import("../src/rooms/policy.js");
    const { roomOrg } = await import("../src/api/roomOrg.js");
    const home = mkdtempSync(join(tmpdir(), "as-policy-"));
    const policy = new RoomPolicy(home);
    const started: any[] = [];
    const ask = async (method: string, path: string, body?: unknown) => {
      if (path === "/profiles") return { status: 200, body: { agents: { "claude-code": { current: "work", profiles: [{ id: "default", name: "Default" }, { id: "work", name: "Work" }] } } } };
      if (path === "/terminals" && method === "GET") return { status: 200, body: { models: { "claude-code": [{ id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }, { id: "haiku", name: "Haiku" }] }, terminals: [] } };
      if (path === "/terminals" && method === "POST") { started.push(body); return { status: 201, body: { terminal: { id: "t1" } } }; }
      return { status: 404, body: {} };
    };
    const org = roomOrg(ask, policy);
    expect(policy.set("claude-code", "work", ["haiku", "haiku", " "])).toEqual(["haiku"]);
    // Under the profile it would run on (the current one when none is named): refused, with what is allowed.
    await expect(org.start({ agent: "claude-code", cwd: "/w", model: "haiku" })).rejects.toThrow('turned the model haiku off for sessions started by a session under profile "Work". Allowed there: opus, sonnet');
    expect(started).toEqual([]);
    expect(await org.start({ agent: "claude-code", cwd: "/w", model: "sonnet" })).toBe("t1");
    expect(await org.start({ agent: "claude-code", cwd: "/w", model: "haiku", profile: "default" })).toBe("t1");   // not turned off there
    expect(await org.start({ agent: "claude-code", cwd: "/w" })).toBe("t1");                                       // the profile's own default
    expect((await org.models())["claude-code"]!.find((m) => m.id === "haiku")!.description).toContain("NOT for you under profile Work");
    // Kept over a restart; turned on again by an empty list.
    expect(new RoomPolicy(home).offFor("claude-code", "work")).toEqual(["haiku"]);
    policy.set("claude-code", "work", []);
    expect(new RoomPolicy(home).allows("claude-code", "work", "haiku")).toBe(true);
  });
});

describe("the models of a profile at another vendor's address (2026-11-23)", () => {
  const terminalsBody = { models: { "claude-code": [{ id: "opus", name: "Opus", description: "Opus 5.5 · Best for everyday" }, { id: "haiku", name: "Haiku", description: "Haiku 5.5 · Fastest" }] }, terminals: [] };
  const profilesBody = { agents: { "claude-code": { current: "default", profiles: [
    { id: "default", name: "Default", kind: "subscription" },
    { id: "own", name: "Own key", kind: "api", api: { model: "claude-made-up" } },
    { id: "dpsk", name: "dpsk", kind: "api", api: { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash" } },
  ] } } };

  it("lists what the address lists, or only the profile's model; the agent's own names with their versions", async () => {
    const { ProfileModelLists } = await import("../src/api/profileModels.js");
    let listed: unknown = { error: "not found" }; let asked = 0;
    const ask = async (_m: string, path: string) => { if (path === "/profiles/models") { asked++; return { status: 200, body: listed }; } return { status: 404, body: {} }; };
    const lists = new ProfileModelLists();
    const all = (await lists.all(ask, terminalsBody, profilesBody))["claude-code"]!;
    expect(all.profiles.find((p) => p.id === "default")!.models.map((m) => m.name)).toEqual(["Opus 5.5", "Haiku 5.5"]);
    expect(all.profiles.find((p) => p.id === "own")!.source).toBe("agent");   // Anthropic's own address
    expect(all.profiles.find((p) => p.id === "dpsk")).toMatchObject({ source: "profile", models: [{ id: "deepseek-flash" }] });
    // Asked once in ten minutes.
    await lists.all(ask, terminalsBody, profilesBody); expect(asked).toBe(1);
    listed = { models: ["deepseek-chat", "deepseek-reasoner"] };
    const fresh = (await new ProfileModelLists().all(ask, terminalsBody, profilesBody))["claude-code"]!.profiles.find((p) => p.id === "dpsk")!;
    expect(fresh).toMatchObject({ source: "vendor" });
    expect(fresh.models.map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-chat", "deepseek-reasoner"]);
  });

  it("refuses a Claude model for such a profile, and lists its own model to an admin", async () => {
    const { RoomPolicy } = await import("../src/rooms/policy.js");
    const { roomOrg } = await import("../src/api/roomOrg.js");
    const started: unknown[] = [];
    const ask = async (method: string, path: string, body?: unknown) => {
      if (path === "/profiles") return { status: 200, body: profilesBody };
      if (path === "/terminals" && method === "GET") return { status: 200, body: terminalsBody };
      if (path === "/terminals" && method === "POST") { started.push(body); return { status: 201, body: { terminal: { id: "t9" } } }; }
      if (path === "/profiles/models") return { status: 200, body: { unlisted: true } };
      return { status: 404, body: {} };
    };
    const org = roomOrg(ask, new RoomPolicy(mkdtempSync(join(tmpdir(), "as-vendor-"))));
    await expect(org.start({ agent: "claude-code", cwd: "/w", profile: "dpsk", model: "opus" })).rejects.toThrow(/another vendor's address, which has no model opus\. There: deepseek-flash/);
    expect(await org.start({ agent: "claude-code", cwd: "/w", profile: "dpsk", model: "deepseek-flash" })).toBe("t9");
    const models = (await org.models())["claude-code"]!;
    expect(models.find((m) => m.id === "deepseek-flash")!.description).toMatch(/Only under profile dpsk/);
    expect(models.find((m) => m.id === "opus")!.name).toBe("Opus 5.5");
  });

  it("points Claude Code's own names at the profile's model there, and nowhere else", async () => {
    const { vendorAliases } = await import("../src/terminals/launch.js");
    expect(vendorAliases({ name: "d", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash" })).toMatchObject({ ANTHROPIC_DEFAULT_FABLE_MODEL: "deepseek-flash", ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "deepseek-flash", ANTHROPIC_SMALL_FAST_MODEL: "deepseek-flash" });
    expect(vendorAliases({ name: "a", baseUrl: "https://api.anthropic.com", model: "claude-x" })).toEqual({});
    expect(vendorAliases({ name: "a", model: "claude-x" })).toEqual({});
    expect(vendorAliases({ name: "d", baseUrl: "https://api.deepseek.com/anthropic" })).toEqual({});
  });
});
