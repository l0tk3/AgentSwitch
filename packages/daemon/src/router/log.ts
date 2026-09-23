/** routing_log: every decision, what the floor did with it, and (later) how it went. */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RouteResult } from "./route.js";

export type LogEntry = {
  readonly id: number;
  readonly ts: number;
  readonly taskHash: string;
  readonly taskId: string | null;
  readonly cwd: string;
  readonly source: string;
  readonly harness: string | null;
  readonly model: string | null;
  readonly chosen: string | null;
  readonly decision: string | null;
  readonly notes: string;
  readonly routerError: string | null;
  readonly routerMs: number;
  readonly outcome: string | null;
  readonly rating: number | null;
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS routing_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  task_hash TEXT NOT NULL,
  cwd TEXT NOT NULL,
  source TEXT NOT NULL,
  harness TEXT,
  model TEXT,
  chosen TEXT,
  decision TEXT,
  notes TEXT NOT NULL,
  router_error TEXT,
  router_ms INTEGER NOT NULL,
  outcome TEXT,
  rating INTEGER
)`;

export function taskHash(task: string): string {
  return createHash("sha256").update(task).digest("hex").slice(0, 16);
}

export class RoutingLog {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    const cols = new Set((this.db.prepare("PRAGMA table_info(routing_log)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("rating")) this.db.exec("ALTER TABLE routing_log ADD COLUMN rating INTEGER");
    if (!cols.has("task_id")) this.db.exec("ALTER TABLE routing_log ADD COLUMN task_id TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS routing_log_task ON routing_log(task_id)");
  }

  record(task: string, cwd: string, result: RouteResult, ts = Date.now(), taskId?: string): number {
    const v = result.verdict;
    const stmt = this.db.prepare(
      `INSERT INTO routing_log (ts, task_hash, task_id, cwd, source, harness, model, chosen, decision, notes, router_error, router_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      ts,
      taskHash(task),
      taskId ?? null,
      cwd,
      result.source,
      v.ok ? v.harness : null,
      v.ok ? v.model : null,
      v.ok ? v.chosen : null,
      result.decision ? JSON.stringify(result.decision) : null,
      v.notes.join(" | "),
      result.routerError,
      result.routerMs,
    );
    return Number(info.lastInsertRowid);
  }

  /** How the dispatch this row decided actually ended (router-v0 §7): "done", "failed:refusal", "cancelled"… */
  setOutcome(id: number, outcome: string): void {
    this.db.prepare("UPDATE routing_log SET outcome = ? WHERE id = ?").run(outcome, id);
  }

  setRating(id: number, rating: number | null): void {
    this.db.prepare("UPDATE routing_log SET rating = ? WHERE id = ?").run(rating, id);
  }

  /** Delete exact ownership only. Equal task text is not evidence that a routing decision belongs to this task. */
  deleteTask(taskId: string, legacyLogId: number | null = null): void {
    this.db.prepare("DELETE FROM routing_log WHERE task_id = ? OR (id = ? AND task_id IS NULL)").run(taskId, legacyLogId);
  }

  recent(limit = 50): LogEntry[] {
    const rows = this.db.prepare("SELECT * FROM routing_log ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      taskHash: String(r.task_hash),
      taskId: (r.task_id as string | null) ?? null,
      cwd: String(r.cwd),
      source: String(r.source),
      harness: (r.harness as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      chosen: (r.chosen as string | null) ?? null,
      decision: (r.decision as string | null) ?? null,
      notes: String(r.notes),
      routerError: (r.router_error as string | null) ?? null,
      routerMs: Number(r.router_ms),
      outcome: (r.outcome as string | null) ?? null,
      rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
    }));
  }

  close(): void {
    this.db.close();
  }
}
