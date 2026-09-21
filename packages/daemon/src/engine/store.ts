/** SQLite persistence for tasks, events and approvals, plus a JSONL mirror of events per task. */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at DESC);`;

type Row = Record<string, unknown>;

/** Columns added after the first release; CREATE TABLE IF NOT EXISTS does not add them to an existing table. */
const ADDED_COLUMNS: Record<string, string[]> = {
  tasks: ["ephemeral INTEGER NOT NULL DEFAULT 0", "parent_id TEXT", "attachments TEXT NOT NULL DEFAULT '[]'"],
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

export type StoreOptions = { readonly dbPath: string; readonly tasksDir?: string; readonly now?: () => number };

export class Store {
  private readonly db: DatabaseSync;
  private readonly tasksDir: string | undefined;
  private readonly now: () => number;

  constructor(opts: StoreOptions) {
    if (opts.dbPath !== ":memory:") mkdirSync(dirname(opts.dbPath), { recursive: true });
    if (opts.tasksDir) mkdirSync(opts.tasksDir, { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec(SCHEMA);
    migrate(this.db);
    this.tasksDir = opts.tasksDir;
    this.now = opts.now ?? Date.now;
  }

  createTask(input: NewTask): Task {
    const ts = this.now();
    const id = randomUUID().slice(0, 8);
    this.db.prepare(
      `INSERT INTO tasks (id, created_at, updated_at, status, task, cwd, pin, needs_browser, ephemeral, parent_id, attachments) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ts, ts, input.task, input.cwd, input.pin ? JSON.stringify(input.pin) : null, input.needsBrowser ? 1 : 0, input.ephemeral ? 1 : 0, input.parentId ?? null, JSON.stringify(input.attachments ?? []));
    return this.getTask(id)!;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : undefined;
  }

  listTasks(limit = 50): Task[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Row[]).map(toTask);
  }

  updateTask(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Task {
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [this.now()];
    const map: Record<string, (v: unknown) => unknown> = {
      status: (v) => v, harness: (v) => v, model: (v) => v, effort: (v) => v, brief: (v) => v, result: (v) => v, error: (v) => v,
      decision: (v) => (v === null ? null : JSON.stringify(v)), attempts: (v) => JSON.stringify(v), routerAsks: (v) => v,
    };
    const columns: Record<string, string> = { routerAsks: "router_asks" };
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
    harness: (r.harness as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    brief: (r.brief as string | null) ?? null,
    decision: r.decision ? JSON.parse(String(r.decision)) : null,
    attempts: JSON.parse(String(r.attempts ?? "[]")),
    routerAsks: Number(r.router_asks ?? 0),
    result: (r.result as string | null) ?? null,
    error: (r.error as string | null) ?? null,
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
