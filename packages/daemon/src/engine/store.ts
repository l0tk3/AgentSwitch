/** SQLite persistence for tasks, events and approvals, plus a JSONL mirror of events per task. */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RecordRow } from "../threads/record.js";
import type { Thread, ThreadEvent, ThreadEventType, ThreadStatus } from "../threads/types.js";
import type { Approval, ApprovalStatus, NewTask, Task, TaskEvent, TaskEventType } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL,
  task TEXT NOT NULL, cwd TEXT NOT NULL, pin TEXT, needs_browser INTEGER NOT NULL DEFAULT 0, ephemeral INTEGER NOT NULL DEFAULT 0, parent_id TEXT,
  harness TEXT, model TEXT, effort TEXT, brief TEXT, decision TEXT, attempts TEXT NOT NULL DEFAULT '[]',
  router_asks INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS events (
  task_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at INTEGER NOT NULL, action TEXT NOT NULL,
  evidence TEXT NOT NULL, status TEXT NOT NULL, resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at DESC);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT,
  cwd TEXT NOT NULL, home TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS thread_events (
  thread_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
);
CREATE INDEX IF NOT EXISTS threads_updated ON threads(updated_at DESC);
CREATE TABLE IF NOT EXISTS records (
  task_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, harness TEXT NOT NULL, model TEXT NOT NULL,
  status TEXT NOT NULL, failure_kind TEXT, ms INTEGER NOT NULL, tokens INTEGER NOT NULL, approvals INTEGER NOT NULL,
  handed_off INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, user_handoff INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS records_ts ON records(ts DESC);`;

/** Archived threads are deleted, home dir included, this long after archiving (decided 2026-09-21). */
export const THREAD_TTL_MS = 7 * 86400_000;

type Row = Record<string, unknown>;

/** Columns added after the first release; CREATE TABLE IF NOT EXISTS does not add them to an existing table. */
const ADDED_COLUMNS: Record<string, string[]> = {
  tasks: ["ephemeral INTEGER NOT NULL DEFAULT 0", "parent_id TEXT", "attachments TEXT NOT NULL DEFAULT '[]'", "thread_id TEXT", "exclude TEXT NOT NULL DEFAULT '[]'", "handoff_from TEXT", "spoken TEXT"],
};

export function migrate(db: DatabaseSync): string[] {
  const applied: string[] = [];
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const def of columns) {
      const name = def.split(" ")[0]!;
      if (present.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
      applied.push(`${table}.${name}`);
    }
  }
  return applied;
}

export type StoreOptions = {
  readonly dbPath: string;
  readonly tasksDir?: string;
  /** Where thread private homes live ($AGENTSWITCH_HOME/threads). Memory stores use a temp dir. */
  readonly threadsDir?: string;
  readonly now?: () => number;
};

export class Store {
  private readonly db: DatabaseSync;
  private readonly tasksDir: string | undefined;
  private readonly threadsDir: string;
  private readonly now: () => number;

  constructor(opts: StoreOptions) {
    if (opts.dbPath !== ":memory:") mkdirSync(dirname(opts.dbPath), { recursive: true });
    if (opts.tasksDir) mkdirSync(opts.tasksDir, { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec(SCHEMA);
    migrate(this.db);
    this.tasksDir = opts.tasksDir;
    this.threadsDir = opts.threadsDir ?? join(tmpdir(), `agentswitch-threads-${process.pid}`);
    this.now = opts.now ?? Date.now;
  }

  createTask(input: NewTask): Task {
    const ts = this.now();
    const id = randomUUID().slice(0, 8);
    this.db.prepare(
      `INSERT INTO tasks (id, created_at, updated_at, status, task, cwd, pin, needs_browser, ephemeral, parent_id, attachments, thread_id, exclude, handoff_from) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ts, ts, input.task, input.cwd, input.pin ? JSON.stringify(input.pin) : null, input.needsBrowser ? 1 : 0, input.ephemeral ? 1 : 0, input.parentId ?? null, JSON.stringify(input.attachments ?? []),
      input.threadId ?? null, JSON.stringify(input.exclude ?? []), input.handoffFrom ? JSON.stringify(input.handoffFrom) : null);
    if (input.threadId) this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(ts, input.threadId);
    return this.getTask(id)!;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : undefined;
  }

  listTasks(limit = 50): Task[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Row[]).map(toTask);
  }

  tasksInThread(threadId: string): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId) as Row[]).map(toTask);
  }

  // ---- threads (threads-v0 §1–2): the row is a handle, the state lives in the append-only log ----

  createThread(cwd: string, title: string | null = null): Thread {
    const ts = this.now();
    const id = randomUUID().slice(0, 8);
    const home = join(this.threadsDir, id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db.prepare("INSERT INTO threads (id, created_at, updated_at, title, cwd, home, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'open', NULL)").run(id, ts, ts, title, cwd, home);
    return this.getThread(id)!;
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Row | undefined;
    return row ? toThread(row) : undefined;
  }

  listThreads(opts: { status?: ThreadStatus; limit?: number } = {}): Thread[] {
    const rows = opts.status
      ? this.db.prepare("SELECT * FROM threads WHERE status = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(opts.status, opts.limit ?? 50)
      : this.db.prepare("SELECT * FROM threads ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(opts.limit ?? 50);
    return (rows as Row[]).map(toThread);
  }

  updateThread(id: string, patch: { title?: string | null; status?: ThreadStatus; expiresAt?: number | null }): Thread {
    const sets: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [this.now()];
    if (patch.title !== undefined) { sets.push("title = ?"); values.push(patch.title); }
    if (patch.status !== undefined) { sets.push("status = ?"); values.push(patch.status); }
    if (patch.expiresAt !== undefined) { sets.push("expires_at = ?"); values.push(patch.expiresAt); }
    values.push(id);
    this.db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    const t = this.getThread(id);
    if (!t) throw new Error(`thread ${id} not found`);
    return t;
  }

  /** Archive: expiry defaults to now + THREAD_TTL_MS; the user may set another date or delete at once. */
  archiveThread(id: string, ttlMs = THREAD_TTL_MS): Thread {
    return this.updateThread(id, { status: "archived", expiresAt: this.now() + ttlMs });
  }

  reopenThread(id: string): Thread {
    return this.updateThread(id, { status: "open", expiresAt: null });
  }

  /** Delete the row, its log and its private home. Tasks keep their thread_id (dangling, by design). */
  deleteThread(id: string): boolean {
    const t = this.getThread(id);
    if (!t) return false;
    rmSync(t.home, { recursive: true, force: true });
    this.db.prepare("DELETE FROM thread_events WHERE thread_id = ?").run(id);
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    return true;
  }

  expiredThreads(now = this.now()): Thread[] {
    return (this.db.prepare("SELECT * FROM threads WHERE status = 'archived' AND expires_at IS NOT NULL AND expires_at <= ?").all(now) as Row[]).map(toThread);
  }

  appendThreadEvent(threadId: string, type: ThreadEventType, payload: Record<string, unknown> = {}): ThreadEvent {
    const last = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM thread_events WHERE thread_id = ?").get(threadId) as Row;
    const seq = Number(last.seq) + 1;
    const ts = this.now();
    this.db.prepare("INSERT INTO thread_events (thread_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(threadId, seq, ts, type, JSON.stringify(payload));
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(ts, threadId);
    return { threadId, seq, ts, type, payload };
  }

  // ---- track record (threads-v0 §7) ----

  saveRecord(r: RecordRow): void {
    this.db.prepare(`INSERT OR REPLACE INTO records (task_id, ts, kind, harness, model, status, failure_kind, ms, tokens, approvals, handed_off, pinned, user_handoff)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.taskId, r.ts, r.kind, r.harness, r.model, r.status, r.failureKind, r.ms, r.tokens, r.approvals, r.handedOff ? 1 : 0, r.pinned ? 1 : 0, r.userHandoff ? 1 : 0);
  }

  /** The user took the task away from its target: a negative signal on that record. */
  markUserHandoff(taskId: string): boolean {
    return Number(this.db.prepare("UPDATE records SET user_handoff = 1 WHERE task_id = ?").run(taskId).changes) > 0;
  }

  recordsSince(ts: number): RecordRow[] {
    const rows = this.db.prepare("SELECT * FROM records WHERE ts >= ? ORDER BY ts").all(ts) as Row[];
    return rows.map((r) => ({
      taskId: String(r.task_id), ts: Number(r.ts), kind: String(r.kind), harness: String(r.harness), model: String(r.model), status: String(r.status),
      failureKind: (r.failure_kind as string | null) ?? null, ms: Number(r.ms), tokens: Number(r.tokens), approvals: Number(r.approvals),
      handedOff: Number(r.handed_off) === 1, pinned: Number(r.pinned) === 1, userHandoff: Number(r.user_handoff) === 1,
    }));
  }

  threadEvents(threadId: string): ThreadEvent[] {
    const rows = this.db.prepare("SELECT * FROM thread_events WHERE thread_id = ? ORDER BY seq").all(threadId) as Row[];
    return rows.map((r) => ({ threadId: String(r.thread_id), seq: Number(r.seq), ts: Number(r.ts), type: String(r.type) as ThreadEventType, payload: JSON.parse(String(r.payload)) }));
  }

  updateTask(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Task {
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [this.now()];
    const map: Record<string, (v: unknown) => unknown> = {
      status: (v) => v, harness: (v) => v, model: (v) => v, effort: (v) => v, brief: (v) => v, result: (v) => v, error: (v) => v,
      decision: (v) => (v === null ? null : JSON.stringify(v)), attempts: (v) => JSON.stringify(v), routerAsks: (v) => v,
      threadId: (v) => v, cwd: (v) => v, ephemeral: (v) => (v ? 1 : 0), spoken: (v) => v,
    };
    const columns: Record<string, string> = { routerAsks: "router_asks", threadId: "thread_id" };
    for (const [key, value] of Object.entries(patch)) {
      const conv = map[key];
      if (!conv) continue;
      sets.push(`${columns[key] ?? key} = ?`);
      values.push(conv(value));
    }
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...(values as (string | number | null)[]));
    const task = this.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    return task;
  }

  appendEvent(taskId: string, type: TaskEventType, payload: Record<string, unknown> = {}): TaskEvent {
    const last = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = ?").get(taskId) as Row;
    const seq = Number(last.seq) + 1;
    const ts = this.now();
    this.db.prepare("INSERT INTO events (task_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(taskId, seq, ts, type, JSON.stringify(payload));
    const event: TaskEvent = { taskId, seq, ts, type, payload };
    if (this.tasksDir) appendFileSync(join(this.tasksDir, `${taskId}.jsonl`), JSON.stringify(event) + "\n");
    return event;
  }

  eventsSince(taskId: string, afterSeq = 0): TaskEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq").all(taskId, afterSeq) as Row[];
    return rows.map((r) => ({ taskId: String(r.task_id), seq: Number(r.seq), ts: Number(r.ts), type: String(r.type) as TaskEventType, payload: JSON.parse(String(r.payload)) }));
  }

  createApproval(taskId: string, action: string, evidence: string): Approval {
    const id = randomUUID().slice(0, 8);
    this.db.prepare("INSERT INTO approvals (id, task_id, created_at, action, evidence, status) VALUES (?, ?, ?, ?, ?, 'pending')").run(id, taskId, this.now(), action, evidence);
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  pendingApprovals(taskId?: string): Approval[] {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND task_id = ? ORDER BY created_at").all(taskId)
      : this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all();
    return (rows as Row[]).map(toApproval);
  }

  resolveApproval(id: string, status: Exclude<ApprovalStatus, "pending">): Approval | undefined {
    this.db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(status, this.now(), id);
    return this.getApproval(id);
  }

  /** Token usage per harness recorded in done events; the Claude quota provider reads this. */
  usageSince(ts: number): Record<string, number> {
    const rows = this.db.prepare("SELECT t.harness AS harness, e.payload AS payload FROM events e JOIN tasks t ON t.id = e.task_id WHERE e.type = 'done' AND e.ts >= ?").all(ts) as Row[];
    const out: Record<string, number> = {};
    for (const r of rows) {
      const h = r.harness ? String(r.harness) : "unknown";
      const tokens = Number((JSON.parse(String(r.payload)) as { tokens?: number }).tokens ?? 0);
      out[h] = (out[h] ?? 0) + tokens;
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}

function toTask(r: Row): Task {
  return {
    id: String(r.id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    status: String(r.status) as Task["status"],
    task: String(r.task),
    cwd: String(r.cwd),
    pin: r.pin ? JSON.parse(String(r.pin)) : null,
    needsBrowser: Number(r.needs_browser) === 1,
    ephemeral: Number(r.ephemeral ?? 0) === 1,
    parentId: (r.parent_id as string | null) ?? null,
    attachments: JSON.parse(String(r.attachments ?? "[]")),
    threadId: (r.thread_id as string | null) ?? null,
    exclude: JSON.parse(String(r.exclude ?? "[]")),
    handoffFrom: r.handoff_from ? JSON.parse(String(r.handoff_from)) : null,
    harness: (r.harness as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    brief: (r.brief as string | null) ?? null,
    decision: r.decision ? JSON.parse(String(r.decision)) : null,
    attempts: JSON.parse(String(r.attempts ?? "[]")),
    routerAsks: Number(r.router_asks ?? 0),
    result: (r.result as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    spoken: (r.spoken as string | null) ?? null,
  };
}

function toThread(r: Row): Thread {
  return {
    id: String(r.id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    title: (r.title as string | null) ?? null,
    cwd: String(r.cwd),
    home: String(r.home),
    status: String(r.status) as ThreadStatus,
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
  };
}

function toApproval(r: Row): Approval {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    createdAt: Number(r.created_at),
    action: String(r.action),
    evidence: String(r.evidence),
    status: String(r.status) as ApprovalStatus,
    resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
  };
}
