import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemon, sweepThreads, type BuildOverrides, type DaemonConfig } from "../src/daemon.js";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import { echoExecutor } from "../src/executors/echo.js";
import { QuotaService } from "../src/quota/index.js";
import { RoutingLog } from "../src/router/log.js";
import type { RouteResult } from "../src/router/route.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { foldThread } from "../src/threads/fold.js";
import { appendMemory } from "../src/threads/memory.js";
import { decisionJson, realTargets, TARGETS_PATH } from "./helpers.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(overrides: BuildOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-delete-"));
  const home = join(dir, "state");
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "keep.txt"), "user work");
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  const d = buildDaemon(cfg, { quota: new QuotaService([]), router: echoRouter([decisionJson({ model: "gpt-5.5", effort: null })]), ...overrides });
  cleanup.push(() => d.close());
  const create = (threadId?: string, extra: Partial<Parameters<Store["createTask"]>[0]> = {}) => {
    const t = d.store.createTask({ task: "same text", cwd, ...(threadId ? { threadId } : {}), ...extra });
    d.store.appendEvent(t.id, "done", { text: "result" });
    const task = d.store.updateTask(t.id, { status: "done" });
    if (threadId) d.store.appendThreadEvent(threadId, "task", { taskId: task.id, status: "done", harness: "codex", model: "gpt-5.5" });
    mkdirSync(join(home, "artifacts", task.id));
    writeFileSync(join(home, "artifacts", task.id, "out.txt"), "stored artifact");
    return task;
  };
  return { ...d, home, cwd, create };
}
const route: RouteResult = { verdict: { ok: false, notes: [] }, decision: null, source: "router", routerError: null, routerMs: 1, attempts: 1 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("permanent task deletion", () => {
  it("deletes one task's data and owned files, preserves sibling tasks and user files, and drops blended context", async () => {
    const f = fixture(), thread = f.store.createThread(f.cwd, "derived title");
    const a = f.create(thread.id);
    const b = f.create(thread.id, { parentId: a.id, handoffFrom: { taskId: a.id, harness: "codex", model: "gpt-5.5", reason: "user" } });
    const other = f.store.createThread(f.cwd, "unrelated"), c = f.create(other.id, { parentId: a.id });
    const approval = f.store.createApproval(a.id, "question", "context", "question");
    f.store.saveRecord({ taskId: a.id, ts: 1, kind: "chat", harness: "codex", model: "gpt-5.5", status: "done", failureKind: null, ms: 1, tokens: 1, approvals: 1, handedOff: false, pinned: false, userHandoff: false, rating: null });
    f.store.appendThreadEvent(thread.id, "summary", { title: "old summary", goal: "deleted context" });
    f.store.appendThreadEvent(thread.id, "session", { taskId: b.id, harness: "codex", sessionId: "contains old task" });
    f.store.appendThreadEvent(thread.id, "handoff", { from: { taskId: a.id, harness: "codex", model: "gpt-5.5" }, to: { taskId: b.id } });
    writeFileSync(join(thread.home, "session.json"), "old context");
    const memory = join(f.home, "MEMORY.md");
    writeFileSync(memory, "# user note\nKeep handwritten facts.\n");
    appendMemory(memory, ["old fact"], { taskId: a.id });
    appendMemory(memory, ["retained fact"], { taskId: b.id });
    const log = new RoutingLog(join(f.home, "routing.db"));
    cleanup.push(() => log.close());
    const legacy = log.record(a.task, f.cwd, route);
    log.record(a.task, f.cwd, route, 1, a.id);
    log.record(a.task, f.cwd, route, 2, a.id);
    const retained = log.record(b.task, f.cwd, route, 3, b.id);
    f.store.updateTask(a.id, { routeLogId: legacy });
    const res = await f.app.request(`/tasks/${a.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(f.store.getTask(a.id)).toBeUndefined();
    expect(f.store.getApproval(approval.id)).toBeUndefined();
    expect(f.store.eventsSince(a.id)).toEqual([]);
    expect(f.store.recordsSince(0)).toEqual([]);
    expect(f.store.getTask(b.id)).toMatchObject({ parentId: null, handoffFrom: null });
    expect(f.store.getTask(c.id)).toMatchObject({ parentId: null });
    expect(f.store.getThread(other.id)?.title).toBe("unrelated");
    expect(f.store.getThread(thread.id)?.title).toBeNull();
    expect(foldThread(f.store.threadEvents(thread.id))).toMatchObject({ summary: null, sessions: {}, handoffs: [], tasks: [{ taskId: b.id }] });
    expect(existsSync(join(f.home, "tasks", `${a.id}.jsonl`))).toBe(false);
    expect(existsSync(join(f.home, "artifacts", a.id))).toBe(false);
    expect(existsSync(join(f.home, "artifacts", b.id, "out.txt"))).toBe(true);
    expect(existsSync(join(thread.home, "session.json"))).toBe(false);
    expect(existsSync(thread.home)).toBe(true);
    expect(readFileSync(join(f.cwd, "keep.txt"), "utf8")).toBe("user work");
    expect(readFileSync(memory, "utf8")).toContain("handwritten");
    expect(readFileSync(memory, "utf8")).not.toContain("old fact");
    expect(readFileSync(memory, "utf8")).toContain("retained fact");
    expect(log.recent().map((entry) => entry.id)).toEqual([retained]);
  });

  it("deletes the last task in an archived thread, including its home", async () => {
    const f = fixture(), thread = f.store.createThread(f.cwd), task = f.create(thread.id);
    f.store.archiveThread(thread.id);
    expect((await f.app.request(`/tasks/${task.id}`, { method: "DELETE" })).status).toBe(200);
    expect(f.store.getThread(thread.id)).toBeUndefined();
    expect(f.store.threadEvents(thread.id)).toEqual([]);
    expect(existsSync(thread.home)).toBe(false);
    expect((await f.app.request(`/tasks/${task.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await f.app.request(`/threads/${thread.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("deleting a thread cascades all task records and files; expiry does the same", async () => {
    const f = fixture(), thread = f.store.createThread(f.cwd);
    const tasks = [f.create(thread.id), f.create(thread.id)], surviving = f.create(f.store.createThread(f.cwd).id);
    expect((await f.app.request(`/threads/${thread.id}`, { method: "DELETE" })).status).toBe(200);
    for (const task of tasks) {
      expect(f.store.getTask(task.id)).toBeUndefined();
      expect(f.store.eventsSince(task.id)).toEqual([]);
      expect(existsSync(join(f.home, "artifacts", task.id))).toBe(false);
      expect(existsSync(join(f.home, "tasks", `${task.id}.jsonl`))).toBe(false);
    }
    expect(f.store.getTask(surviving.id)).toBeDefined();
    f.store.archiveThread(surviving.threadId!, -1);
    expect(sweepThreads(f.store, Date.now(), f.engine)).toEqual([surviving.threadId]);
    expect(f.store.listTasks()).toEqual([]);
    expect(readFileSync(join(f.cwd, "keep.txt"), "utf8")).toBe("user work");
  });

  it("rejects active targets or siblings, even when deleting a terminal task", async () => {
    const f = fixture(), thread = f.store.createThread(f.cwd), done = f.create(thread.id);
    const active = f.store.createTask({ task: "queued", cwd: f.cwd, threadId: thread.id });
    for (const url of [`/tasks/${done.id}`, `/tasks/${active.id}`, `/threads/${thread.id}`]) {
      const res = await f.app.request(url, { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining("still queued") });
    }
    expect(f.store.listTasks()).toHaveLength(2);
  });

  it("waits for in-flight summaries after terminal status, protecting sibling deletion and expiry", async () => {
    const f = fixture(), started = deferred(), release = deferred();
    const engine = new Engine({ store: f.store, bus: new Bus(), router: echoRouter([decisionJson({ model: "gpt-5.5", effort: null })]), executors: [echoExecutor("codex")], targets: realTargets(), quota: () => ({}), summarizer: async () => { started.resolve(); await release.promise; return { summary: null, error: "test", ms: 0 }; } });
    const thread = f.store.createThread(f.cwd), sibling = f.create(thread.id);
    const task = engine.submit({ task: "echo", cwd: f.cwd, threadId: thread.id });
    await started.promise;
    expect(f.store.getTask(task.id)?.status).toBe("done");
    expect(engine.deleteTask(task.id)).toMatchObject({ ok: false, code: "busy", error: expect.stringContaining("finishing") });
    expect(engine.deleteTask(sibling.id)).toMatchObject({ ok: false, code: "busy" });
    expect(engine.deleteThread(thread.id)).toMatchObject({ ok: false, code: "busy" });
    f.store.archiveThread(thread.id, -1);
    expect(sweepThreads(f.store, Date.now(), engine)).toEqual([]);
    release.resolve();
    await engine.idle();
    expect(engine.deleteThread(thread.id)).toEqual({ ok: true });
  });

  it("does not follow artifact/home symlinks or trust a stored home path", async () => {
    const f = fixture(), thread = f.store.createThread(f.cwd), task = f.create(thread.id);
    const artifact = join(f.home, "artifacts", task.id);
    rmSync(artifact, { recursive: true }); symlinkSync(f.cwd, artifact);
    rmSync(thread.home, { recursive: true }); symlinkSync(f.cwd, thread.home);
    const db = new DatabaseSync(join(f.home, "agentswitch.db"));
    db.prepare("UPDATE threads SET home = ? WHERE id = ?").run(f.cwd, thread.id); db.close();
    expect((await f.app.request(`/tasks/${task.id}`, { method: "DELETE" })).status).toBe(200);
    expect(readFileSync(join(f.cwd, "keep.txt"), "utf8")).toBe("user work");
    expect(existsSync(artifact)).toBe(false);
    expect(existsSync(thread.home)).toBe(false);
  });

  it("refuses a swapped managed root before removing any task data", () => {
    const f = fixture(), task = f.create();
    rmSync(join(f.home, "artifacts"), { recursive: true }); symlinkSync(f.cwd, join(f.home, "artifacts"));
    expect(() => f.store.deleteTask(task.id)).toThrow(/root changed/);
    expect(f.store.getTask(task.id)).toBeDefined();
    expect(f.store.eventsSince(task.id)).toHaveLength(1);
    expect(readFileSync(join(f.cwd, "keep.txt"), "utf8")).toBe("user work");
  });

  it("rolls back related database rows together if a delete fails", () => {
    const f = fixture(), task = f.create(), a = f.store.createApproval(task.id, "x", "y");
    const db = new DatabaseSync(join(f.home, "agentswitch.db"));
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect(() => f.store.deleteTask(task.id)).toThrow(/test failure/);
    expect(f.store.getTask(task.id)).toBeDefined(); expect(f.store.getApproval(a.id)).toBeDefined();
    expect(f.store.eventsSince(task.id)).toHaveLength(1); db.close();
  });

  it.each(["parent", "thread", "archived"] as const)("rechecks %s after a delayed submission sealer", async (kind) => {
    const started = deferred(), release = deferred();
    const f = fixture({ sealer: async (text) => { started.resolve(); await release.promise; return { ok: true, text, sealed: [], ms: 0 }; } });
    const thread = f.store.createThread(f.cwd), task = f.create(thread.id);
    const request = f.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "follow up", cwd: f.cwd, ...(kind === "parent" ? { parent_id: task.id } : { thread_id: thread.id }) }) });
    await started.promise;
    if (kind === "archived") f.store.archiveThread(thread.id);
    else expect(f.engine.deleteThread(thread.id)).toEqual({ ok: true });
    release.resolve();
    const res = await request;
    expect(res.status).toBe(kind === "archived" ? 409 : 404);
    expect(f.store.listTasks()).toHaveLength(kind === "archived" ? 1 : 0);
  });
});
