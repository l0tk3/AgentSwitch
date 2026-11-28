/** Antigravity CLI conversations (`agy` 1.5.17, 2026-11-26, user #508). Its home is `~/.gemini/antigravity-cli`
 *  (`agyHome`): an index of every conversation in `conversation_summaries.db` (SQLite, written while it runs: opened
 *  read-only each time), and what was said as lines of JSON in `brain/<id>/.system_generated/logs/transcript.jsonl`
 *  — `{step_index, source, type, status, created_at, content, model?}`, `type` USER_INPUT (the prompt wrapped in
 *  `<USER_REQUEST>…</USER_REQUEST>` and followed by what the program adds), PLANNER_RESPONSE (the reply), and a
 *  step's own type for a tool. The conversation itself is `conversations/<id>.db` (protobuf: not read here).
 *
 *  A tool, as a turn that used one wrote it (seen 2026-11-26 with a real turn that ran a command): the reply's line
 *  carries `tool_calls: [{ name, args }]` and no `content` — each value of `args` is itself JSON
 *  (`"CommandLine": "\"rm x.txt\""`) — and the line after it, `type: "GENERIC"`, is what the tool answered.
 *
 *  A conversation belongs to the folders it was started in (`workspace_uris`, `file://` addresses); the first is its
 *  folder. Sub-agents' conversations (`parent_conversation_id`) are left out of the list.
 *
 *  A turn that ended on an error (an API's 400, say) is in the transcript as the prompt alone, its status line says
 *  `idle` all along (never `error`), and what went wrong is only on the screen and in the conversation's own file: a
 *  step of its own in `conversations/<id>.db` (`steps`, `step_type` 17), whose protobuf payload has the error's words
 *  (seen 2026-11-28 with agy 1.5.18 and a stand-in answering 400: `agyErrors`). */

import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { obj, str, tailLines as tailOf, headLines as headOf, time, type Json } from "./jsonl.js";
import { clipText, errorNote, MESSAGE_CHARS, type SessionMessage } from "./types.js";

export type AgyFacts = { readonly id: string; readonly cwd: string; readonly title: string; readonly lastText: string; readonly updatedAt: number; readonly startedAt?: number; readonly model?: string };

/** The folder Antigravity keeps everything under: `<HOME>/.gemini` — `antigravity-cli/` the CLI's own, `config/` what
 *  it shares with the Antigravity app. The program has no variable for it; `AGENTSWITCH_AGY_HOME` is AgentSwitch's own,
 *  for tests and probes: a terminal is then started with the program's `--gemini_dir` naming the same folder
 *  (terminals/launch.ts), which the one sign-in in the keychain serves too. */
export const AGY_HOME_VAR = "AGENTSWITCH_AGY_HOME";
export function agyGeminiDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[AGY_HOME_VAR]?.trim() || join(env.HOME || homedir(), ".gemini");
}

/** Where the CLI keeps its own data: `<gemini dir>/antigravity-cli`. */
export function agyHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(agyGeminiDir(env), "antigravity-cli");
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

/** A tool's argument out of its own JSON: `"\"rm x\""` is `rm x`; what is not JSON is itself. */
function argText(value: unknown): string {
  if (typeof value !== "string") return value === undefined || value === null ? "" : JSON.stringify(value);
  try { const v: unknown = JSON.parse(value); return typeof v === "string" ? v : value; } catch { return value; }
}

/** What a tool call is about, in a line: the command, the file, the pattern — else what the model said it is for. */
const ARG_KEYS = ["CommandLine", "AbsolutePath", "TargetFile", "Path", "DirectoryPath", "SearchPath", "Query", "Pattern", "Url", "toolSummary"];
function callSummary(args: Json): string {
  for (const key of ARG_KEYS) { const text = argText(args[key]).trim(); if (text) return text; }
  return Object.entries(args).filter(([k]) => k !== "toolSummary").map(([k, v]) => `${k}: ${argText(v)}`).join(", ");
}

/** The tools a reply's line calls: `[{ name, args }]`. */
export function agyToolCalls(line: Json): { tool: string; text: string }[] {
  const calls = Array.isArray(line.tool_calls) ? line.tool_calls.map(obj) : [];
  return calls.flatMap((c) => (str(c.name) ? [{ tool: str(c.name), text: callSummary(obj(c.args)) }] : []));
}

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

// ── A turn that ended on an error ───────────────────────────────────────────────────────────────────────────────────

/** The step a turn that ended on an error leaves in the conversation's file (`steps.step_type`; agy 1.5.18). */
const ERROR_STEP = 17;
/** The error steps read, the latest last: more is not shown. */
const ERRORS_READ = 50;

export type AgyError = { /** Its step, the transcript's `step_index` beside it. */ readonly n: number; /** When it was written (ms). */ readonly at: number; readonly text: string };

/** Protobuf's fields, as `[field, value]`: a number for a varint, bytes for anything length-delimited. Throws on what
 *  is not protobuf. */
