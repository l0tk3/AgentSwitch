/** Taking a member back to before a room's message (user #288, #290, #293): its conversation goes on from the moment
 *  before it was given a message, or before it sent one, as Claude Code's own rewind (Esc Esc) does — but without
 *  touching its screen. Claude Code has no switch for that in a running terminal, so its record is copied up to that
 *  moment as a new session, and the terminal goes on with that one (the old record stays as it was).
 *
 *  Everything here reads and makes lines of a Claude Code record (`~/.claude/projects/<dir>/<id>.jsonl`); nothing
 *  here starts or stops a terminal (api/roomRewind.ts does). */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const parse = (line: string): Json | null => { try { const v = JSON.parse(line) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? v as Json : null; } catch { return null; } };

/** A message's envelope as a room gives it (delivery.ts): `[Room <name> · #<seq>]`. */
export const envelope = (room: string, seq: number): string => `[Room ${room} · #${seq}]`;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const envelopes = (room: string): RegExp => new RegExp(`\\[Room ${escape(room)} · #(\\d+)\\]`, "g");

/** What a line hands the agent: a prompt (typed, a hook's notification, 戳一下), a hook's added context, or the
 *  queue a prompt waits in. Not a tool's result (a command may print a record), not the agent's own words. */
function handed(e: Json): string | null {
  if (e.isSidechain === true) return null;
  if (e.type === "user") {
    const c = obj(e.message).content;
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return null;
    if (c.some((p) => obj(p).type === "tool_result")) return null;
    return c.map((p) => (obj(p).type === "text" ? str(obj(p).text) : "")).join("\n");
  }
  if (e.type === "attachment") {
    const a = obj(e.attachment);
    if (a.type === "hook_additional_context") return Array.isArray(a.content) ? a.content.map(str).join("\n") : str(a.content);
    if (a.type === "hook_success") return `${str(a.stdout)}\n${str(a.content)}`;
    return null;
  }
  if (e.type === "queue-operation") return str(e.content);
  return null;
}

/** A line of the agent's turn proper (what the conversation is made of), not bookkeeping beside it. */
const conversational = (e: Json): boolean => e.type === "user" || e.type === "assistant" || e.type === "attachment" || e.type === "system";

export type Cut = {
  /** The first line that goes. */
  readonly line: number;
  /** The messages of the room the lines that go handed the agent (they are given again, but for those left out). */
  readonly handed: readonly number[];
  /** When the first line that goes was written (ms), when it says. */
  readonly at: number | null;
  /** The messages the first line that goes handed it (what a refused reply answered). */
  readonly first: readonly number[];
};

function cutAt(lines: readonly string[], line: number, room: string): Cut {
  const seqs = new Set<number>();
  let at: number | null = null;
  for (let i = line; i < lines.length; i++) {
    const e = parse(lines[i]!);
    if (!e) continue;
    if (at === null && typeof e.timestamp === "string") { const t = Date.parse(e.timestamp); if (Number.isFinite(t)) at = t; }
    const text = handed(e);
    if (text) for (const m of text.matchAll(envelopes(room))) seqs.add(Number(m[1]));
  }
  const head = parse(lines[line] ?? "");
  const said = head ? handed(head) : null;
  const first = said ? [...new Set([...said.matchAll(envelopes(room))].map((m) => Number(m[1])))] : [];
  return { line, handed: [...seqs].sort((a, b) => a - b), at, first };
}

/** Before the agent was first handed message `seq` of room `room`; null when its record never had it (it read it with
 *  room_read, or it is another agent's record). */
export function cutBeforeHanded(lines: readonly string[], room: string, seq: number): Cut | null {
  const mark = envelope(room, seq);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(mark)) continue;
    const e = parse(lines[i]!);
    if (e && handed(e)?.includes(mark)) return cutAt(lines, i, room);
  }
  return null;
}

/** Before the agent sent message `seq` of room `room` (its room_post): from the reply that made the call, so the
 *  record never ends in a call without its answer. Null when its record has no such call. */
export function cutBeforeSent(lines: readonly string[], room: string, seq: number): Cut | null {
  const said = `#${seq} sent in "${room}"`;
  let call: string | null = null;
  const raw = JSON.stringify(said).slice(1, -1);
  for (const line of lines) {
    if (!line.includes(raw)) continue;
    const e = parse(line);
    const c = obj(e?.message).content;
    if (e?.type !== "user" || !Array.isArray(c)) continue;
    const r = c.map(obj).find((p) => p.type === "tool_result" && (typeof p.content === "string" ? p.content : Array.isArray(p.content) ? p.content.map((x) => str(obj(x).text)).join("\n") : "").includes(said));
    if (r) { call = str(r.tool_use_id); break; }
  }
  if (!call) return null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(call)) continue;
    const e = parse(lines[i]!);
    const c = obj(e?.message).content;
    if (e?.type !== "assistant" || !Array.isArray(c) || !c.some((p) => obj(p).type === "tool_use" && obj(p).id === call)) continue;
    // One reply is written as several lines (its text, each call), each with the same message id: from its first.
    const id = str(obj(e.message).id);
    let first = i;
    for (let j = i - 1; j >= 0 && id; j--) {
      const p = parse(lines[j]!);
      if (!p || !conversational(p)) continue;
      if (p.type === "assistant" && str(obj(p.message).id) === id) first = j; else break;
    }
    return cutAt(lines, first, room);
  }
  return null;
}

/** The agent's last reply was refused on Claude's usage policy (its "safeguard": `stop_reason: refusal`, or the API
 *  error it shows for one). */
