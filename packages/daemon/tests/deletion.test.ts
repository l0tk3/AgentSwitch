import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantLog, type AssistantKind } from "../src/assistant/log.js";
import { buildDaemon, forgetDeletedTasks, sweepThreads, type BuildOverrides, type DaemonConfig } from "../src/daemon.js";
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

describe("the conversation goes with the task (threads-v0 手动删除)", () => {
  function conversation(home: string) {
    const log = new AssistantLog(join(home, "assistant.db"));
    cleanup.push(() => log.close());
    const say = (role: "user" | "assistant", kind: AssistantKind, taskIds: string[] = [], replyTo: number | null = null) =>
      log.append({ role, text: kind, kind, taskIds, clientId: null, replyTo }).seq;
    const lines = () => log.recent(100).map((m) => `${m.role} ${m.kind} ${m.taskIds.join(",")}`.trim());
    return { log, say, lines };
  }

  it("drops every line that names a deleted task and the message it answers; small talk and update notices stay", async () => {
    const f = fixture(), a = f.create(), b = f.create();
    const { log, say, lines } = conversation(f.home);
    say("assistant", "task", [a.id], say("user", "message"));
    say("assistant", "waiting", [a.id]);
    say("assistant", "notice", [a.id]);
    say("assistant", "reply", [], say("user", "message"));
    say("assistant", "notice");
    say("assistant", "status", [a.id, b.id], say("user", "message"));
    say("assistant", "notice", [b.id]);
    log.setWatch(a.id, 60_000);
    log.setWatch(b.id, 60_000);
    expect((await f.app.request(`/tasks/${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect(lines()).toEqual(["user message", "assistant reply", "assistant notice", `assistant notice ${b.id}`]);
    expect(log.watches().map((w) => w.taskId)).toEqual([b.id]);
  });

  it("a deleted thread takes the lines of all its tasks", async () => {
    const f = fixture(), thread = f.store.createThread(f.cwd, "t");
    const a = f.create(thread.id), b = f.create(thread.id), other = f.create();
    const { say, lines } = conversation(f.home);
    say("assistant", "task", [a.id], say("user", "message"));
    say("assistant", "notice", [b.id]);
    say("assistant", "notice", [other.id]);
    expect((await f.app.request(`/threads/${thread.id}`, { method: "DELETE" })).status).toBe(200);
    expect(lines()).toEqual([`assistant notice ${other.id}`]);
  });

  it("deleting one entry of the home screen: a message with its answers and the tasks they created, or one line", async () => {
    const f = fixture(), made = f.create(), other = f.create();
    const { say, lines } = conversation(f.home);
    const ask = say("user", "message");
    const created = say("assistant", "task", [made.id], ask);
    const notice = say("assistant", "notice", [made.id]);
    const chat = say("user", "message");
    say("assistant", "reply", [], chat);
    const status = say("assistant", "status", [other.id], say("user", "message"));
    const update = say("assistant", "notice");
    const del = (seq: number | string) => f.app.request(`/assistant/${seq}`, { method: "DELETE" });
    expect((await del(update)).status).toBe(200);
    expect(lines()).not.toContain("assistant notice");
    expect((await del(status)).status).toBe(200);
    expect(f.store.getTask(other.id), "a status answer only names a task; it did not create it").toBeDefined();
    expect((await del(chat)).status).toBe(200);
    expect(lines()).toEqual(["user message", `assistant task ${made.id}`, `assistant notice ${made.id}`]);
    expect((await del(created)).status).toBe(200);
    expect(f.store.getTask(made.id)).toBeUndefined();
    expect(lines(), "the task's own lines went with it").toEqual([]);
    expect((await del(ask)).status).toBe(404);
    expect((await del(notice)).status).toBe(404);
    expect((await del("x")).status).toBe(400);
  });

  it("an entry whose task still runs, or all history while one does, is refused and nothing goes", async () => {
    const f = fixture(), done = f.create();
    const running = f.store.updateTask(f.store.createTask({ task: "long", cwd: f.cwd }).id, { status: "running" });
    const { say, lines } = conversation(f.home);
    const ask = say("user", "message");
    say("assistant", "task", [running.id], ask);
    say("assistant", "notice", [done.id]);
    const before = lines();
    expect((await f.app.request(`/assistant/${ask}`, { method: "DELETE" })).status).toBe(409);
    expect((await f.app.request("/history", { method: "DELETE" })).status).toBe(409);
    expect(lines()).toEqual(before);
    expect(f.store.getTask(running.id)).toBeDefined();
    expect(f.store.getTask(done.id)).toBeDefined();
  });

  it("clearing all history removes every topic, task and conversation line, and keeps the context and handwritten memory", async () => {
    const f = fixture(), thread = f.store.createThread(f.cwd, "t");
    const a = f.create(thread.id), loose = f.create();
    const { log, say, lines } = conversation(f.home);
    say("assistant", "task", [a.id], say("user", "message"));
    say("assistant", "reply", [], say("user", "message"));
    say("assistant", "notice");
    log.setWatch(loose.id, 60_000);
    const memory = join(f.home, "MEMORY.md");
    writeFileSync(memory, "# user note\nKeep handwritten facts.\n");
    appendMemory(memory, ["learned"], { taskId: a.id });
    const res = await f.app.request("/history", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(f.store.listTasks(100)).toEqual([]);
    expect(f.store.listThreads({ limit: 100 })).toEqual([]);
    expect(lines()).toEqual([]);
    expect(log.watches()).toEqual([]);
    expect(readFileSync(memory, "utf8")).toContain("Keep handwritten facts.");
    expect(readFileSync(memory, "utf8")).not.toContain("learned");
    expect(existsSync(join(f.cwd, "keep.txt")), "the user's own files stay").toBe(true);
  });

  it("a dated folder AgentSwitch made goes with the last task working there; the user's own folders and links stay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-folders-"));
    cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
    const home = join(dir, "state"), root = join(dir, "AgentSwitch"), project = join(dir, "project"), elsewhere = join(dir, "elsewhere");
    for (const d of [home, root, project, elsewhere]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, "workdir.json"), JSON.stringify({ path: root }));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "", taskFolders: true };
    const d = buildDaemon(cfg, { quota: new QuotaService([]), router: echoRouter([decisionJson({ model: "gpt-5.5", effort: null })]) });
    cleanup.push(() => d.close());
    const folder = (name: string) => { const p = join(root, name); mkdirSync(join(p, "out"), { recursive: true }); writeFileSync(join(p, "out", "result.zip"), "x"); return p; };
    const shared = folder("2026-09-29-aaaaaaaa"), alone = folder("2026-09-29-bbbbbbbb");
    const link = join(root, "2026-09-29-cccccccc");
    symlinkSync(elsewhere, link);
    writeFileSync(join(elsewhere, "keep.txt"), "user file");
    const task = (cwd: string) => d.store.updateTask(d.store.createTask({ task: "x", cwd }).id, { status: "done" });
    const first = task(shared), followUp = task(shared), other = task(alone), mine = task(project), linked = task(link);
    const del = (id: string) => d.app.request(`/tasks/${id}`, { method: "DELETE" });
    expect((await del(first.id)).status).toBe(200);
    expect(existsSync(shared), "another task still works there").toBe(true);
    expect((await del(followUp.id)).status).toBe(200);
    expect(existsSync(shared)).toBe(false);
    expect((await del(mine.id)).status).toBe(200);
    expect(existsSync(project), "a folder the user chose").toBe(true);
    expect((await del(linked.id)).status).toBe(200);
    expect(existsSync(join(elsewhere, "keep.txt")), "a link is never followed").toBe(true);
    expect((await d.app.request("/history", { method: "DELETE" })).status).toBe(200);
    expect(existsSync(alone)).toBe(false);
    expect(d.store.getTask(other.id)).toBeUndefined();
  });

  it("lines about tasks deleted before are cleaned at start", () => {
    const f = fixture(), kept = f.create();
    const { log, say, lines } = conversation(f.home);
    say("assistant", "task", ["gone0001"], say("user", "message"));
    say("assistant", "notice", [kept.id]);
    log.setWatch("gone0002", 60_000);
    expect(forgetDeletedTasks(log, f.store)).toBe(2);
    expect(lines()).toEqual([`assistant notice ${kept.id}`]);
    expect(log.watches()).toEqual([]);
    expect(forgetDeletedTasks(log, f.store)).toBe(0);
  });
});
