import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, Store } from "../src/engine/store.js";
import { DatabaseSync } from "node:sqlite";

describe("Store", () => {
  it("creates, updates and lists tasks with JSON columns round-tripping", () => {
    const store = new Store({ dbPath: ":memory:" });
    const t = store.createTask({ task: "do x", cwd: "/tmp", pin: { harness: "codex", model: "gpt-5.5" }, needsBrowser: true });
    expect(t).toMatchObject({ status: "queued", pin: { harness: "codex", model: "gpt-5.5" }, needsBrowser: true, attempts: [], routerAsks: 0 });
    const u = store.updateTask(t.id, { status: "running", harness: "codex", model: "gpt-5.5", attempts: [{ harness: "a", model: "b", kind: "quota", excerpt: "", sideEffects: { filesChanged: 0, commandsRun: 0, approvalsGranted: 0 } }], routerAsks: 2, decision: null });
    expect(u.attempts).toHaveLength(1);
    expect(u.routerAsks).toBe(2);
    expect(store.listTasks()[0]!.id).toBe(t.id);
    expect(store.getTask("nope")).toBeUndefined();
    expect(() => store.updateTask("nope", { status: "done" })).toThrow(/not found/);
    store.close();
  });

  it("events are sequenced per task and mirrored to JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-store-"));
    const store = new Store({ dbPath: join(dir, "db.sqlite"), tasksDir: join(dir, "tasks") });
    const t = store.createTask({ task: "x", cwd: "/" });
    store.appendEvent(t.id, "queued");
    store.appendEvent(t.id, "text", { text: "hi" });
    expect(store.eventsSince(t.id).map((e) => [e.seq, e.type])).toEqual([[1, "queued"], [2, "text"]]);
    expect(store.eventsSince(t.id, 1)).toHaveLength(1);
    expect(readFileSync(join(dir, "tasks", `${t.id}.jsonl`), "utf8").trim().split("\n")).toHaveLength(2);
    store.close();
  });

  it("approvals resolve once; usage sums done-event tokens per harness", () => {
    let now = 1_000;
    const store = new Store({ dbPath: ":memory:", now: () => now });
    const t = store.createTask({ task: "x", cwd: "/" });
    store.updateTask(t.id, { harness: "claude-code" });
    const a = store.createApproval(t.id, "bash: rm", "evidence");
    expect(store.pendingApprovals()).toHaveLength(1);
    expect(store.resolveApproval(a.id, "allowed")?.status).toBe("allowed");
    expect(store.resolveApproval(a.id, "denied")?.status).toBe("allowed");
    expect(store.pendingApprovals(t.id)).toEqual([]);
    now = 2_000;
    store.appendEvent(t.id, "done", { tokens: 150 });
    expect(store.eventsSince(t.id).at(-1)!.ts).toBe(2_000);
    store.close();
  });
});

describe("migration", () => {
  it("adds columns introduced later to a database created by an older daemon", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-migrate-"));
    const path = join(dir, "old.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL,
      task TEXT NOT NULL, cwd TEXT NOT NULL, pin TEXT, needs_browser INTEGER NOT NULL DEFAULT 0,
      harness TEXT, model TEXT, effort TEXT, brief TEXT, decision TEXT, attempts TEXT NOT NULL DEFAULT '[]', router_asks INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT)`);
    old.exec("INSERT INTO tasks (id, created_at, updated_at, status, task, cwd) VALUES ('a', 1, 1, 'done', 'old task', '/tmp')");
    old.close();
    const store = new Store({ dbPath: path });
    expect(store.getTask("a")).toMatchObject({ ephemeral: false, parentId: null, task: "old task" });
    const t = store.createTask({ task: "new", cwd: "/tmp", parentId: "a", ephemeral: true });
    expect(store.getTask(t.id)).toMatchObject({ parentId: "a", ephemeral: true });
    store.close();
    expect(migrate(new DatabaseSync(path))).toEqual([]);   // idempotent
  });
});
