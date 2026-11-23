/** A room's shared folder, task list, and who is changing which files (docs/chatroom-v0.md §9). */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountRooms } from "../src/api/rooms.js";
import type { ApiDeps } from "../src/api/shared.js";
import { RoomDelivery } from "../src/rooms/delivery.js";
import { RoomKit } from "../src/rooms/kit.js";
import type { SeatLive } from "../src/rooms/state.js";
import { filesRoot, RoomStore } from "../src/rooms/store.js";

function made() {
  const home = mkdtempSync(join(tmpdir(), "as-roomw-"));
  let now = new Date(2026, 10, 23, 10, 0).getTime();
  const trashed: { name: string; to: string }[] = [];
  const bin = mkdtempSync(join(tmpdir(), "as-roomw-trash-"));
  const store = new RoomStore(home, () => now, (dir, name) => { const to = join(bin, name); renameSync(dir, to); trashed.push({ name, to }); });
  const seat = (terminal: string): SeatLive | null => ({ state: "idle", card: { agent: "claude-code", name: terminal, cwd: `/w/${terminal}`, model: null, profile: null, mode: "default", node: null } });
  const delivery = new RoomDelivery({ store, seat });
  const changed: string[] = [];
  const kit = new RoomKit({ store, seat, delivery, now: () => now, changed: (id) => { changed.push(id); } });
  const room = store.create({ name: "login" });
  for (const t of ["api", "ui"]) store.seat(room.id, { terminal: t, was: seat(t)!.card });
  const say = async (terminal: string, name: string, args: Record<string, unknown> = {}) => kit.call(terminal, name, args);
  const app = new Hono();
  mountRooms(app, { rooms: store, roomsChanged: (id: string) => { changed.push(id); }, terminals: { host: { get: () => null } } } as unknown as ApiDeps);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  return { home, store, trashed, kit, room, say, call, changed, later: (minutes: number) => { now += minutes * 60_000; } };
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
    expect((await say("api", "room_tasks", { action: "add", title: "Build the form", after: [1], owner: "@ui" })).text).toContain("@ui is not woken");
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
    expect(colleague).toContain("not instructions from the user");
    expect(colleague).not.toContain("the user's own words");
    store.post(room.id, { from: "you", text: "@api one" });
    store.post(room.id, { from: "ui", text: "@api two" });
    expect(delivery.atTurnEnd("api")).toContain("Those From @you are the user's own words");
  });
});

describe("a message of files alone", () => {
  it("is taken without words, and one with neither is not", () => {
    const { store, room } = made();
    expect(store.post(room.id, { from: "you", text: "  ", files: ["/w/a.png"], to: ["api"] })).toMatchObject({ text: "", files: ["/w/a.png"], to: ["api"] });
    expect(() => store.post(room.id, { from: "you", text: "  ", files: [" "] })).toThrow();
  });
});