export function refusedLast(lines: readonly string[]): { readonly line: number; readonly uuid: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]!);
    if (!e || e.type !== "assistant" || e.isSidechain === true) continue;
    const m = obj(e.message);
    const text = Array.isArray(m.content) ? m.content.map((p) => str(obj(p).text)).join("\n") : "";
    const refused = m.stop_reason === "refusal" || (e.isApiErrorMessage === true && /usage polic/i.test(text));
    return refused ? { line: i, uuid: str(e.uuid) } : null;
  }
  return null;
}

/** Before the room's message the refused reply was an answer to: the last one handed it before that reply, in the
 *  same stretch of work (a prompt the user typed in between makes it the user's, not the room's). */
export function cutBeforeRefused(lines: readonly string[], room: string, refused: number): Cut | null {
  for (let i = refused - 1; i >= 0; i--) {
    const e = parse(lines[i]!);
    if (!e) continue;
    const text = handed(e);
    if (text === null) continue;
    if (envelopes(room).test(text)) {
      // The first line that handed the same messages (the queue, the hook's answer, the prompt are written one after another).
      let first = i;
      for (let j = i - 1; j >= 0; j--) {
        const p = parse(lines[j]!);
        const t = p ? handed(p) : null;
        if (p && t !== null && t.includes([...text.matchAll(envelopes(room))][0]![0])) first = j;
        else if (p && conversational(p)) break;
      }
      return cutAt(lines, first, room);
    }
    if (e.type === "user" && !/\[Room |<task-notification|<system-reminder/.test(text)) return null;
  }
  return null;
}

/** The record cut: the lines before `cut`, as session `id` — each line's `sessionId` says so, and what names the
 *  newest prompt (Claude Code goes on from what it names) is left out, as is the queue the last line left behind. */
export function cutRecord(lines: readonly string[], cut: number, id: string): string[] {
  const kept: string[] = [];
  for (const line of lines.slice(0, cut)) {
    const e = parse(line);
    if (!e) continue;
    if (e.type === "last-prompt") continue;
    kept.push(JSON.stringify("sessionId" in e ? { ...e, sessionId: id } : e));
  }
  while (kept.length && parse(kept[kept.length - 1]!)?.type === "queue-operation") kept.pop();
  return kept;
}

export function readRecord(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
}

/** Writes the cut record beside the old one as a new session; its id. */
export function writeCut(path: string, lines: readonly string[], cut: number): { readonly id: string; readonly path: string } {
  const id = randomUUID();
  const next = join(dirname(path), `${id}.jsonl`);
  writeFileSync(next, `${cutRecord(lines, cut, id).join("\n")}\n`, { mode: 0o600 });
  return { id, path: next };
}

// ---- the files (退代码: only when the user asks, user #290)

export type FileBack = {
  readonly path: string;
  /** `restore`: written back as it was; `remove`: it was made after that moment. */
  readonly action: "restore" | "remove";
  /** Changed since by someone else (another member, a command, the user): it is not touched unless asked. */
  readonly changed: boolean;
  /** Its content before that moment is not in the record (too large to be kept): it can not be put back. */
  readonly unknown?: true;
};

type FilePlan = FileBack & { readonly before: string | null; readonly after: string | null };

/** What the agent's own edits after line `cut` did to files (Write, Edit; not what its commands did): for each file,
 *  how it was before the first and how it should be after the last. */
function filePlans(lines: readonly string[], cut: number): FilePlan[] {
  const firsts = new Map<string, { before: string | null; unknown: boolean }>();
  const lasts = new Map<string, string | null>();
  for (const line of lines.slice(cut)) {
    if (!line.includes("\"filePath\"")) continue;
    const e = parse(line);
    if (!e || e.type !== "user" || e.isSidechain === true) continue;
    const r = obj(e.toolUseResult);
    const path = str(r.filePath);
    if (!path || !isAbsolute(path)) continue;
    const original = typeof r.originalFile === "string" ? r.originalFile : null;
    let after: string | null | undefined;
    if (r.type === "create" || r.type === "update") after = str(r.content);
    else if (typeof r.oldString === "string" && typeof r.newString === "string" && original !== null) after = r.replaceAll === true ? original.split(r.oldString).join(r.newString) : original.replace(r.oldString, () => str(r.newString));
    if (after === undefined) continue;
    if (!firsts.has(path)) firsts.set(path, { before: r.type === "create" ? null : original, unknown: r.type !== "create" && original === null });
    lasts.set(path, after);
  }
  return [...firsts].map(([path, first]) => {
    const after = lasts.get(path) ?? null;
    const now = existsSync(path) ? readFileSync(path, "utf8") : null;
    return { path, action: first.before === null && !first.unknown ? "remove" : "restore", changed: now !== after, ...(first.unknown ? { unknown: true as const } : {}), before: first.before, after };
  });
}

/** What putting the files back would do (shown before it is done). */
export function filesBack(lines: readonly string[], cut: number): FileBack[] {
  return filePlans(lines, cut).map(({ before: _b, after: _a, ...f }) => f);
}

/** Puts the files back; `force`: also those changed since. The ones put back. */
export function putFilesBack(lines: readonly string[], cut: number, force = false): string[] {
  const done: string[] = [];
  for (const f of filePlans(lines, cut)) {
    if (f.unknown || (f.changed && !force)) continue;
    if (f.action === "remove") { if (existsSync(f.path)) rmSync(f.path); }
    else writeFileSync(f.path, f.before ?? "");
    done.push(f.path);
  }
  return done;
}
