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
    // A file a message came with, wherever its sender had it: by its whole path; one no message carries is not.
    const elsewhere = join(mkdtempSync(join(tmpdir(), "as-attached-")), "flow.pdf");
    writeFileSync(elsewhere, "%PDF-1");
    expect((await app.request(`/rooms/${room.id}/files/content?path=${encodeURIComponent(elsewhere)}`)).status).toBe(404);
    store.post(room.id, { from: "you", text: "看这个", files: [elsewhere] });
    const sent = await app.request(`/rooms/${room.id}/files/content?path=${encodeURIComponent(elsewhere)}`);
    expect(sent.status).toBe(200);
    expect(await sent.text()).toBe("%PDF-1");
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
    expect((await say("ui", "room_read", {})).text).toContain("one more");
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
    expect((await call("DELETE", `/rooms/${room.id}/seats/c?close=end`)).body).toMatchObject({ ok: true, closed: true, handingOver: false });
    expect(calls).toContain("DELETE /terminals/c");
    expect((await call("DELETE", `/rooms/${room.id}/seats/a?close=delete`)).body).toMatchObject({ ok: true, closed: true, handingOver: false });
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
    // A newcomer named as one of the old names is not given it: @ui and @frontend-form still mean @web.
    const seat = store.seat(room.id, { terminal: "ui2", was: { agent: "codex", name: "ui", cwd: "/w", model: null, profile: null } });
    expect(seat.handle).toBe("ui-2");
    expect(store.post(room.id, { from: "you", text: "@ui-2 @ui hi" }).to.slice().sort()).toEqual(["ui-2", "web"]);
  });

  it("a member called so now is the one a name means, before an old name of another (a room from before)", () => {
    const { store, room } = made();
    store.rename(room.id, "you", "ui", "gmail");
    store.unseat(room.id, "gmail");
    // As a room made before this fix may hold: a newcomer took the old name.
    const r = store.get(room.id);
    (store as unknown as { all(): Map<string, unknown> }).all().set(room.id, { ...r, seats: [...r.seats, { ...r.seats.find((x) => x.handle === "api")!, handle: "ui", terminal: "new-ui" }] });
    expect(store.post(room.id, { from: "you", text: "@ui 接着做" }).to).toEqual(["ui"]);
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

describe("a message about one task of the list (2026-11-24)", () => {
  it("carries the task, keeps it in a reply, says it in the envelope and the log, and is read by it", async () => {
    const { store, room, say, call, kitOf, home } = made();
    store.addTask(room.id, "you", { title: "Interface", owner: "api" });              // T1, told to api about T1
    expect(store.last(room.id)).toMatchObject({ to: ["api"], task: 1 });
    const asked = await call("POST", `/rooms/${room.id}/messages`, { text: "@ui 表单先等接口", task: 1 });
    expect(asked.status).toBe(201);
    expect(asked.body.message.task).toBe(1);
    expect((await call("POST", `/rooms/${room.id}/messages`, { text: "x", task: 9 })).status).toBe(400);
    // A reply is about what it answers.
    await say("ui", "room_post", { text: "好", reply_to: asked.body.message.seq, expects: "none" });
    expect(store.last(room.id)).toMatchObject({ from: "ui", task: 1 });
    // Said otherwise, it is about what it says; nothing said and nothing answered: no task.
    await say("ui", "room_post", { text: "@api 别的事", expects: "answer" });
    expect(store.last(room.id)!.task).toBeUndefined();
    // The envelope names the task and who has it.
    const msg = store.messages(room.id).find((m) => m.task === 1 && m.from === "you" && m.to.includes("ui"))!;
    const delivery = new RoomDelivery({ store, seat: () => null });
    expect(delivery.envelope(store.get(room.id), msg, store.get(room.id).seats.find((s) => s.handle === "ui")!)).toContain("Task: T1 Interface (@api)");
    // Read by task.
    const read = (await kitOf().call("api", "room_read", { task: 1 })).text;
    expect(read).toContain("about T1");
    expect(read).toContain("[T1]");
    expect(read).not.toContain("别的事");
    expect(readFileSync(join(home, "room-files", room.id, "_room", "log.md"), "utf8")).toMatch(/· T1 · @ui/);
  });
});

describe("the rooms in a database (2026-11-24)", () => {
  it("reads the rooms kept as files once, keeps the folder aside, and finds words", () => {
    const home = mkdtempSync(join(tmpdir(), "as-roomdb-"));
    mkdirSync(join(home, "rooms"), { recursive: true });
    const room = { id: "abc123def0", name: "旧房间", topic: "", createdAt: 1, createdBy: "you", paused: false, seats: [{ handle: "you", kind: "user", face: null, joinedAt: 1, addedBy: "you", canAdd: true, byAgent: false }], lastSeq: 3, readSeq: 1, roundsLimit: 6, roundsFrom: 0, notes: null, tasks: [{ n: 1, title: "接口", state: "todo", by: "you", createdAt: 1, updatedAt: 1 }], lastTask: 1, claims: [], stats: {}, reads: {}, readsFrom: 0, renames: {}, receipts: {} };
    writeFileSync(join(home, "rooms", "abc123def0.json"), JSON.stringify(room));
    writeFileSync(join(home, "rooms", "abc123def0.jsonl"), [
      { seq: 1, from: "you", to: [], text: "登录接口改完了", at: 2 },
      { seq: 2, from: "you", to: [], text: "", at: 3, files: ["/tmp/a.png"] },
      { seq: 3, from: "you", to: [], text: "T1 的事", at: 4, task: 1 },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n{torn");
    const store = new RoomStore(home);
    expect(store.list().map((r) => r.name)).toEqual(["旧房间"]);
    expect(store.messages("abc123def0").map((m) => m.seq)).toEqual([1, 2, 3]);   // a message of files alone is kept
    expect(store.last("abc123def0")).toMatchObject({ seq: 3, task: 1 });
    expect(existsSync(join(home, "rooms"))).toBe(false);
    expect(existsSync(join(home, "rooms-before-db", "abc123def0.jsonl"))).toBe(true);
    expect(store.search("abc123def0", "接口改", 10).map((m) => m.seq)).toEqual([1]);
    expect(store.search("abc123def0", "T1", 10).map((m) => m.seq)).toEqual([3]);   // two characters: a plain scan
    expect(store.messagesOfTask("abc123def0", 1, 10).map((m) => m.seq)).toEqual([3]);
    expect(store.unread("abc123def0")).toEqual({ count: 0, forYou: false });
    // Written and read again by a new store on the same home.
    store.post("abc123def0", { from: "you", text: "新的一条", task: 1 });
    const again = new RoomStore(home);
    expect(again.messages("abc123def0", { limit: 2 }).map((m) => m.text)).toEqual(["T1 的事", "新的一条"]);
    expect(again.messagesBefore("abc123def0", 3, 5).map((m) => m.seq)).toEqual([1, 2]);
    expect([...again.countByTask("abc123def0", 0)]).toEqual([[1, 2]]);
  });
});

describe("a stuck task, a long message, and asking for some of what was said (2026-11-24)", () => {
  it("says why a task is stuck, refuses a session's long message, and answers by words, task and page", async () => {
    const { store, room, say, call } = made();
    store.addTask(room.id, "you", { title: "Interface", owner: "api" });
    expect(() => store.setTask(room.id, "api", 1, { state: "blocked" })).toThrow(/Say why T1 is blocked/);
    store.setTask(room.id, "api", 1, { state: "blocked", note: "等 iOS 的字段名" });
    expect(store.get(room.id).tasks[0]!.state).toBe("blocked");
    expect(store.last(room.id)).toMatchObject({ from: "api", to: ["you"], task: 1, text: "〔任务表〕@you T1 卡住了：等 iOS 的字段名" });
    const long = "长".repeat(900);
    const refused = await say("api", "room_post", { text: long, expects: "none" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Too long for a message \(900 characters; at most 800\)/);
    expect((await call("POST", `/rooms/${room.id}/messages`, { text: long })).status).toBe(201);   // the user's is not cut
    await call("POST", `/rooms/${room.id}/messages`, { text: "接口字段改名了", task: 1 });
    const found = await call("GET", `/rooms/${room.id}/messages?q=${encodeURIComponent("字段改")}`);
    expect(found.body.messages.map((m: { text: string }) => m.text)).toEqual(["接口字段改名了"]);
    const ofTask = await call("GET", `/rooms/${room.id}/messages?task=1`);
    expect(ofTask.body.messages.every((m: { task: number }) => m.task === 1)).toBe(true);
    expect(ofTask.body.byTask["1"]).toBeGreaterThanOrEqual(2);
    const last = store.last(room.id)!.seq;
    const page = await call("GET", `/rooms/${room.id}/messages?before=${last}&limit=1`);
    expect(page.body.messages.map((m: { seq: number }) => m.seq)).toEqual([last - 1]);
  });
});

describe("what waits on the user (等你处理, 2026-11-24)", () => {
  it("lists a stuck task and a question put to the user, until the user speaks or reads it", async () => {
    const { store, room, call } = made();
    store.addTask(room.id, "you", { title: "Interface", owner: "api" });
    store.setTask(room.id, "api", 1, { state: "blocked", note: "等字段名" });
    store.post(room.id, { from: "api", text: "@you 字段叫 name 还是 title？", expects: "answer", task: 1 });
    store.post(room.id, { from: "api", text: "@you 报一下进度", expects: "none" });
    const first = await call("GET", "/rooms/attention");
    expect(first.body.items.map((i: { kind: string }) => i.kind).sort()).toEqual(["blocked", "question"]);
    expect(first.body.items.find((i: { kind: string }) => i.kind === "question")).toMatchObject({ room: room.id, handle: "api", task: 1, text: "@you 字段叫 name 还是 title？" });
    expect((await call("GET", "/rooms")).body.rooms[0].attention).toBe(2);
    await call("POST", `/rooms/${room.id}/messages`, { text: "@api 叫 name" });
    expect((await call("GET", "/rooms/attention")).body.items.map((i: { kind: string }) => i.kind)).toEqual(["blocked"]);
    // Read, not answered: no longer waiting either.
    const asked = store.post(room.id, { from: "api", text: "@you 要不要顺便改 UI？", expects: "answer" });
    expect((await call("GET", "/rooms/attention")).body.items.map((i: { kind: string }) => i.kind).sort()).toEqual(["blocked", "question"]);
    store.read(room.id, asked.seq);
    expect((await call("GET", "/rooms/attention")).body.items.map((i: { kind: string }) => i.kind)).toEqual(["blocked"]);
  });
});

describe("a Kit that does not fill a session's context (2026-11-24)", () => {
  it("gives short unread whole, long ones and the overflow as lines, a message whole by number in parts, and a task's card", async () => {
    const { store, room, say } = made();
    store.post(room.id, { from: "you", text: "@ui 短的一条" });
    store.post(room.id, { from: "you", text: `@ui ${"长".repeat(5000)}` });
    for (let i = 0; i < 8; i++) store.post(room.id, { from: "you", text: `@ui ${String(i).repeat(600)}` });
    const first = (await say("ui", "room_read", {})).text;
    expect(first).toContain("Unread by you: 10 (10 for you)");
    expect(first).toContain("#1 11-23 10:00 @you → @ui\n@ui 短的一条");
    expect(first).toMatch(/#2 11-23 10:00 @you → @ui: @ui 长+… \(5004 chars\)/);
    expect(first).toContain("#3 11-23 10:00 @you → @ui\n@ui 000");          // short ones after it still come whole
    expect(first.length).toBeLessThan(7000);
    expect(first).toMatch(/stay unread for your next room_read/);
    // The long one counts as read (asked for by number); the overflow does not.
    const second = (await say("ui", "room_read", {})).text;
    expect(second).not.toContain("#2 ");
    expect(second).toContain("#10 ");
    // Whole, in parts.
    const part1 = (await say("ui", "room_read", { seq: 2 })).text;
    expect(part1).toContain("part 1 of 2");
    expect(part1).toContain("{ seq: 2, part: 2 }");
    expect((await say("ui", "room_read", { seq: 2, part: 2 })).text).toContain("part 2 of 2");
    expect((await say("ui", "room_read", { seq: 99 })).isError).toBe(true);
    // A task's card; blocked through the Kit.
    store.addTask(room.id, "you", { title: "Form", owner: "ui" });
    await say("ui", "room_post", { text: "表单做了一半", task: 1, expects: "none" });
    const card = (await say("api", "room_tasks", { action: "show", n: 1 })).text;
    expect(card).toContain("T1 [to do · @ui] Form");
    expect(card).toMatch(/@ui: 表单做了一半/);
    expect((await say("ui", "room_tasks", { action: "block", n: 1 })).isError).toBe(true);
    expect((await say("ui", "room_tasks", { action: "block", n: 1, note: "等接口" })).text).toContain("T1 is blocked: 等接口");
    expect((await say("api", "room_tasks", {})).text).toContain("T1 [BLOCKED · @ui] Form");
    // The tools by their new names, and the old names still answered.
    expect((await say("ui", "room_info", { show: "files" })).text).toContain("shared folder");
    expect((await say("ui", "room_update", { what: "notes", text: "约定：毫秒" })).text).toContain("pinned notes");
    expect((await say("ui", "room_notes", {})).text).toContain("约定：毫秒");
    expect((await say("ui", "room_info", { show: "rooms" })).text).toContain('"login"');
  });

  it("keeps the tools' own words short", () => {
    const { kitOf, store, room } = made();
    store.setCanAdd(room.id, "api", true);
    const size = (t: string): number => JSON.stringify(kitOf().tools(t)).length;
    expect(size("ui")).toBeLessThan(5800);      // was 10 381 characters for a member (avatars and secrets since)
    expect(size("api")).toBeLessThan(7400);     // and 15 362 for an admin (create with its members, dissolve since)
  });
});

describe("ending a member that holds unfinished work (2026-11-24)", () => {
  it("asks it for its handover note first and ends it once written, or at once when nothing is owed", async () => {
    const { HANDOFF, closeSeat } = await import("../src/rooms/kit.js");
    HANDOFF.waitMs = 2_000; HANDOFF.pollMs = 20;
    const { store, room } = made();
    const stopped: string[] = [];
    const stop = async (t: string) => { stopped.push(t); return true; };
    store.addTask(room.id, "you", { title: "Form", owner: "ui" });
    store.setTask(room.id, "ui", 1, { state: "doing" });
    expect(await closeSeat({ store, stop }, room.id, "ui", "you", false, true)).toBe("handing over");
    expect(store.last(room.id)!.text).toContain("〔交接〕@ui 你马上要被结束");
    expect(stopped).toEqual([]);
    store.handoff(room.id, "ui", "表单做了一半，在 Form.swift");
    for (let i = 0; i < 50 && !stopped.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toEqual(["ui"]);
    expect(store.get(room.id).seats.find((s) => s.handle === "ui")!.left).toBeDefined();
    // Nothing owed: at once.
    expect(await closeSeat({ store, stop }, room.id, "api", "you", false, false)).toBe("closed");
    expect(stopped).toEqual(["ui", "api"]);
    HANDOFF.waitMs = 120_000; HANDOFF.pollMs = 2_000;
  });
});

describe("the user talking to a member in its terminal (2026-11-24)", () => {
  it("tells the room once in a while and reminds the member, but not for a room's own delivery", () => {
    const { store, room, later } = made();
    let now = new Date(2026, 10, 23, 10, 0).getTime();
    const delivery = new RoomDelivery({ store, seat: () => null, now: () => now });
    expect(delivery.userTyped("ui", "[Room login · #3]\nFrom: @api")).toBeNull();
    expect(delivery.userTyped("ui", "<task-notification>\n<task-id>a1</task-id>")).toBeNull();   // the agent's own program, not the user
    expect(delivery.userTyped("ui", "[SYSTEM NOTIFICATION - NOT USER INPUT]")).toBeNull();
    const told = delivery.userTyped("ui", "先别改表单了")!;
    expect(told).toContain('"login" (as @ui)');
    expect(told).toContain("say so there in a line");
    expect(store.last(room.id)).toMatchObject({ from: "ui", to: [], text: "〔终端〕用户刚在我的终端里直接跟我说了话。" });
    const count = store.messages(room.id).length;
    delivery.userTyped("ui", "再说一句");
    expect(store.messages(room.id).length).toBe(count);          // not again within ten minutes
    now += 11 * 60_000; later(11);
    delivery.userTyped("ui", "又一句");
    expect(store.messages(room.id).length).toBe(count + 1);
    expect(delivery.userTyped("nobody", "hi")).toBeNull();
  });
});

describe("a session's avatar, its own in every room (2026-11-24)", () => {
  it("is chosen by the session from the library or drawn, one for each look, kept across rooms and by its conversation", async () => {
    const { store, room, say, call } = made();
    const other = store.create({ name: "second" });
    store.seat(other.id, { terminal: "api", was: { agent: "claude-code", name: "api", cwd: "/w/api", model: null, profile: null } });
    expect((await say("api", "room_info", { show: "avatars", room: room.id })).text).toContain("p1–p48");
    expect((await say("api", "room_update", { what: "avatar", room: room.id, pixel: "p7", classic: "e3" })).text).toContain("changed in every room");
    const inOther = store.avatarOf(store.get(other.id).seats.find((s) => s.handle === "api")!);
    expect(inOther?.pixel).toMatchObject({ kind: "grid", id: "p7" });
    expect(inOther?.classic).toMatchObject({ kind: "emoji", emoji: "🐨" });
    // A drawn face; an emoji of its own; the bad ones refused with the library said.
    await say("api", "room_update", { what: "avatar", room: room.id, rows: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"], color: 4, emoji: "🦖", bg: 2 });
    expect(store.avatarOf(store.get(room.id).seats.find((s) => s.handle === "api")!)).toEqual({ pixel: { kind: "face", rows: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"], color: 4 }, classic: { kind: "emoji", emoji: "🦖", bg: 2 } });
    expect((await say("api", "room_update", { what: "avatar", room: room.id, emoji: "ab" })).isError).toBe(true);
    expect((await say("api", "room_update", { what: "avatar", room: room.id, pixel: "p99" })).text).toContain("No pixel avatar");
    // Its conversation known: the same avatar after a resume in another terminal.
    store.note(room.id, "api", { id: "conv-1", cwd: "/w/api" });
    await say("api", "room_update", { what: "avatar", room: room.id, classic: "e1" });
    store.rebind(room.id, "api", "api2", { agent: "claude-code", name: "api", cwd: "/w/api", model: null, profile: null });
    expect(store.avatarOf(store.get(room.id).seats.find((s) => s.handle === "api")!)?.classic?.emoji).toBe("🦊");
    // The user sets one, or puts it back; the seat view carries it.
    const put = await call("PUT", `/rooms/${room.id}/seats/ui/avatar`, { pixel: { id: "f3" } });
    expect(put.body.avatar.pixel).toMatchObject({ kind: "face", id: "f3" });
    expect((await call("GET", `/rooms/${room.id}`)).body.seats.find((s: { handle: string }) => s.handle === "ui").avatar.pixel.id).toBe("f3");
    await call("PUT", `/rooms/${room.id}/seats/ui/avatar`, { pixel: null });
    expect((await call("GET", `/rooms/${room.id}`)).body.seats.find((s: { handle: string }) => s.handle === "ui").avatar.pixel).toBeNull();
    expect((await call("GET", "/rooms/avatars")).body.art).toHaveLength(48);
  });
});

describe("a room's secrets: ciphertexts only (2026-11-24)", () => {
  it("takes sealed tokens, refuses a value, replaces by name, gives them to members with their use, and removes them", async () => {
    const { store, room, say, call } = made();
    const token = `enc:v1:${"A".repeat(40)}`;
    expect((await call("POST", `/rooms/${room.id}/secrets`, { items: [{ name: "GitHub 登录", kind: "site", url: "https://github.com", account: "me", token: "hunter2-plain" }] })).status).toBe(400);
    expect(store.secrets(room.id)).toEqual([]);
    const added = await call("POST", `/rooms/${room.id}/secrets`, { items: [{ name: "GitHub 登录", kind: "site", url: "https://github.com", account: "me", token }, { name: "OPENAI", kind: "exec", env: "OPENAI_API_KEY", token }] });
    expect(added.status).toBe(201);
    expect(added.body.secrets).toHaveLength(2);
    await call("POST", `/rooms/${room.id}/secrets`, { items: [{ name: "OPENAI", kind: "api", url: "https://api.openai.com", token }] });
    expect(store.secrets(room.id).map((s) => `${s.name}:${s.kind}`)).toEqual(["GitHub 登录:site", "OPENAI:api"]);
    const read = (await say("api", "room_info", { show: "secrets" })).text;
    expect(read).toContain("GitHub 登录 · website login · https://github.com · account me");
    expect(read).toContain(token);
    expect(read).toContain("the gate puts the key in");
    expect((await call("GET", `/rooms/${room.id}`)).body.secrets).toBe(2);
    const sid = store.secrets(room.id)[0]!.id;
    expect((await call("DELETE", `/rooms/${room.id}/secrets/${sid}`)).status).toBe(200);
    expect((await call("GET", `/rooms/${room.id}/secrets`)).body.secrets).toHaveLength(1);
    expect((await call("DELETE", `/rooms/${room.id}/secrets/${sid}`)).status).toBe(404);
  });
});
