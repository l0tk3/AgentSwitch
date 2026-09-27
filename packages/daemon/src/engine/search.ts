/** Searching past tasks (docs/control-v0.md §4): what was asked, the result, the error, the spoken summary, the thread
 *  title and what the executor said, in an FTS5 trigram index (substrings, Chinese included). Kept up to date lazily:
 *  each search first indexes the tasks updated since the last one. Queries under three characters (too short for
 *  trigrams, e.g. 登录) fall back to a substring scan of the same text. */

import type { DatabaseSync } from "node:sqlite";

export const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS task_search USING fts5(task_id UNINDEXED, body, tokenize='trigram');
CREATE TABLE IF NOT EXISTS task_search_state (id INTEGER PRIMARY KEY CHECK (id = 1), indexed_at INTEGER NOT NULL);`;

const BODY_CHARS = 20_000;
const SNIPPET_CONTEXT = 24;
export const HIT_OPEN = "⟦";
export const HIT_CLOSE = "⟧";

export type SearchHit = { readonly taskId: string; readonly title: string; readonly snippet: string; readonly status: string; readonly updatedAt: number };

type Row = Record<string, unknown>;

/** Indexes every task updated since the last call (all of them the first time). */
export function refreshSearch(db: DatabaseSync): void {
  const state = db.prepare("SELECT indexed_at FROM task_search_state WHERE id = 1").get() as { indexed_at: number } | undefined;
  const since = state?.indexed_at ?? -1;
  const tasks = db.prepare("SELECT t.id, t.task, t.result, t.error, t.speech, t.spoken, t.updated_at, th.title FROM tasks t LEFT JOIN threads th ON th.id = t.thread_id WHERE t.updated_at > ? ORDER BY t.updated_at").all(since) as Row[];
  if (!tasks.length) return;
  const texts = db.prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'text' ORDER BY seq");
  const remove = db.prepare("DELETE FROM task_search WHERE task_id = ?");
  const insert = db.prepare("INSERT INTO task_search (task_id, body) VALUES (?, ?)");
  let newest = since;
  db.exec("BEGIN");
  try {
    for (const t of tasks) {
      const said = (texts.all(String(t.id)) as { payload: string }[]).map((e) => textOf(e.payload)).filter(Boolean);
      const body = [t.title, t.task, t.result, t.error, t.speech, t.spoken, ...said].filter((v) => typeof v === "string" && v.trim()).join("\n").slice(0, BODY_CHARS);
      remove.run(String(t.id));
      insert.run(String(t.id), body);
      newest = Math.max(newest, Number(t.updated_at));
    }
    db.prepare("INSERT INTO task_search_state (id, indexed_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET indexed_at = excluded.indexed_at").run(newest);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** A deleted task leaves the index with it. */
export function forgetSearch(db: DatabaseSync, taskId: string): void {
  db.prepare("DELETE FROM task_search WHERE task_id = ?").run(taskId);
}

export function searchTasks(db: DatabaseSync, query: string, limit: number): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  refreshSearch(db);
  const rows = (q.length >= 3
    ? db.prepare("SELECT task_id, body FROM task_search WHERE task_search MATCH ? ORDER BY bm25(task_search) LIMIT ?").all(`"${q.replace(/"/g, "\"\"")}"`, limit)
    : db.prepare("SELECT task_id, body FROM task_search WHERE body LIKE ? ESCAPE '\\' LIMIT ?").all(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit)) as Row[];
  const info = db.prepare("SELECT t.task, t.status, t.updated_at, th.title FROM tasks t LEFT JOIN threads th ON th.id = t.thread_id WHERE t.id = ?");
  return rows.flatMap((r) => {
    const t = info.get(String(r.task_id)) as Row | undefined;
    if (!t) return [];
    const title = (typeof t.title === "string" && t.title) || oneLine(String(t.task), 40);
    return [{ taskId: String(r.task_id), title, snippet: snippet(String(r.body), q), status: String(t.status), updatedAt: Number(t.updated_at) }];
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The first hit with a little text on either side, the hit marked. */
export function snippet(body: string, query: string): string {
  const at = body.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return oneLine(body, SNIPPET_CONTEXT * 2);
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(body.length, at + query.length + SNIPPET_CONTEXT);
  const text = `${start > 0 ? "…" : ""}${body.slice(start, at)}${HIT_OPEN}${body.slice(at, at + query.length)}${HIT_CLOSE}${body.slice(at + query.length, end)}${end < body.length ? "…" : ""}`;
  return text.replace(/\s+/g, " ");
}

function textOf(payload: string): string {
  try { const p = JSON.parse(payload) as { text?: unknown }; return typeof p.text === "string" ? p.text : ""; } catch { return ""; }
}

function oneLine(text: string, limit: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}
