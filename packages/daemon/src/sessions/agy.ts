/** Antigravity CLI conversations (`agy` 1.5.17, 2026-11-26, user #508). Its home is `~/.gemini/antigravity-cli`
 *  (`agyHome`): an index of every conversation in `conversation_summaries.db` (SQLite, written while it runs: opened
 *  read-only each time), and what was said as lines of JSON in `brain/<id>/.system_generated/logs/transcript.jsonl`
 *  — `{step_index, source, type, status, created_at, content, model?}`, `type` USER_INPUT (the prompt wrapped in
 *  `<USER_REQUEST>…</USER_REQUEST>` and followed by what the program adds), PLANNER_RESPONSE (the reply), and a
 *  step's own type for a tool. The conversation itself is `conversations/<id>.db` (protobuf: not read here).
 *
 *  A conversation belongs to the folders it was started in (`workspace_uris`, `file://` addresses); the first is its
 *  folder. Sub-agents' conversations (`parent_conversation_id`) are left out of the list. */

import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { obj, str, tailLines as tailOf, headLines as headOf, time, type Json } from "./jsonl.js";
import { clipText, MESSAGE_CHARS, type SessionMessage } from "./types.js";

export type AgyFacts = { readonly id: string; readonly cwd: string; readonly title: string; readonly lastText: string; readonly updatedAt: number; readonly startedAt?: number; readonly model?: string };

/** Where the CLI keeps its own data: `<HOME>/.gemini/antigravity-cli` (it has no variable of its own for it). */
export function agyHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(env.HOME || homedir(), ".gemini", "antigravity-cli");
}

/** A transcript's lines; none where it is not there (a conversation with nothing said yet, or one deleted). */
const tailLines = (path: string): unknown[] => (existsSync(path) ? tailOf(path) : []);
const headLines = (path: string): unknown[] => (existsSync(path) ? headOf(path) : []);

const BUSY_MS = 1_500;
/** A conversation id is a UUID: nothing else is taken for a file's name. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function withDb<T>(path: string, fallback: T, read: (db: DatabaseSync) => T): T {
  if (!existsSync(path)) return fallback;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=${BUSY_MS}`);
    return read(db);
  } catch {
    return fallback;
  } finally {
    try { db?.close(); } catch { /* it never opened whole */ }
  }
}

/** `2026-11-26 03:58:34.533384+00:00` (as the index writes a time) in milliseconds; 0 when it is not one. */
export function agyTime(text: unknown): number {
  const s = str(text).trim();
  if (!s) return 0;
  const at = Date.parse(s.includes("T") ? s : s.replace(" ", "T"));
  return Number.isFinite(at) ? at : 0;
}

/** The first folder of `["file:///Users/x/work", …]`; "" when there is none. */
export function agyFolder(uris: unknown): string {
  let list: unknown;
  try { list = JSON.parse(str(uris)); } catch { return ""; }
  for (const uri of Array.isArray(list) ? list : []) {
    if (typeof uri !== "string") continue;
    try { if (uri.startsWith("file://")) return fileURLToPath(uri); } catch { /* not a path */ }
    if (uri.startsWith("/")) return uri;
  }
  return "";
}

export function agyTranscript(home: string, id: string): string {
  return join(home, "brain", id, ".system_generated", "logs", "transcript.jsonl");
}

/** What the user typed, out of the wrapping the program puts around it. */
export function agyPrompt(content: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  return (m ? m[1]! : content.replace(/<ADDITIONAL_METADATA>[\s\S]*$/, "")).trim();
}

const userText = (line: Json): string | null => (line.type === "USER_INPUT" ? agyPrompt(str(line.content)) || null : null);
const replyText = (line: Json): string | null => (line.type === "PLANNER_RESPONSE" ? str(line.content).trim() || null : null);

/** What a line says, for search: a prompt or a reply (not a tool's step). */
export function agySaid(line: Json): string | null {
  return userText(line) ?? replyText(line);
}

/** The conversations, the latest first. The title is the program's own; the latest reply and the model are read from
 *  the end of each one's transcript. */
