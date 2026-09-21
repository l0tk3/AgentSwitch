import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Store, THREAD_TTL_MS } from "../src/engine/store.js";
import { foldThread } from "../src/threads/fold.js";

function store(now: { t: number }) {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-ts-"));
  return new Store({ dbPath: ":memory:", threadsDir: join(dir, "threads"), now: () => now.t });
}

describe("Store: threads", () => {
  it("creates a thread with a private home, links tasks, lists by recency", () => {
    const now = { t: 1000 };
    const s = store(now);
    const th = s.createThread("/w", null);
    expect(th).toMatchObject({ cwd: "/w", status: "open", expiresAt: null, title: null });
    expect(existsSync(th.home)).toBe(true);
    const a = s.createTask({ task: "a", cwd: "/w", threadId: th.id });
    now.t = 2000;
    const b = s.createTask({ task: "b", cwd: "/w", threadId: th.id, parentId: a.id, exclude: [{ harness: "codex", model: "gpt-5.5" }], handoffFrom: { harness: "codex", model: "gpt-5.5", taskId: a.id, reason: "user" } });
    expect(s.tasksInThread(th.id).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(b.exclude).toEqual([{ harness: "codex", model: "gpt-5.5" }]);
    expect(b.handoffFrom).toMatchObject({ taskId: a.id, reason: "user" });
    expect(a.handoffFrom).toBeNull();
    now.t = 2500;
    const other = s.createThread("/x");
    expect(s.listThreads().map((t) => t.id)).toEqual([other.id, th.id]);
    now.t = 3000;
    s.appendThreadEvent(th.id, "title", { title: "T" });
    expect(s.listThreads()[0]!.id).toBe(th.id);   // events bump updated_at
  });

  it("event log: seq per thread, fold reads back what was written", () => {
    const s = store({ t: 1 });
    const th = s.createThread("/w");
    s.appendThreadEvent(th.id, "task", { taskId: "a", harness: "codex", model: "gpt-5.5", status: "done", tokens: 3 });
    s.appendThreadEvent(th.id, "summary", { title: "T", goal: "G" });
    const other = s.createThread("/y");
    s.appendThreadEvent(other.id, "task", { taskId: "z" });
    expect(s.threadEvents(th.id).map((e) => [e.seq, e.type])).toEqual([[1, "task"], [2, "summary"]]);
    const st = foldThread(s.threadEvents(th.id));
    expect(st.summary?.title).toBe("T");
    expect(st.cost).toEqual({ "codex/gpt-5.5": 3 });
  });

  it("archive sets a 7-day expiry, reopen clears it, expired threads are found and deleted with their home", () => {
    const now = { t: 10_000 };
    const s = store(now);
    const th = s.createThread("/w");
    s.appendThreadEvent(th.id, "title", { title: "x" });
    const archived = s.archiveThread(th.id);
    expect(archived.status).toBe("archived");
    expect(archived.expiresAt).toBe(10_000 + THREAD_TTL_MS);
    expect(s.expiredThreads(10_000 + THREAD_TTL_MS - 1)).toEqual([]);
    expect(s.expiredThreads(10_000 + THREAD_TTL_MS).map((t) => t.id)).toEqual([th.id]);
    expect(s.reopenThread(th.id)).toMatchObject({ status: "open", expiresAt: null });
    const custom = s.updateThread(th.id, { status: "archived", expiresAt: 20_000, title: "renamed" });
    expect(custom).toMatchObject({ title: "renamed", expiresAt: 20_000 });
    expect(s.deleteThread(th.id)).toBe(true);
    expect(s.deleteThread(th.id)).toBe(false);
    expect(existsSync(archived.home)).toBe(false);
    expect(s.threadEvents(th.id)).toEqual([]);
    expect(() => s.updateThread(th.id, { title: "z" })).toThrow(/not found/);
  });

  it("migration adds thread columns to an old tasks table", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-mig-"));
    const path = join(dir, "old.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL, task TEXT NOT NULL, cwd TEXT NOT NULL, pin TEXT, needs_browser INTEGER NOT NULL DEFAULT 0, harness TEXT, model TEXT, effort TEXT, brief TEXT, decision TEXT, attempts TEXT NOT NULL DEFAULT '[]', router_asks INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT)");
    db.exec("INSERT INTO tasks (id, created_at, updated_at, status, task, cwd) VALUES ('old1', 1, 1, 'done', 'x', '/w')");
    db.close();
    const s = new Store({ dbPath: path, threadsDir: join(dir, "threads") });
    expect(s.getTask("old1")).toMatchObject({ threadId: null, exclude: [], handoffFrom: null });
    s.close();
  });
});