function protoFields(b: Uint8Array): [number, number | Uint8Array][] {
  const out: [number, number | Uint8Array][] = [];
  let i = 0;
  const varint = (): number => {
    let v = 0, mul = 1;
    for (let k = 0; k < 10; k++) {
      if (i >= b.length) throw new Error("short");
      const c = b[i++]!;
      v += (c & 0x7f) * mul;
      if (c < 0x80) return v;
      mul *= 128;
    }
    throw new Error("varint");
  };
  while (i < b.length) {
    const key = varint(), field = Math.floor(key / 8), wire = key % 8;
    if (wire === 0) out.push([field, varint()]);
    else if (wire === 2) { const n = varint(); if (i + n > b.length) throw new Error("short"); out.push([field, b.subarray(i, i + n)]); i += n; }
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error("wire");
  }
  return out;
}
const field = (b: Uint8Array, n: number): Uint8Array | null => { const f = protoFields(b).find(([k, v]) => k === n && typeof v !== "number"); return f ? (f[1] as Uint8Array) : null; };
const number = (b: Uint8Array, n: number): number => { const f = protoFields(b).find(([k, v]) => k === n && typeof v === "number"); return f ? (f[1] as number) : 0; };

/** An error step's words: `Error: 400 <the API's message>` where its detail has that shape (`… Error 400, Message: …,
 *  Status: …`), else the detail without the program's own lead-in (`agent executor error: …: `), else its headline.
 *  The payload (seen): 5 its metadata (1 when: seconds, nanos), 24 → 3 the error (1 headline, 2 detail, 7 status). */
export function agyErrorOf(payload: Uint8Array): { at: number; text: string } | null {
  try {
    const error = field(field(payload, 24) ?? new Uint8Array(), 3);
    if (!error) return null;
    const words = (n: number) => { const b = field(error, n); return b ? new TextDecoder().decode(b).trim() : ""; };
    const detail = words(2).split("\n")[0]!.trim(), headline = words(1);
    const api = /\bError (\d{3}), Message: ([\s\S]*?)(?:, Status: [^,]*)?(?:, Details: .*)?$/.exec(detail);
    const said = api ? `${api[1]} ${api[2]!.trim()}` : detail.replace(/^(?:[a-z][a-z ]*: )+/, "") || headline;
    const when = field(field(payload, 5) ?? new Uint8Array(), 1);
    const at = when ? number(when, 1) * 1000 + Math.floor(number(when, 2) / 1e6) : 0;
    return { at, text: errorNote(said) };
  } catch {
    return null;
  }
}

/** A conversation's error steps, the latest last (none where its file cannot be read). */
export function agyErrors(home: string, id: string, limit = ERRORS_READ): AgyError[] {
  if (!ID.test(id)) return [];
  return withDb(join(home, "conversations", `${id}.db`), [] as AgyError[], (db) => {
    const rows = db.prepare("SELECT idx, step_payload FROM steps WHERE step_type = ? ORDER BY idx DESC LIMIT ?").all(ERROR_STEP, limit) as { idx: number; step_payload: Uint8Array | null }[];
    return rows.reverse().flatMap((r) => {
      const e = r.step_payload ? agyErrorOf(r.step_payload) : null;
      return e ? [{ n: Number(r.idx), ...e }] : [];
    });
  });
}

/** The last `limit` messages: prompts, replies, and a line for each step that is a tool's. */
export function agyMessages(home: string, id: string, limit: number, chars = MESSAGE_CHARS): SessionMessage[] {
  return ID.test(id) ? agyMessagesIn(agyTranscript(home, id), limit, chars) : [];
}

/** The same, from a transcript's own file. */
export function agyMessagesIn(path: string, limit: number, chars = MESSAGE_CHARS): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const line of tailLines(path).map(obj)) {
    const ts = time(line.created_at), at = typeof line.step_index === "number" ? line.step_index : undefined;
    const where = at === undefined ? {} : { at };
    const user = userText(line);
    if (user) { out.push({ role: "user", text: clipText(user, chars), ts, ...where }); continue; }
    const reply = replyText(line);
    if (reply) out.push({ role: "assistant", text: clipText(reply, chars), ts, ...where });
    // The tools a reply calls, each a line of its own; what a tool answered (`GENERIC`) is not shown beside them.
    const calls = line.type === "PLANNER_RESPONSE" ? agyToolCalls(line) : [];
    for (const call of calls) out.push({ role: "tool", tool: call.tool, text: clipText(call.text, chars), ts, ...where });
    if (reply || calls.length) continue;
    const type = str(line.type);
    // Any other step of a tool's: its kind as the program names it (`RUN_COMMAND`, `VIEW_FILE`, …) and what it says.
    if (type && type !== "USER_INPUT" && type !== "PLANNER_RESPONSE" && type !== "GENERIC" && str(line.source) !== "SYSTEM") {
      out.push({ role: "tool", tool: type.toLowerCase(), text: clipText(str(line.content), chars), ts, ...where });
    }
  }
  return withErrors(out, path).slice(-limit);
}

/** The error steps of the conversation whose transcript is `path` (`<home>/brain/<id>/.system_generated/logs/…`), each
 *  a note in its place among the transcript's steps (its step's number beside theirs); none before what was read. */
function withErrors(out: SessionMessage[], path: string): SessionMessage[] {
  const brain = dirname(dirname(dirname(dirname(path))));
  const id = basename(dirname(dirname(dirname(path))));
  if (basename(brain) !== "brain" || !ID.test(id)) return out;
  const first = out.find((m) => m.at !== undefined)?.at ?? 0;
  const errors = agyErrors(dirname(brain), id).filter((e) => e.n >= first);
  if (!errors.length) return out;
  const notes: SessionMessage[] = errors.map((e) => ({ role: "note", text: e.text, ts: e.at, at: e.n }));
  return [...out, ...notes].map((m, i) => ({ m, i })).sort((a, b) => (a.m.at ?? -1) - (b.m.at ?? -1) || a.i - b.i).map((x) => x.m);
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
