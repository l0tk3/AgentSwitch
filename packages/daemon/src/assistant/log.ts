/** The assistant conversation (assistant-v0 §1.1): one conversation for the one user, in its own sqlite file next to
 *  the task store. Only sealed text is ever stored. A user message carries the client's id so a resend is answered
 *  from here instead of acting twice. The watches (§1 `watch`, step 3) live in the same file: a restart keeps them. */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** `notice`: a task ended; `waiting`: a task waits for the user (the phone shows the question in the task's card and
 *  hides this line while it is open); `progress`: a watched task's line; `watch`: the answer that set one. */
export type AssistantKind = "message" | "reply" | "task" | "status" | "cancel" | "fallback" | "notice" | "waiting" | "watch" | "progress";

/** A task the user asked to hear about every `everyMs` until it ends. */
export type Watch = { readonly taskId: string; readonly everyMs: number; readonly nextAt: number };
export type AssistantMessage = {
  readonly seq: number;
  readonly ts: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly kind: AssistantKind;
  readonly taskIds: readonly string[];
  readonly clientId: string | null;
  /** On an assistant message: the user message it answers. */
  readonly replyTo: number | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL,
  task_ids TEXT NOT NULL DEFAULT '[]', client_id TEXT UNIQUE, reply_to INTEGER
);
CREATE INDEX IF NOT EXISTS messages_reply ON messages(reply_to);
CREATE TABLE IF NOT EXISTS watches (task_id TEXT PRIMARY KEY, every_ms INTEGER NOT NULL, next_at INTEGER NOT NULL);`;

/** Kept messages; older ones are dropped (the tasks themselves stay in the task store). */
export const KEPT_MESSAGES = 1000;

type Row = Record<string, unknown>;

export class AssistantLog {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  append(message: Omit<AssistantMessage, "seq" | "ts">): AssistantMessage {
    const ts = this.now();
    const r = this.db.prepare("INSERT INTO messages (ts, role, text, kind, task_ids, client_id, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ts, message.role, message.text, message.kind, JSON.stringify(message.taskIds), message.clientId, message.replyTo);
    this.db.prepare("DELETE FROM messages WHERE seq <= ?").run(Number(r.lastInsertRowid) - KEPT_MESSAGES);
    return { ...message, seq: Number(r.lastInsertRowid), ts };
  }

  /** The user message sent with this client id and the answer to it, if any. */
  byClientId(clientId: string): { user: AssistantMessage; assistant: AssistantMessage | null } | null {
    const user = this.db.prepare("SELECT * FROM messages WHERE client_id = ?").get(clientId) as Row | undefined;
    if (!user) return null;
    const answer = this.db.prepare("SELECT * FROM messages WHERE reply_to = ? ORDER BY seq LIMIT 1").get(Number(user.seq)) as Row | undefined;
    return { user: toMessage(user), assistant: answer ? toMessage(answer) : null };
  }

  after(seq: number, limit: number): AssistantMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as Row[]).map(toMessage);
  }

  /** The last `limit` messages, oldest first, before `beforeSeq` if given. */
  recent(limit: number, beforeSeq = Number.MAX_SAFE_INTEGER): AssistantMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?").all(beforeSeq, limit) as Row[]).map(toMessage).reverse();
  }

  /** Deleting tasks takes the conversation about them along (threads-v0 手动删除): every line that names one of them —
   *  the reply that created it, its end, question and progress lines, a status or cancel answer — and the user message
   *  such a reply answers; its watch too. Lines about no task (small talk, update notices) stay. Returns the lines gone. */
  forgetTasks(ids: readonly string[]): number {
    if (!ids.length) return 0;
    const gone = new Set(ids);
    const drop = new Set<number>();
    for (const r of this.db.prepare("SELECT seq, task_ids, reply_to FROM messages WHERE task_ids != '[]'").all() as Row[]) {
      if (!parseIds(r.task_ids).some((id) => gone.has(id))) continue;
      drop.add(Number(r.seq));
      if (r.reply_to !== null) drop.add(Number(r.reply_to));
    }
    const del = this.db.prepare("DELETE FROM messages WHERE seq = ?");
    const unwatch = this.db.prepare("DELETE FROM watches WHERE task_id = ?");
    this.db.exec("BEGIN");
    try {
      for (const seq of drop) del.run(seq);
      for (const id of gone) unwatch.run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return drop.size;
  }

  /** Every task a line names (to find the ones deleted while this log was not told). */
  taskIds(): Set<string> {
    const ids = new Set<string>();
    for (const r of this.db.prepare("SELECT task_ids FROM messages WHERE task_ids != '[]'").all() as Row[]) {
      for (const id of parseIds(r.task_ids)) ids.add(id);
    }
    for (const w of this.watches()) ids.add(w.taskId);
    return ids;
  }

  /** Starts or changes the watch on a task; the first line is due one interval from now. */
  setWatch(taskId: string, everyMs: number): Watch {
    const w: Watch = { taskId, everyMs, nextAt: this.now() + everyMs };
    this.db.prepare("INSERT INTO watches (task_id, every_ms, next_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET every_ms = excluded.every_ms, next_at = excluded.next_at")
      .run(w.taskId, w.everyMs, w.nextAt);
    return w;
  }

  removeWatch(taskId: string): boolean {
    return Number(this.db.prepare("DELETE FROM watches WHERE task_id = ?").run(taskId).changes) > 0;
  }

  watches(): Watch[] {
    return (this.db.prepare("SELECT * FROM watches ORDER BY next_at").all() as Row[]).map(toWatch);
  }

  /** Watches whose line is due at `now`, each moved on to its next time. */
  takeDue(now: number): Watch[] {
    const due = (this.db.prepare("SELECT * FROM watches WHERE next_at <= ? ORDER BY next_at").all(now) as Row[]).map(toWatch);
    for (const w of due) this.db.prepare("UPDATE watches SET next_at = ? WHERE task_id = ?").run(now + w.everyMs, w.taskId);
    return due;
  }

  close(): void { this.db.close(); }
}

function toWatch(r: Row): Watch {
  return { taskId: String(r.task_id), everyMs: Number(r.every_ms), nextAt: Number(r.next_at) };
}

function parseIds(value: unknown): string[] {
  try {
    const ids = JSON.parse(String(value)) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toMessage(r: Row): AssistantMessage {
  return {
    seq: Number(r.seq), ts: Number(r.ts), role: r.role === "user" ? "user" : "assistant", text: String(r.text),
    kind: String(r.kind) as AssistantKind, taskIds: parseIds(r.task_ids), clientId: r.client_id === null ? null : String(r.client_id),
    replyTo: r.reply_to === null ? null : Number(r.reply_to),
  };
}
