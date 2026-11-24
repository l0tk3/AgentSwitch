import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DESK_HANDOFF, DESK_NAME, DispatchDesk, mountDispatchDesk } from "../src/api/dispatchDesk.js";
import type { Ask } from "../src/api/roomOrg.js";
import type { ApiDeps } from "../src/api/shared.js";
import { saveWorkdir } from "../src/files/workdir.js";
import { RoomStore } from "../src/rooms/store.js";
import { loadTrustedFolders } from "../src/terminals/trustedFolders.js";

/** A service that starts terminals: each start a new id; what was asked kept. */
function fakeTerminals() {
  const terminals = new Map<string, { status: string; harness: string; session?: string }>();
  const asked: { method: string; path: string; body?: unknown }[] = [];
  let n = 0;
  const ask: Ask = async (method, path, body) => {
    asked.push({ method, path, ...(body === undefined ? {} : { body }) });
    const id = decodeURIComponent(path.split("/")[2] ?? "");
    if (method === "POST" && (path === "/terminals" || path === "/terminals/resume")) {
      const b = body as { harness: string; agentSessionId?: string };
      const t = `t${++n}`;
      terminals.set(t, { status: "idle", harness: b.harness, ...(b.agentSessionId ? { session: b.agentSessionId } : {}) });
      return { status: 201, body: { terminal: { id: t, model: "opus" } } };
    }
    if (method === "GET" && path.startsWith("/terminals/")) {
      const t = terminals.get(id);
      return t ? { status: 200, body: { terminal: { id, status: t.status, model: "opus" } } } : { status: 404, body: { error: "not found" } };
    }
    if (method === "DELETE" && path.startsWith("/terminals/")) { const t = terminals.get(id); if (t) t.status = "exited"; return { status: 200, body: { ok: true } }; }
    if (method === "PATCH") return { status: 200, body: {} };
    return { status: 404, body: { error: "no route" } };
  };
  return { ask, asked, terminals };
}

function made() {
  const home = mkdtempSync(join(tmpdir(), "desk-"));
  const work = mkdtempSync(join(tmpdir(), "desk-work-"));
  saveWorkdir(home, work);
  const rooms = new RoomStore(home);
  const fake = fakeTerminals();
  const desk = new DispatchDesk({ home, rooms, ask: fake.ask });
  return { home, work, rooms, desk, ...fake };
}

describe("the new dispatch: a session at the 调度台 (2026-11-24)", () => {
  it("is off until turned on; on, it gets its folder, its instructions, a trusted folder, the desk room and a seat as admin", async () => {
    const { home, work, rooms, desk, asked } = made();
    expect((await desk.status()).settings).toMatchObject({ on: false, agent: "claude-code", mode: "bypass", maxStarted: 8 });
    const s = await desk.apply({ ...desk.settings(), on: true, agent: "codex", model: "gpt-6-sol" });
    expect(s.folder).toBe(join(work, "Dispatch"));
    expect(readFileSync(join(work, "Dispatch", "AGENTS.md"), "utf8")).toContain("你是 AgentSwitch 的调度");
    expect(readFileSync(join(work, "Dispatch", "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(loadTrustedFolders(home)).toContain(join(work, "Dispatch"));
    expect(asked.find((a) => a.path === "/terminals")?.body).toEqual({ harness: "codex", cwd: join(work, "Dispatch"), mode: "bypass", model: "gpt-6-sol" });
    const room = rooms.get(s.room!);
    expect(room).toMatchObject({ name: DESK_NAME, desk: true });
    expect(room.seats.find((x) => x.kind === "session")).toMatchObject({ handle: "dispatch", terminal: "t1", canAdd: true });
    expect(s.terminal).toMatchObject({ id: "t1", status: "idle" });
    expect(desk.limitOf("t1")).toBe(8);
    expect(desk.limitOf("t9")).toBeNull();
    // Already running: nothing started again.
    await desk.ensure();
    expect(asked.filter((a) => a.method === "POST").length).toBe(1);
  });

  it("gives what the user says at the desk to the dispatch, named or not", async () => {
    const { rooms, desk } = made();
    const s = await desk.apply({ ...desk.settings(), on: true });
    expect(rooms.post(s.room!, { from: "you", text: "把登录改成新接口" }).to).toEqual(["dispatch"]);
  });

  it("resumes the same conversation when it ended, and is stopped when turned off", async () => {
    const { rooms, desk, asked, terminals } = made();
    const s = await desk.apply({ ...desk.settings(), on: true });
    rooms.note(s.room!, "dispatch", { id: "sess-1", cwd: s.folder });
    terminals.get("t1")!.status = "exited";
    await desk.ensure();
    expect(asked.filter((a) => a.path === "/terminals/resume").at(-1)?.body).toMatchObject({ agentSessionId: "sess-1" });
    expect(rooms.get(s.room!).seats.find((x) => x.handle === "dispatch")?.terminal).toBe("t2");
    await desk.apply({ ...desk.settings(), on: false });
    expect(terminals.get("t2")!.status).toBe("exited");
  });

  it("replaced: the old one is asked for its handover at the desk, leaves once it is written, and a new one starts", async () => {
    const { rooms, desk, work, asked, terminals } = made();
    const s = await desk.apply({ ...desk.settings(), on: true });
    const kept = { ...DESK_HANDOFF };
    Object.assign(DESK_HANDOFF, { waitMs: 2000, pollMs: 20 });
    try {
      const going = desk.replace();
      await new Promise((r) => setTimeout(r, 50));
      expect(rooms.last(s.room!)).toMatchObject({ from: "you", to: ["dispatch"] });
      expect(rooms.last(s.room!)!.text).toContain("〔交接〕");
      writeFileSync(join(work, "Dispatch", "handoff.md"), "在管：登录重构");
      await going;
    } finally { Object.assign(DESK_HANDOFF, kept); }
    expect(terminals.get("t1")!.status).toBe("exited");
    expect(asked.filter((a) => a.path === "/terminals").length).toBe(2);
    const seats = rooms.get(s.room!).seats.filter((x) => x.kind === "session");
    expect(seats.find((x) => x.left === undefined)?.terminal).toBe("t2");
    expect(existsSync(join(work, "Dispatch", "handoff.md"))).toBe(true);
  });

  it("is set over the API; the instructions are read and written", async () => {
    const { desk, rooms } = made();
    const app = new Hono();
    mountDispatchDesk(app, { dispatchDesk: desk, rooms } as unknown as ApiDeps);
    const put = await app.request("/dispatch/desk", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "opencode", maxStarted: 6 }) });
    expect(put.status).toBe(200);
    expect(desk.settings()).toMatchObject({ on: false, agent: "opencode", maxStarted: 6 });
    expect((await app.request("/dispatch/desk", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "yolo" }) })).status).toBe(400);
    const w = await app.request("/dispatch/desk/instructions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "# 我的规矩" }) });
    expect((await w.json() as { text: string }).text).toBe("# 我的规矩");
    expect((await app.request("/dispatch/desk/replace", { method: "POST" })).status).toBe(409);
  });
});
