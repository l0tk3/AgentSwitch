/** The assistant conversation (assistant-v0 §1.1): one conversation for the one user, in its own sqlite file next to
 *  the task store. Only sealed text is ever stored. A user message carries the client's id so a resend is answered
 *  from here instead of acting twice. */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AssistantKind = "message" | "reply" | "task" | "status" | "cancel" | "fallback" | "notice";
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
CREATE INDEX IF NOT EXISTS messages_reply ON messages(reply_to);`;

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

  close(): void { this.db.close(); }
}

function toMessage(r: Row): AssistantMessage {
  let taskIds: string[] = [];
  try { taskIds = JSON.parse(String(r.task_ids)) as string[]; } catch { taskIds = []; }
  return {
    seq: Number(r.seq), ts: Number(r.ts), role: r.role === "user" ? "user" : "assistant", text: String(r.text),
    kind: String(r.kind) as AssistantKind, taskIds, clientId: r.client_id === null ? null : String(r.client_id),
    replyTo: r.reply_to === null ? null : Number(r.reply_to),
  };
}
