/** SQLite persistence for tasks, events and approvals, plus a JSONL mirror of events per task. */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RecordRow } from "../router/record.js";
import type { Thread, ThreadEvent, ThreadEventType, ThreadStatus } from "../threads/types.js";
import { TERMINAL, type Approval, type ApprovalKind, type ApprovalStatus, type BlockCause, type Device, type NewTask, type Task, type TaskEvent, type TaskEventType } from "./types.js";
import { DEFAULT_LIST_LIMIT } from "../core/limits.js";

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
CREATE INDEX IF NOT EXISTS records_ts ON records(ts DESC);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);`;

/** Archived threads are deleted, home dir included, this long after archiving (decided 2026-09-21). */
export const THREAD_TTL_MS = 7 * 86400_000;

type Row = Record<string, unknown>;

/** Columns added after the first release; CREATE TABLE IF NOT EXISTS does not add them to an existing table. */
const ADDED_COLUMNS: Record<string, string[]> = {
  tasks: ["ephemeral INTEGER NOT NULL DEFAULT 0", "parent_id TEXT", "attachments TEXT NOT NULL DEFAULT '[]'", "thread_id TEXT", "exclude TEXT NOT NULL DEFAULT '[]'", "handoff_from TEXT", "spoken TEXT", "approval_policy TEXT", "route_log_id INTEGER", "rating INTEGER", "block_cause TEXT", "speech TEXT"],
  approvals: ["kind TEXT NOT NULL DEFAULT 'approval'", "answer TEXT"],
  records: ["rating INTEGER"],
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
  /** Only daemon-owned artifact copies are removed; a task's cwd is never deleted here. */
  readonly artifactsDir?: string;
  readonly now?: () => number;
};

export class Store {
  private readonly db: DatabaseSync;
  private readonly tasksDir: string | undefined;
  private readonly threadsDir: string;
  private readonly artifactsDir: string | undefined;
  private readonly now: () => number;

  constructor(opts: StoreOptions) {
    if (opts.dbPath !== ":memory:") mkdirSync(dirname(opts.dbPath), { recursive: true });
    if (opts.tasksDir) mkdirSync(opts.tasksDir, { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec(SCHEMA);
    migrate(this.db);
    const root = (path: string): string => { mkdirSync(path, { recursive: true }); return realpathSync(path); };
    this.tasksDir = opts.tasksDir ? root(opts.tasksDir) : undefined;
    this.threadsDir = root(opts.threadsDir ?? join(tmpdir(), `agentswitch-threads-${process.pid}`));
    this.artifactsDir = opts.artifactsDir ? root(opts.artifactsDir) : undefined;
    this.now = opts.now ?? Date.now;
  }

  createTask(input: NewTask): Task {
    const ts = this.now();
    const id = randomUUID().slice(0, 8);
    this.db.prepare(
      `INSERT INTO tasks (id, created_at, updated_at, status, task, cwd, pin, needs_browser, ephemeral, parent_id, attachments, thread_id, exclude, handoff_from, approval_policy) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ts, ts, input.task, input.cwd, input.pin ? JSON.stringify(input.pin) : null, input.needsBrowser ? 1 : 0, input.ephemeral ? 1 : 0, input.parentId ?? null, JSON.stringify(input.attachments ?? []),
      input.threadId ?? null, JSON.stringify(input.exclude ?? []), input.handoffFrom ? JSON.stringify(input.handoffFrom) : null, input.approval ? JSON.stringify(input.approval) : null);
    if (input.threadId) this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(ts, input.threadId);
    return this.getTask(id)!;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : undefined;
  }

  listTasks(limit = DEFAULT_LIST_LIMIT): Task[] {
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
      ? this.db.prepare("SELECT * FROM threads WHERE status = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(opts.status, opts.limit ?? DEFAULT_LIST_LIMIT)
      : this.db.prepare("SELECT * FROM threads ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(opts.limit ?? DEFAULT_LIST_LIMIT);
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

  /** Delete a task and its owned data. Remaining thread tasks keep their records but start with fresh context. */
  deleteTask(id: string): boolean {
    const task = this.getTask(id);
    if (!task) return false;
    const thread = task.threadId ? this.getThread(task.threadId) : undefined;
    const siblings = task.threadId ? this.tasksInThread(task.threadId) : [task];
    this.assertIdle(siblings);
    if (thread && siblings.length === 1) return this.deleteThread(thread.id);
    const files = this.deletionFiles([task], thread);
    this.removeOwnedFiles(files);
    this.transaction(() => {
      this.deleteTaskRows([task]);
      if (thread) this.resetThreadContext(thread.id);
    });
    if (thread) mkdirSync(join(this.threadsDir, thread.id), { recursive: true, mode: 0o700 });
    return true;
  }

  /** Delete the thread, every task, its logs and daemon-owned files together; never remove the work directory. */
  deleteThread(id: string): boolean {
    const t = this.getThread(id);
    if (!t) return false;
    const tasks = this.tasksInThread(id);
    this.assertIdle(tasks);
    this.removeOwnedFiles(this.deletionFiles(tasks, t));
    this.transaction(() => {
      this.deleteTaskRows(tasks);
      this.db.prepare("DELETE FROM thread_events WHERE thread_id = ?").run(id);
      this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    });
    return true;
  }

  private assertIdle(tasks: readonly Task[]): void {
    const active = tasks.find((task) => !TERMINAL.has(task.status));
    if (active) throw new Error(`task ${active.id} is still ${active.status}; cancel it first`);
  }

  private transaction(run: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { run(); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private deleteTaskRows(tasks: readonly Task[]): void {
    for (const task of tasks) {
      this.db.prepare("UPDATE tasks SET parent_id = NULL WHERE parent_id = ?").run(task.id);
      this.db.prepare("UPDATE tasks SET handoff_from = NULL WHERE json_extract(handoff_from, '$.taskId') = ?").run(task.id);
      // Handoff metadata can live in another thread; remove only explicit references, never another task.
      this.db.prepare("DELETE FROM thread_events WHERE json_extract(payload, '$.taskId') = ? OR json_extract(payload, '$.from.taskId') = ? OR json_extract(payload, '$.to.taskId') = ?").run(task.id, task.id, task.id);
      for (const table of ["events", "approvals", "records"]) this.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(task.id);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    }
  }

  private resetThreadContext(id: string): void {
    // Summaries and native sessions blend all prior tasks. They cannot be redacted reliably, so discard them.
    this.db.prepare("DELETE FROM thread_events WHERE thread_id = ? AND type IN ('summary', 'session', 'title', 'handoff')").run(id);
    this.db.prepare("UPDATE threads SET title = NULL, home = ?, updated_at = ? WHERE id = ?").run(join(this.threadsDir, id), this.now(), id);
  }

  private deletionFiles(tasks: readonly Task[], thread?: Thread): string[] {
    const files: string[] = [];
    const child = (root: string, id: string, suffix = ""): string => {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("unsafe managed file id");
      // Roots are resolved at startup; a replaced root must not redirect deletion into a user's directory.
      if (!existsSync(root) || realpathSync(root) !== root) throw new Error("managed file root changed; refusing deletion");
      return join(root, id + suffix);
    };
    for (const task of tasks) {
      if (this.tasksDir) files.push(child(this.tasksDir, task.id, ".jsonl"));
      if (this.artifactsDir) files.push(child(this.artifactsDir, task.id));
    }
    if (thread) files.push(child(this.threadsDir, thread.id));  // never trust a persisted home path for deletion
    const cwds = (this.db.prepare("SELECT DISTINCT cwd FROM tasks").all() as { cwd: string }[]).map(({ cwd }) => existsSync(cwd) ? realpathSync(cwd) : resolve(cwd));
    return files.filter((file) => {
      // rm removes a final-component symlink itself, without following its target.
      if (existsSync(file) && lstatSync(file).isSymbolicLink()) return true;
      if (cwds.some((cwd) => cwd === file || cwd.startsWith(file + sep))) throw new Error("managed files overlap a task working directory; refusing deletion");
      return true;
    });
  }

  private removeOwnedFiles(files: readonly string[]): void {
    for (const file of files) rmSync(file, { recursive: true, force: true });
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
    if (r.rating !== null) this.db.prepare("UPDATE records SET rating = ? WHERE task_id = ?").run(r.rating, r.taskId);
  }

  /** 👍 / 👎 on a finished task: kept on the task row and on its track record. */
  rateTask(taskId: string, rating: 1 | -1 | null): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    this.updateTask(taskId, { rating });
    this.db.prepare("UPDATE records SET rating = ? WHERE task_id = ?").run(rating, taskId);
    return true;
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
      rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
    }));
  }

  threadEvents(threadId: string): ThreadEvent[] {
    const rows = this.db.prepare("SELECT * FROM thread_events WHERE thread_id = ? ORDER BY seq").all(threadId) as Row[];
    return rows.map((r) => ({ threadId: String(r.thread_id), seq: Number(r.seq), ts: Number(r.ts), type: String(r.type) as ThreadEventType, payload: JSON.parse(String(r.payload)) }));
  }

  updateTask(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Task {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`task ${id} not found`);
    // A late async callback cannot revive a task or overwrite its terminal result.
    if (patch.status && TERMINAL.has(existing.status)) return existing;
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [this.now()];
    const map: Record<string, (v: unknown) => unknown> = {
      status: (v) => v, harness: (v) => v, model: (v) => v, effort: (v) => v, brief: (v) => v, result: (v) => v, error: (v) => v,
      decision: (v) => (v === null ? null : JSON.stringify(v)), attempts: (v) => JSON.stringify(v), routerAsks: (v) => v,
      threadId: (v) => v, cwd: (v) => v, ephemeral: (v) => (v ? 1 : 0), spoken: (v) => v, speech: (v) => v, routeLogId: (v) => v, rating: (v) => v, blockCause: (v) => v,
    };
    const columns: Record<string, string> = { routerAsks: "router_asks", threadId: "thread_id", routeLogId: "route_log_id", blockCause: "block_cause" };
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

  createApproval(taskId: string, action: string, evidence: string, kind: ApprovalKind = "approval"): Approval {
    const id = randomUUID();   // unguessable: an approval id is the capability to answer it
    this.db.prepare("INSERT INTO approvals (id, task_id, created_at, action, evidence, status, kind) VALUES (?, ?, ?, ?, ?, 'pending', ?)").run(id, taskId, this.now(), action, evidence, kind);
    return this.getApproval(id)!;
  }

  /** A question answered with text counts as allowed, with the answer stored. */
  answerApproval(id: string, text: string): Approval | undefined {
    this.db.prepare("UPDATE approvals SET status = 'allowed', resolved_at = ?, answer = ? WHERE id = ? AND status = 'pending' AND kind = 'question'").run(this.now(), text, id);
    return this.getApproval(id);
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

  // ---- paired devices (app-v0 §2) ----

  createDevice(input: { readonly name: string; readonly platform: string; readonly tokenHash: string }): Device {
    const id = randomUUID().slice(0, 8);
    this.db.prepare("INSERT INTO devices (id, name, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, input.name, input.platform, input.tokenHash, this.now());
    return this.getDevice(id)!;
  }

  getDevice(id: string): Device | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return r ? toDevice(r) : undefined;
  }

  listDevices(): Device[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY created_at DESC, id").all() as Row[]).map(toDevice);
  }

  /** Every device's token hash, revoked ones included, for the caller's constant-time comparison. */
  deviceTokenHashes(): { readonly id: string; readonly tokenHash: string }[] {
    return (this.db.prepare("SELECT id, token_hash FROM devices").all() as Row[]).map((r) => ({ id: String(r.id), tokenHash: String(r.token_hash) }));
  }

  /** Revocation is permanent; revoking twice keeps the first time. Undefined when there is no such device. */
  revokeDevice(id: string): Device | undefined {
    this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(this.now(), id);
    return this.getDevice(id);
  }

  touchDevice(id: string, ts: number = this.now()): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(ts, id);
  }

  close(): void {
    this.db.close();
  }
}

function toDevice(r: Row): Device {
  return {
    id: String(r.id),
    name: String(r.name),
    platform: String(r.platform),
    createdAt: Number(r.created_at),
    lastSeenAt: r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
  };
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
    approvalPolicy: r.approval_policy ? JSON.parse(String(r.approval_policy)) : null,
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
    speech: (r.speech as string | null) ?? null,
    routeLogId: r.route_log_id === null || r.route_log_id === undefined ? null : Number(r.route_log_id),
    rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
    blockCause: (r.block_cause as BlockCause | null) ?? null,
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
    kind: (String(r.kind ?? "approval") as ApprovalKind),
    action: String(r.action),
    evidence: String(r.evidence),
    status: String(r.status) as ApprovalStatus,
    resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
    answer: (r.answer as string | null) ?? null,
  };
}
