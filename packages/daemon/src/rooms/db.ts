/** Where the rooms are kept (2026-11-24, user: 能不能用一个高效的数据库存储): one SQLite file, `rooms.db`. A room's
 *  state (its seats, tasks, notes, receipts) is one row, written in place; what was said is a table, one row a
 *  message, indexed by room and number and by task, with a full-text index of its words (trigram: Chinese reads
 *  as it is typed, three characters and up). Messages are not all held in memory any more: a room is asked for what
 *  it needs. The files of before (`rooms/<id>.json`, `rooms/<id>.jsonl`) are read in once and the folder kept aside
 *  as `rooms-before-db`. */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  room TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, sender TEXT NOT NULL, task INTEGER,
  to_you INTEGER NOT NULL, to_others INTEGER NOT NULL, body TEXT NOT NULL, words TEXT NOT NULL,
  PRIMARY KEY (room, seq)
);
CREATE INDEX IF NOT EXISTS messages_task ON messages (room, task, seq);
CREATE TABLE IF NOT EXISTS secrets (room TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (room, id));
CREATE TABLE IF NOT EXISTS avatars (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_words USING fts5(words, room UNINDEXED, seq UNINDEXED, tokenize = 'trigram');
`;

/** One message as the store has it; `body` is its JSON. */
export type StoredMessage = { readonly seq: number; readonly body: string };

export class RoomDb {
  private readonly db: DatabaseSync;
  private readonly q: Record<string, StatementSync>;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    const p = (sql: string): StatementSync => this.db.prepare(sql);
    this.q = {
      rooms: p("SELECT state FROM rooms"),
      putRoom: p("INSERT INTO rooms (id, state) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state"),
      dropRoom: p("DELETE FROM rooms WHERE id = ?"),
      dropMessages: p("DELETE FROM messages WHERE room = ?"),
      dropWords: p("DELETE FROM messages_words WHERE room = ?"),
      add: p("INSERT OR REPLACE INTO messages (room, seq, at, sender, task, to_you, to_others, body, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      addWords: p("INSERT INTO messages_words (words, room, seq) VALUES (?, ?, ?)"),
      dropWordsOf: p("DELETE FROM messages_words WHERE room = ? AND seq = ?"),
      last: p("SELECT seq, body FROM messages WHERE room = ? ORDER BY seq DESC LIMIT 1"),
      tail: p("SELECT seq, body FROM messages WHERE room = ? ORDER BY seq DESC LIMIT ?"),
      after: p("SELECT seq, body FROM messages WHERE room = ? AND seq > ? ORDER BY seq LIMIT ?"),
      before: p("SELECT seq, body FROM messages WHERE room = ? AND seq < ? ORDER BY seq DESC LIMIT ?"),
      all: p("SELECT seq, body FROM messages WHERE room = ? ORDER BY seq"),
      taskTail: p("SELECT seq, body FROM messages WHERE room = ? AND task = ? ORDER BY seq DESC LIMIT ?"),
      unread: p("SELECT COUNT(*) AS n, MAX(to_you) AS you FROM messages WHERE room = ? AND seq > ? AND sender != 'you'"),
      lastFromYou: p("SELECT MAX(seq) AS seq FROM messages WHERE room = ? AND sender = 'you' AND seq > ?"),
      rounds: p("SELECT COUNT(*) AS n FROM messages WHERE room = ? AND seq > ? AND to_others = 1"),
      search: p("SELECT m.seq AS seq, m.body AS body FROM messages_words w JOIN messages m ON m.room = w.room AND m.seq = w.seq WHERE messages_words MATCH ? AND w.room = ? ORDER BY m.seq DESC LIMIT ?"),
      like: p("SELECT seq, body FROM messages WHERE room = ? AND words LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?"),
      count: p("SELECT COUNT(*) AS n FROM messages WHERE room = ?"),
      secrets: p("SELECT body FROM secrets WHERE room = ? ORDER BY at, id"),
      putSecret: p("INSERT INTO secrets (room, id, at, body) VALUES (?, ?, ?, ?) ON CONFLICT (room, id) DO UPDATE SET body = excluded.body"),
      dropSecret: p("DELETE FROM secrets WHERE room = ? AND id = ?"),
      dropSecrets: p("DELETE FROM secrets WHERE room = ?"),
      avatar: p("SELECT value FROM avatars WHERE key = ?"),
      putAvatar: p("INSERT INTO avatars (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
      byTask: p("SELECT task, COUNT(*) AS n FROM messages WHERE room = ? AND seq > ? AND task IS NOT NULL GROUP BY task"),
    };
  }

  /** In one transaction: all of it or none. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try { const out = fn(); this.db.exec("COMMIT"); return out; } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  rooms(): string[] { return (this.q.rooms!.all() as { state: string }[]).map((r) => r.state); }
  putRoom(id: string, state: string): void { this.q.putRoom!.run(id, state); }
  dropRoom(id: string): void { this.tx(() => { this.q.dropRoom!.run(id); this.q.dropMessages!.run(id); this.q.dropWords!.run(id); this.q.dropSecrets!.run(id); }); }

  add(room: string, m: { readonly seq: number; readonly at: number; readonly from: string; readonly task?: number; readonly to: readonly string[]; readonly text: string }, body: string): void {
    this.q.add!.run(room, m.seq, m.at, m.from, m.task ?? null, m.to.includes("you") ? 1 : 0, m.to.some((h) => h !== "you") ? 1 : 0, body, m.text);
    this.q.dropWordsOf!.run(room, m.seq);
    if (m.text) this.q.addWords!.run(m.text, room, m.seq);
  }

  last(room: string): StoredMessage | null { return (this.q.last!.get(room) as StoredMessage | undefined) ?? null; }
  /** The last `n`, oldest first. */
  tail(room: string, n: number): StoredMessage[] { return (this.q.tail!.all(room, n) as StoredMessage[]).reverse(); }
  after(room: string, seq: number, n: number): StoredMessage[] { return this.q.after!.all(room, seq, n) as StoredMessage[]; }
  /** The `n` before `seq`, oldest first. */
  before(room: string, seq: number, n: number): StoredMessage[] { return (this.q.before!.all(room, seq, n) as StoredMessage[]).reverse(); }
  all(room: string): StoredMessage[] { return this.q.all!.all(room) as StoredMessage[]; }
  /** The last `n` about a task, oldest first. */
  taskTail(room: string, task: number, n: number): StoredMessage[] { return (this.q.taskTail!.all(room, task, n) as StoredMessage[]).reverse(); }
  unread(room: string, after: number): { count: number; forYou: boolean } {
    const r = this.q.unread!.get(room, after) as { n: number; you: number | null };
    return { count: r.n, forYou: r.you === 1 };
  }
  lastFromYou(room: string, after: number): number | null { return (this.q.lastFromYou!.get(room, after) as { seq: number | null }).seq; }
  rounds(room: string, after: number): number { return (this.q.rounds!.get(room, after) as { n: number }).n; }
  count(room: string): number { return (this.q.count!.get(room) as { n: number }).n; }
  /** How many messages after `seq` are about each task. */
  byTask(room: string, after: number): Map<number, number> {
    return new Map((this.q.byTask!.all(room, after) as { task: number; n: number }[]).map((r) => [r.task, r.n]));
  }

  /** The newest messages whose words contain `text`: by the full-text index for three characters and more, by a
   *  plain scan below that (the trigram index has nothing shorter). */
  search(room: string, text: string, n: number): StoredMessage[] {
    const t = text.trim();
    if (!t) return [];
    if ([...t].length >= 3) return this.q.search!.all(`"${t.replace(/"/g, '""')}"`, room, n) as StoredMessage[];
    return this.q.like!.all(room, `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, n) as StoredMessage[];
  }

  /** A room's sealed secrets (secrets.ts), as JSON. */
  secrets(room: string): string[] { return (this.q.secrets!.all(room) as { body: string }[]).map((r) => r.body); }
  putSecret(room: string, id: string, at: number, body: string): void { this.q.putSecret!.run(room, id, at, body); }
  dropSecret(room: string, id: string): boolean { return Number(this.q.dropSecret!.run(room, id).changes) > 0; }

  /** A session's avatar (avatars.ts), by one of its keys. */
  avatar(key: string): string | null { return (this.q.avatar!.get(key) as { value: string } | undefined)?.value ?? null; }
  putAvatar(key: string, value: string): void { this.q.putAvatar!.run(key, value); }

  close(): void { this.db.close(); }
}

/** The rooms kept as files before (`<home>/rooms/`), read into the database once: their states and every message.
 *  The folder is then moved aside, not deleted. Returns how many rooms came in. */
export function importFiles(db: RoomDb, dir: string, parse: { room: (raw: unknown) => { id: string } | null; message: (raw: unknown) => { seq: number; at: number; from: string; task?: number; to: readonly string[]; text: string } | null }): number {
  if (!existsSync(dir)) return 0;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return 0; }
  let n = 0;
  db.tx(() => {
    for (const name of names.filter((f) => f.endsWith(".json"))) {
      let room: { id: string } | null = null;
      try { room = parse.room(JSON.parse(readFileSync(join(dir, name), "utf8"))); } catch { /* not a room */ }
      if (!room || `${room.id}.json` !== name) continue;
      db.putRoom(room.id, JSON.stringify(room));
      n++;
      let text = "";
      try { text = readFileSync(join(dir, `${room.id}.jsonl`), "utf8"); } catch { /* nothing said */ }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try { const m = parse.message(JSON.parse(line)); if (m) db.add(room.id, m, JSON.stringify(m)); } catch { /* a torn last line */ }
      }
    }
  });
  let aside = `${dir}-before-db`, i = 2;
  while (existsSync(aside)) aside = `${dir}-before-db-${i++}`;
  try { renameSync(dir, aside); } catch { /* left where it is: it is not read again, the database has it */ }
  return n;
}