export function agySessions(home: string, limit: number): AgyFacts[] {
  return withDb(join(home, "conversation_summaries.db"), [] as AgyFacts[], (db) => {
    const rows = db.prepare("SELECT conversation_id, title, preview, last_modified_time, workspace_uris FROM conversation_summaries WHERE parent_conversation_id = '' AND killed = 0 ORDER BY last_modified_time DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.flatMap((r) => {
      const id = str(r.conversation_id), cwd = agyFolder(r.workspace_uris);
      // A conversation deleted here keeps its row in the index (the program's own to write): skipped.
      if (!ID.test(id) || !cwd || !existsSync(join(home, "conversations", `${id}.db`))) return [];
      const path = agyTranscript(home, id);
      const tail = [...tailLines(path).map(obj)].reverse(), head = headLines(path).map(obj);
      const model = tail.map((l) => str(l.model)).find(Boolean);
      const started = head.map((l) => time(l.created_at)).find((t) => t > 0);
      return [{ id, cwd, title: str(r.title).trim() || (head.map(userText).find((t) => t !== null) ?? str(r.preview).trim()),
        lastText: tail.map(replyText).find((t) => t !== null) ?? "", updatedAt: agyTime(r.last_modified_time),
        ...(started ? { startedAt: started } : {}), ...(model ? { model } : {}) }];
    });
  });
}

/** One conversation's row, whether or not the list reaches it. */
export function agyFacts(home: string, id: string): AgyFacts | null {
  if (!ID.test(id)) return null;
  return withDb(join(home, "conversation_summaries.db"), null as AgyFacts | null, (db) => {
    const r = db.prepare("SELECT conversation_id, title, preview, last_modified_time, workspace_uris FROM conversation_summaries WHERE conversation_id = ?").get(id) as Record<string, unknown> | undefined;
    const cwd = r ? agyFolder(r.workspace_uris) : "";
    if (!r || !cwd) return null;
    const tail = [...tailLines(agyTranscript(home, id)).map(obj)].reverse();
    const model = tail.map((l) => str(l.model)).find(Boolean);
    return { id, cwd, title: str(r.title).trim() || str(r.preview).trim(), lastText: tail.map(replyText).find((t) => t !== null) ?? "", updatedAt: agyTime(r.last_modified_time), ...(model ? { model } : {}) };
  });
}

/** The last `limit` messages: prompts, replies, and a line for each step that is a tool's. */
export function agyMessages(home: string, id: string, limit: number, chars = MESSAGE_CHARS): SessionMessage[] {
  if (!ID.test(id)) return [];
  const out: SessionMessage[] = [];
  for (const line of tailLines(agyTranscript(home, id)).map(obj)) {
    const ts = time(line.created_at), at = typeof line.step_index === "number" ? line.step_index : undefined;
    const where = at === undefined ? {} : { at };
    const user = userText(line);
    if (user) { out.push({ role: "user", text: clipText(user, chars), ts, ...where }); continue; }
    const reply = replyText(line);
    if (reply) { out.push({ role: "assistant", text: clipText(reply, chars), ts, ...where }); continue; }
    const type = str(line.type);
    // A tool's step: its kind as the program names it (`RUN_COMMAND`, `VIEW_FILE`, …) and what it has to say of it.
    if (type && type !== "USER_INPUT" && type !== "PLANNER_RESPONSE" && str(line.source) !== "SYSTEM") {
      out.push({ role: "tool", tool: type.toLowerCase(), text: clipText(str(line.content), chars), ts, ...where });
    }
  }
  return out.slice(-limit);
}

/** Whether its record is being written now: the index says when it was last touched, the transcript may be newer. */
export function agyTouched(home: string, id: string): number {
  try { return statSync(agyTranscript(home, id)).mtimeMs; } catch { return 0; }
}

/** A conversation gone: its own file, its folder of artefacts and transcript, its title and its presence mark. The
 *  index is the program's own to write (it is open while the program runs): its row is left, and the list skips a
 *  conversation whose file is gone. Answers whether anything was there. */
export function agyDelete(home: string, id: string): boolean {
  if (!ID.test(id)) return false;
  const targets = [join(home, "conversations", `${id}.db`), join(home, "conversations", `${id}.db-wal`), join(home, "conversations", `${id}.db-shm`),
    join(home, "brain", id), join(home, "annotations", `${id}.pbtxt`), join(home, "presence", `${id}.lock`)];
  let found = false;
  for (const path of targets) {
    if (!existsSync(path)) continue;
    found = true;
    rmSync(path, { recursive: true, force: true });
  }
  return found;
}

/** A conversation the index still lists is there while its own file is. */
export function agyExists(home: string, id: string): boolean {
  return ID.test(id) && existsSync(join(home, "conversations", `${id}.db`));
}
