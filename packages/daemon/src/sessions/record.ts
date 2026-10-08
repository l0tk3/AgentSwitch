/** A session's record for the simple view (docs/simple-view-v0.md §2–§4): what the user said, what the agent answered,
 *  and each run of work between two answers as its steps — read from what the agent itself writes as it goes (Claude
 *  Code's session file, Codex's rollout), never from the terminal's screen. Read-only.
 *
 *  An item's id is where its first line begins in the file (the files only grow), so a page ends where the next one
 *  starts and a run of work is found again by its id for its changes. */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isTypedText, obj, str, time, type Json } from "./jsonl.js";
import type { SessionMessage } from "./types.js";

export type StepKind = "read" | "search" | "list" | "run" | "edit" | "write" | "web" | "agent" | "todo" | "think" | "tool";

export type RecordStep = {
  readonly kind: StepKind;
  /** One line: the file, the command, the query, what a sub-agent was sent to do. */
  readonly text: string;
  /** The tool's own name, for a step that is none of the kinds (`tool`), e.g. `browser · navigate`. */
  readonly tool?: string;
  /** What the agent said the step is for, in its own words (Claude Code's `description` of a command). */
  readonly note?: string;
  /** The end of what a command printed. */
  readonly out?: string;
  readonly failed?: boolean;
  /** Lines an edit added and took away. */
  readonly added?: number;
  readonly removed?: number;
  /** Pictures the step brought back (a picture file read, a screenshot taken): how many, each read by its place. */
  readonly images?: number;
};

export type RecordItem =
  | { readonly type: "user"; readonly id: string; readonly ts: number; readonly text: string; readonly images?: number; readonly queued?: boolean; readonly clipped?: boolean }
  // `thinking`: what the agent thought on the way, where it wrote that down — said like an answer, quieter (a screen
  // that does not know the mark shows it as an answer, which is how the agents' own apps show it).
  | { readonly type: "answer"; readonly id: string; readonly ts: number; readonly text: string; readonly clipped?: boolean }
  | { readonly type: "work"; readonly id: string; readonly ts: number; readonly secs: number; readonly steps: readonly RecordStep[] }
  | { readonly type: "note"; readonly id: string; readonly ts: number; readonly text: string };

export type PlanEntry = { readonly text: string; readonly state: "todo" | "doing" | "done" };
/** `used`: tokens in the context at the last turn; `window`: how many it holds, when the record says. */
export type RecordUsage = { readonly model?: string; readonly used?: number; readonly window?: number; /** How hard it thought at the last turn, in the agent's word. */ readonly effort?: string };

export type DiffHunk = { readonly header: string; readonly lines: readonly string[] };
export type FileDiff = { readonly path: string; readonly added: number; readonly removed: number; readonly hunks: readonly DiffHunk[]; readonly clipped?: boolean };

export type SessionRecord = {
  readonly items: readonly RecordItem[];
  /** There is more before `cursor` (`before=<cursor>` gets it). */
  readonly more: boolean;
  readonly cursor: number;
  /** Changes when the record does. */
  readonly rev: string;
  readonly plan: readonly PlanEntry[];
  readonly usage: RecordUsage | null;
  /** The permission mode the record last named, as the agent writes it (`acceptEdits`, `plan`, `on-request`…). */
  readonly mode: string | null;
};

export type RecordHarness = "claude-code" | "codex";

export const TEXT_CHARS = 20_000;
export const STEP_CHARS = 300;
export const OUTPUT_CHARS = 600;
export const DIFF_LINES = 400;
export const RECORD_LIMIT = 60;
export const MAX_RECORD_LIMIT = 200;
/** How far back one read looks for `limit` items: a session with screenshots in it has lines of hundreds of kilobytes. */
const WINDOWS = [2, 8, 32].map((mb) => mb * 1024 * 1024);

// ---------------------------------------------------------------------------------------------------------------------
// lines, with where each begins
// ---------------------------------------------------------------------------------------------------------------------

type Line = { readonly at: number; readonly value: Json };

/** The whole lines in `[start, end)`: one cut at the start is dropped, one still being written at the end too. */
function readLines(path: string, start: number, end: number): { lines: Line[]; from: number } {
  const begin = Math.max(0, start - 1);
  const buf = Buffer.alloc(Math.max(0, end - begin));
  const fd = openSync(path, "r");
  let n = 0;
  try { while (n < buf.length) { const got = readSync(fd, buf, n, buf.length - n, begin + n); if (got <= 0) break; n += got; } } finally { closeSync(fd); }
  const data = buf.subarray(0, n);
  let i = 0;
  if (start > 0) {
    // A line begins at `start` only when the byte before it ends one.
    i = data[0] === 10 ? 1 : data.indexOf(10) + 1;
    if (i === 0) return { lines: [], from: end };
  }
  const from = begin + i;
  const lines: Line[] = [];
  while (i < data.length) {
    let stop = data.indexOf(10, i);
    if (stop < 0) stop = data.length;
    if (stop > i) {
      try { const value = JSON.parse(data.toString("utf8", i, stop)) as unknown; lines.push({ at: begin + i, value: obj(value) }); } catch { /* cut, or still being written */ }
    }
    i = stop + 1;
  }
  return { lines, from };
}

// ---------------------------------------------------------------------------------------------------------------------
// building items from what the lines say
// ---------------------------------------------------------------------------------------------------------------------

type Patch = { path: string; added: number; removed: number; hunks: DiffHunk[] };
type Step = { kind: StepKind; text: string; tool?: string; note?: string; out?: string; failed?: boolean; added?: number; removed?: number; patches?: Patch[];
  /** A command and what it printed, whole: for the one step a screen opens (`readStep`), never in the record. */
  cmd?: string; printed?: string;
  images?: number;
  /** Where the step's pictures are, never in the record: the line its result is on and the result's id (Claude Code
   *  keeps them there), or the file it looked at (Codex). */
  shots?: { at: number; id: string } | { file: string } };
type Built =
  | { type: "user"; at: number; ts: number; text: string; images: number; queued?: boolean }
  | { type: "answer"; at: number; ts: number; text: string; thinking?: boolean }
  | { type: "work"; at: number; ts: number; end: number; steps: Step[] }
  | { type: "note"; at: number; ts: number; text: string };

class Builder {
  readonly items: Built[] = [];
  plan: PlanEntry[] = [];
  usage: RecordUsage | null = null;
  mode: string | null = null;
  private open: Extract<Built, { type: "work" }> | null = null;

  user(at: number, ts: number, text: string, images = 0, queued = false): void {
    this.close();
    this.items.push({ type: "user", at, ts, text, images, ...(queued ? { queued } : {}) });
  }

  /** The agent's words. A run of work before them ends when they come. `thinking`: what it thought on the way. */
  answer(at: number, ts: number, text: string, thinking = false): void {
    this.close(ts);
    const last = this.items[this.items.length - 1];
    // One answer written as several lines in a row (Claude Code writes a line per block) reads as one; a thought and
    // an answer stay two.
    if (last?.type === "answer" && !last.thinking === !thinking && ts - last.ts < 2000 && last.at !== at) { last.text = `${last.text}\n\n${text}`; return; }
    this.items.push({ type: "answer", at, ts, text, ...(thinking ? { thinking } : {}) });
  }

  note(at: number, ts: number, text: string): void {
    this.close();
    this.items.push({ type: "note", at, ts, text });
  }

  step(at: number, ts: number, step: Step, end = ts): Step {
    if (!this.open) { this.open = { type: "work", at, ts, end, steps: [] }; this.items.push(this.open); }
    this.open.steps.push(step);
    this.touch(end);
    return step;
  }

  /** Something of the open run happened at `ts` (a tool's result came back). */
  touch(ts: number): void {
    if (this.open && ts > this.open.end) this.open.end = ts;
  }

  private close(end?: number): void {
    if (this.open && end !== undefined) this.touch(end);
    this.open = null;
  }
}

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
const firstLine = (text: string, limit = STEP_CHARS): string => clip(text.trim().split("\n")[0]?.trim() ?? "", limit);
/** A command on one line: its lines joined, clipped. */
const commandLine = (text: string): string => clip(text.trim().replace(/\s*\n\s*/g, " ⏎ "), STEP_CHARS);
/** The end of what a command printed: the last lines, at most `OUTPUT_CHARS`. */
function tail(text: string): string {
  const t = text.replace(/\s+$/, "");
  if (t.length <= OUTPUT_CHARS) return t;
  const cut = t.slice(t.length - OUTPUT_CHARS);
  const nl = cut.indexOf("\n");
  return `…${nl >= 0 && nl < OUTPUT_CHARS / 2 ? cut.slice(nl) : cut}`;
}

/** A path as the screens write it: under the session's folder, relative to it; under the home folder, `~/…`. */
export function shortPath(path: string, cwd: string, home = homedir()): string {
  if (!path) return "";
  const base = cwd.replace(/\/+$/, "");
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

const whole = (prefix: string, text: string): string[] => (text ? text.replace(/\n$/, "").split("\n").map((l) => prefix + l) : []);

/** A file's change as a patch: its hunks, and how many lines went in and out. */
function patchOf(path: string, hunks: DiffHunk[]): Patch {
  let added = 0, removed = 0;
  for (const h of hunks) for (const l of h.lines) { if (l.startsWith("+")) added += 1; else if (l.startsWith("-")) removed += 1; }
  return { path, added, removed, hunks };
}

/** A unified diff's hunks (`@@ … @@` and the lines under each); the file headers are left out. */
export function unifiedHunks(diff: string): DiffHunk[] {
  const hunks: { header: string; lines: string[] }[] = [];
  for (const l of diff.replace(/\n$/, "").split("\n")) {
    if (l.startsWith("@@")) hunks.push({ header: l, lines: [] });
    else if (l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("diff ") || l.startsWith("index ")) continue;
    else if (hunks.length) hunks[hunks.length - 1]!.lines.push(l);
    else if (/^[+\- ]/.test(l)) hunks.push({ header: "", lines: [l] });
  }
  return hunks;
}

// ---------------------------------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------------------------------

function parts(line: Json): Json[] {
  const c = obj(line.message).content;
  return Array.isArray(c) ? c.map(obj) : typeof c === "string" ? [{ type: "text", text: c }] : [];
}

/** `mcp__browser__browser_navigate` → `browser · navigate`: the server, and the tool without the server's name again. */
function mcpName(name: string): string {
  const [, server = "", ...rest] = name.split("__");
  const tool = rest.join("__").replace(new RegExp(`^${server.replace(/[^A-Za-z0-9]/g, ".")}_`), "");
  return `${server} · ${tool.replace(/_/g, " ")}`;
}

function inputLine(input: Json): string {
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "title", "prompt", "skill", "name"]) {
    if (str(input[key])) return firstLine(str(input[key]));
  }
  const first = Object.values(input).find((v) => typeof v === "string" && v);
  return typeof first === "string" ? firstLine(first) : "";
}

function todoState(status: string): PlanEntry["state"] {
  return status === "completed" ? "done" : status === "in_progress" ? "doing" : "todo";
}

function claudeStep(name: string, input: Json, cwd: string): Step {
  const file = shortPath(str(input.file_path) || str(input.path) || str(input.notebook_path), cwd);
  switch (name) {
    case "Read": return { kind: "read", text: file };
    case "Grep": return { kind: "search", text: clip(str(input.pattern), STEP_CHARS) };
    case "Glob": return { kind: "search", text: clip(str(input.pattern), STEP_CHARS) };
    case "LS": return { kind: "list", text: file };
    case "Bash": return { kind: "run", text: commandLine(str(input.command)), cmd: str(input.command), ...(firstLine(str(input.description)) ? { note: firstLine(str(input.description)) } : {}) };
    case "Edit": case "MultiEdit": case "NotebookEdit": return { kind: "edit", text: file };
    case "Write": return { kind: "write", text: file };
    case "WebFetch": return { kind: "web", text: clip(str(input.url), STEP_CHARS) };
    case "WebSearch": return { kind: "web", text: clip(str(input.query), STEP_CHARS) };
    case "Agent": case "Task": return { kind: "agent", text: firstLine(str(input.description) || str(input.prompt)) };
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos.map(obj) : [];
      const doing = todos.find((t) => t.status === "in_progress");
      return { kind: "todo", text: firstLine(str(doing?.activeForm) || str(doing?.content) || `${todos.filter((t) => t.status === "completed").length}/${todos.length}`) };
    }
    default: return { kind: "tool", tool: name.startsWith("mcp__") ? mcpName(name) : name, text: inputLine(input) };
  }
}

/** What a tool's result adds to its step: a command's output, an edit's patch, a failure. */
function claudeResult(step: Step, part: Json, result: unknown, cwd: string): void {
  const r = obj(result);
  const said = Array.isArray(part.content) ? part.content.map((p) => str(obj(p).text)).join("\n") : str(part.content);
  if (part.is_error === true) { step.failed = true; step.out = tail(typeof result === "string" ? result : said); return; }
  if (step.kind === "run") {
    const out = [str(r.stdout), str(r.stderr)].filter((s) => s.trim()).join("\n");
    if (out.trim()) { step.out = tail(out); step.printed = out; }
    if (r.interrupted === true) step.failed = true;
    return;
  }
  if (step.kind !== "edit" && step.kind !== "write") return;
  const path = shortPath(str(r.filePath) || str(r.file_path), cwd) || step.text;
  const patch = Array.isArray(r.structuredPatch) ? r.structuredPatch.map(obj) : [];
  let hunks: DiffHunk[] = patch.map((h) => ({
    header: `@@ -${Number(h.oldStart) || 0},${Number(h.oldLines) || 0} +${Number(h.newStart) || 0},${Number(h.newLines) || 0} @@`,
    lines: Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === "string") : [],
  }));
  // A new file has no patch: all of it went in.
  if (!hunks.length && typeof r.content === "string" && (r.type === "create" || !r.originalFile)) hunks = [{ header: "", lines: whole("+", r.content) }];
  if (!hunks.length) return;
  const p = patchOf(path, hunks);
  step.patches = [p]; step.added = p.added; step.removed = p.removed;
}

/** A number of tokens as the screens write it: `899k`, `1.2M`. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${Math.max(1, Math.round(n / 1000))}k`;
}

function claudeBuild(lines: readonly Line[]): Builder {
  const b = new Builder();
  const waiting = new Map<string, Step>();
  let queue: { at: number; ts: number; text: string }[] = [];
  for (const { at, value: line } of lines) {
    if (str(line.permissionMode)) b.mode = str(line.permissionMode);
    if (line.isSidechain) continue;
    const ts = time(line.timestamp);
    const cwd = str(line.cwd);
    if (line.type === "queue-operation") {
      const text = str(line.content);
      if (line.operation === "enqueue") { if (isTypedText(text)) queue.push({ at, ts, text }); }
      else if (line.operation === "dequeue") queue.shift();
      else if (line.operation === "remove") { const i = queue.findIndex((q) => q.text === text); queue.splice(i < 0 ? 0 : i, 1); }
      continue;
    }
    if (line.type === "system") {
      if (line.subtype === "compact_boundary") {
        // How much it held before and holds now, where the file says (Claude Code 2.1.292: `compactMetadata`); the
        // context is as full as the latter until its next answer says otherwise.
        const meta = obj(line.compactMetadata);
        const pre = Number(meta.preTokens) || 0, post = Number(meta.postTokens) || 0;
        b.note(at, ts, pre > 0 && post > 0 ? `Compacted · ${tokens(pre)} → ${tokens(post)}` : "Compacted");
        if (post > 0 && b.usage) b.usage = { ...b.usage, used: post };
      }
      continue;
    }
    // A message typed while it worked and taken in mid-turn is written as an attachment, not as a user line.
    if (line.type === "attachment") {
      const a = obj(line.attachment);
      if (a.type !== "queued_command" || a.commandMode !== "prompt" || obj(a.origin).kind !== "human") continue;
      const ps = Array.isArray(a.prompt) ? a.prompt.map(obj) : [{ type: "text", text: str(a.prompt) }];
      const text = ps.map((p) => (p.type === "text" ? str(p.text) : "")).join("\n").trim();
      const images = ps.filter((p) => p.type === "image").length;
      if (isTypedText(text) || images) b.user(at, ts, text, images);
      continue;
    }
    if (line.type === "user") {
      const ps = parts(line);
      for (const part of ps) {
        if (part.type !== "tool_result") continue;
        const step = waiting.get(str(part.tool_use_id));
        if (step) {
          claudeResult(step, part, line.toolUseResult, cwd);
          const shots = Array.isArray(part.content) ? part.content.filter((p) => obj(p).type === "image").length : 0;
          if (shots) { step.images = shots; step.shots = { at, id: str(part.tool_use_id) }; }
          waiting.delete(str(part.tool_use_id));
        }
        b.touch(ts);
      }
      if (line.isMeta || line.isCompactSummary || line.isVisibleInTranscriptOnly) continue;
      const text = ps.map((p) => (p.type === "text" ? str(p.text) : "")).join("\n").trim();
      if (text.startsWith("[Request interrupted")) { b.note(at, ts, "Interrupted"); continue; }
      const images = ps.filter((p) => p.type === "image").length;
      if (isTypedText(text) || (images && !text)) b.user(at, ts, text, images);
      continue;
    }
    if (line.type !== "assistant") continue;
    const message = obj(line.message);
    const usage = obj(message.usage);
    const model = str(message.model);
    if (model && !model.startsWith("<")) {
      const used = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
      const effort = str(line.effort) || b.usage?.effort;
      b.usage = { model, ...(used > 0 ? { used } : b.usage?.used ? { used: b.usage.used } : {}), ...(effort ? { effort } : {}) };
    }
    for (const part of parts(line)) {
      if (part.type === "text" && str(part.text).trim()) b.answer(at, ts, str(part.text).trim());
      // Thinking it wrote down (most of it is kept sealed: only what has words): said on the way, as its own app does.
      else if (part.type === "thinking" && str(part.thinking).trim()) b.answer(at, ts, str(part.thinking).trim(), true);
      else if (part.type === "tool_use") {
        const input = obj(part.input);
        const step = b.step(at, ts, claudeStep(str(part.name), input, cwd));
        if (str(part.id)) waiting.set(str(part.id), step);
        if (part.name === "TodoWrite" && Array.isArray(input.todos)) {
          b.plan = input.todos.map(obj).map((t) => ({ text: firstLine(str(t.content)), state: todoState(str(t.status)) })).filter((t) => t.text);
        }
      }
    }
  }
  // Typed while it worked and not read yet.
  for (const q of queue) b.user(q.at, q.ts, q.text, 0, true);
  return b;
}

// ---------------------------------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------------------------------

/** Codex desktop puts the files the user attached ahead of the request: the request is what the user typed. An
 *  answer to one of its questions (below) travels in an envelope of Codex's own; what you answered is what is shown. */
function codexTyped(text: string): string | null {
  const marker = /^##\s*My request[^:\n]*:\s*$/im.exec(text);
  const typed = marker ? text.slice(marker.index + marker[0].length).trim() : text.trim();
  const answered = codexAnswers(typed);
  if (answered !== null) return answered;
  return isTypedText(typed) && !typed.startsWith("# Files mentioned") ? typed : null;
}

/** `<send_user_message_question_reply>{"questionItemId":…,"question":…,"answer":…}</send_user_message_question_reply>`
 *  (one object or a list; Codex 0.162, its TUI's `async_question_reply.rs`): the answers, a line each; null for
 *  anything else. */
function codexAnswers(text: string): string | null {
  const m = /^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/.exec(text.trim());
  if (!m) return null;
  try {
    const parsed: unknown = JSON.parse(m[1]!);
    const answers = (Array.isArray(parsed) ? parsed : [parsed]).map((r) => str(obj(r).answer).trim()).filter(Boolean);
    return answers.length ? answers.join("\n") : null;
  } catch { return null; }
}

/** What Codex offers as answers to a question it puts at the end of a message (`questions`, each a title and options;
 *  Codex 0.162). It does not wait for one: its own screen shows them for half a minute, or until the turn ends, and
 *  goes on (2026-10-08, user: codex里的对话回复也不太管用，直接跳过去了). In the record they stay under the message,
 *  numbered as its screen numbers them — to answer is to say one in your reply. A question whose words the message
 *  does not already say is written out above its options. */
function codexQuestions(text: string, questions: unknown): string {
  if (!Array.isArray(questions)) return text;
  const blocks: string[] = [];
  for (const q of questions.map(obj)) {
    const title = str(q.title).trim();
    const options = (Array.isArray(q.options) ? q.options : []).filter((o): o is string => typeof o === "string" && !!o.trim()).slice(0, 12);
    if (!options.length) { if (title && !text.includes(title)) blocks.push(title); continue; }
    blocks.push([...(title && !text.includes(title) ? [title, ""] : []), ...options.map((o, i) => `${i + 1}. ${o.trim().replace(/\s+/g, " ")}`)].join("\n"));
  }
  return blocks.length ? [text, ...blocks].filter(Boolean).join("\n\n") : text;
}

/** One file of a Codex change: added whole, deleted whole, or a unified diff. */
function codexPatch(path: string, change: Json, cwd: string): Patch {
  const kind = str(change.type);
  const hunks = kind === "add" ? [{ header: "", lines: whole("+", str(change.content)) }]
    : kind === "delete" ? [{ header: "", lines: whole("-", str(change.content)) }]
    : unifiedHunks(str(change.unified_diff));
  return patchOf(shortPath(path, cwd), hunks);
}

function codexItem(b: Builder, at: number, ts: number, payload: Json, cwd: string): void {
  const item = obj(payload.item);
  const began = Number(payload.started_at_ms) || ts;
  const ended = Number(payload.completed_at_ms) || ts;
  const texts = (v: unknown): string => (Array.isArray(v) ? v.map((p) => (typeof p === "string" ? p : str(obj(p).text))).join("\n").trim() : str(v).trim());
  switch (item.type) {
    case "UserMessage": {
      const content = Array.isArray(item.content) ? item.content.map(obj) : [];
      const typed = codexTyped(texts(content));
      const images = content.filter((p) => /image/i.test(str(p.type))).length;
      if (typed !== null || images) b.user(at, ended, typed ?? "", images);
      return;
    }
    case "AgentMessage": { const text = codexQuestions(texts(item.content), item.questions); if (text) b.answer(at, ended, text); return; }
    case "Reasoning": { const text = texts(item.summary_text); if (text) b.answer(at, ended, text, true); return; }
    case "CommandExecution": {
      const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map(obj) : [];
      const failed = (typeof item.exit_code === "number" && item.exit_code !== 0) || item.status === "failed";
      const kinds: Record<string, StepKind> = { read: "read", list_files: "list", listFiles: "list", search: "search" };
      // Codex names what a command is for when it only looks (reads, lists, searches): the screens say that.
      if (parsed.length && parsed.every((p) => kinds[str(p.type)]) && !failed) {
        for (const p of parsed) {
          const kind = kinds[str(p.type)]!;
          const text = kind === "search" ? [str(p.query), shortPath(str(p.path), cwd)].filter(Boolean).join(" · ") : shortPath(str(p.path), cwd) || str(p.name);
          b.step(at, began, { kind, text: clip(text || str(p.cmd), STEP_CHARS) }, ended);
        }
        return;
      }
      const command = Array.isArray(item.command) ? str(item.command[item.command.length - 1]) : str(item.command);
      const out = str(item.aggregated_output) || [str(item.stdout), str(item.stderr)].filter(Boolean).join("\n");
      const shown = str(parsed[0]?.cmd) && parsed.length === 1 ? str(parsed[0]?.cmd) : command;
      b.step(at, began, { kind: "run", text: commandLine(shown), cmd: shown, ...(out.trim() ? { out: tail(out), printed: out } : {}), ...(failed ? { failed } : {}) }, ended);
      return;
    }
    case "FileChange": {
      for (const [path, v] of Object.entries(obj(item.changes))) {
        const change = obj(v);
        const p = codexPatch(path, change, cwd);
        b.step(at, began, { kind: change.type === "add" ? "write" : "edit", text: p.path, added: p.added, removed: p.removed, patches: [p], ...(item.status === "failed" ? { failed: true } : {}) }, ended);
      }
      return;
    }
    case "McpToolCall": {
      b.step(at, began, { kind: "tool", tool: `${str(item.server)} · ${str(item.tool).replace(/_/g, " ")}`, text: inputLine(obj(item.arguments)), ...(item.status === "failed" ? { failed: true } : {}) }, ended);
      return;
    }
    case "Extension": {
      const kind = str(item.kind);
      if (kind === "web.search") b.step(at, began, { kind: "web", text: clip(str(item.query) || str(obj(item.action).url), STEP_CHARS) }, ended);
      else if (kind !== "clock.sleep") b.step(at, began, { kind: "tool", tool: kind, text: firstLine(str(item.revisedPrompt) || str(item.query)) }, ended);
      return;
    }
    case "SubAgentActivity": if (item.kind === "started") b.step(at, began, { kind: "agent", text: firstLine(str(item.agent_path).split("/").pop() ?? "") }, ended); return;
    case "ImageView": {
      const file = str(item.path);
      const shown = file.startsWith("/") && IMAGE_TYPES[file.split(".").pop()?.toLowerCase() ?? ""];
      b.step(at, began, { kind: "read", text: shortPath(file, cwd), ...(shown ? { images: 1, shots: { file } } : {}) }, ended);
      return;
    }
    case "ContextCompaction": b.note(at, ended, "Compacted"); return;
    default: return;
  }
}

function codexBuild(lines: readonly Line[], cwd: string): Builder {
  const b = new Builder();
  let folder = cwd;
  for (const { at, value: line } of lines) {
    const ts = time(line.timestamp);
    const payload = obj(line.payload);
    if (line.type === "session_meta" && str(payload.cwd)) folder = str(payload.cwd);
    if (line.type === "turn_context") {
      if (str(payload.cwd)) folder = str(payload.cwd);
      if (str(payload.model)) b.usage = { ...(b.usage ?? {}), model: str(payload.model) };
      if (str(payload.effort)) b.usage = { ...(b.usage ?? {}), effort: str(payload.effort) };
      if (str(payload.approval_policy)) b.mode = str(payload.approval_policy);
      continue;
    }
    if (line.type === "response_item" && payload.type === "function_call" && payload.name === "update_plan") {
      try {
        const plan = obj(JSON.parse(str(payload.arguments))).plan;
        if (Array.isArray(plan)) b.plan = plan.map(obj).map((p) => ({ text: firstLine(str(p.step)), state: todoState(str(p.status)) })).filter((p) => p.text);
      } catch { /* not a plan */ }
      continue;
    }
    if (line.type !== "event_msg") continue;
    if (payload.type === "item_completed") codexItem(b, at, ts, payload, folder);
    else if (payload.type === "turn_aborted") b.note(at, ts, "Interrupted");
    else if (payload.type === "token_count") {
      const info = obj(payload.info);
      const used = Number(obj(info.last_token_usage).total_tokens) || 0;
      const window = Number(info.model_context_window) || 0;
      if (used || window) b.usage = { ...(b.usage ?? {}), ...(used ? { used } : {}), ...(window ? { window } : {}) };
    }
  }
  return b;
}

/** Whether a rollout's lines carry the thread's items (`item_completed`): older ones have only the model's raw turns. */
const hasItems = (lines: readonly Line[]): boolean => lines.some((l) => l.value.type === "event_msg" && obj(l.value.payload).type === "item_completed");

// ---------------------------------------------------------------------------------------------------------------------
// the record
// ---------------------------------------------------------------------------------------------------------------------

function ids(items: readonly Built[]): string[] {
  const seen = new Map<number, number>();
  return items.map((it) => {
    const n = seen.get(it.at) ?? 0;
    seen.set(it.at, n + 1);
    return n ? `${it.at}.${n}` : String(it.at);
  });
}

function shown(it: Built, id: string): RecordItem {
  const long = (text: string) => (text.length > TEXT_CHARS ? { text: text.slice(0, TEXT_CHARS), clipped: true as const } : { text });
  switch (it.type) {
    case "user": return { type: "user", id, ts: it.ts, ...long(it.text), ...(it.images ? { images: it.images } : {}), ...(it.queued ? { queued: true } : {}) };
    case "answer": return { type: "answer", id, ts: it.ts, ...long(it.text), ...(it.thinking ? { thinking: true } : {}) };
    case "note": return { type: "note", id, ts: it.ts, text: it.text };
    case "work": return {
      type: "work", id, ts: it.ts, secs: Math.max(0, Math.round((it.end - it.ts) / 1000)),
      steps: it.steps.map(({ patches: _patches, cmd: _cmd, printed: _printed, shots: _shots, ...step }) => step),
    };
  }
}

export function fileRev(path: string): { rev: string; size: number } {
  const st = statSync(path);
  return { rev: `${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}`, size: st.size };
}

function build(harness: RecordHarness, lines: readonly Line[], cwd: string): Builder | null {
  if (harness === "claude-code") return claudeBuild(lines);
  return hasItems(lines) ? codexBuild(lines, cwd) : null;
}

/** The last `limit` items before `before` (the file's end without it). Null when the file holds no record this reads
 *  (an older Codex rollout): the caller falls back to the coarse messages. */
export function readRecord(harness: RecordHarness, path: string, o: { limit?: number; before?: number; cwd?: string } = {}): SessionRecord | null {
  const { rev, size } = fileRev(path);
  const limit = Math.max(1, Math.min(o.limit ?? RECORD_LIMIT, MAX_RECORD_LIMIT));
  const end = Math.max(0, Math.min(o.before ?? size, size));
  let built: Builder | null = null;
  let from = end;
  for (const window of WINDOWS) {
    const start = Math.max(0, end - window);
    const read = readLines(path, start, end);
    from = read.from;
    built = build(harness, read.lines, o.cwd ?? "");
    // One more than asked for: the first may be a run of work the window cut in two.
    if (start === 0 || (built && built.items.length > limit)) break;
    // A rollout with no items in its last megabytes has none earlier either.
    if (!built) break;
  }
  if (!built) return null;
  const all = built.items;
  const kept = all.slice(-limit);
  const names = ids(all).slice(-limit);
  const cursor = kept.length < all.length ? kept[0]!.at : from;
  return {
    items: kept.map((it, i) => shown(it, names[i]!)), more: cursor > 0, cursor, rev,
    // The plan, the usage and the mode are the session's latest: an earlier page does not carry them.
    plan: o.before === undefined ? built.plan : [], usage: o.before === undefined ? built.usage : null, mode: o.before === undefined ? built.mode : null,
  };
}

/** What changed, file by file: in one run of work (`work`, its id), else in the last turn (since the user last spoke). */
export function readChanges(harness: RecordHarness, path: string, o: { work?: string; cwd?: string } = {}): FileDiff[] | null {
  const { size } = fileRev(path);
  let works: Extract<Built, { type: "work" }>[];
  if (o.work !== undefined) {
    const at = Number(o.work.split(".")[0]);
    if (!Number.isInteger(at) || at < 0 || at >= size) return null;
    const built = build(harness, readLines(path, at, Math.min(size, at + WINDOWS[1]!)).lines.filter((l) => l.at >= at), o.cwd ?? "");
    const all = built?.items ?? [];
    const i = ids(all).indexOf(o.work);
    const hit = all[i];
    if (!hit || hit.type !== "work" || hit.at !== at) return null;
    works = [hit];
  } else {
    const built = build(harness, readLines(path, Math.max(0, size - WINDOWS[1]!), size).lines, o.cwd ?? "");
    if (!built) return null;
    const last = built.items.findLastIndex((it) => it.type === "user" && !it.queued);
    works = built.items.slice(last + 1).filter((it): it is Extract<Built, { type: "work" }> => it.type === "work");
  }
  const files = new Map<string, { added: number; removed: number; hunks: DiffHunk[] }>();
  for (const w of works) for (const step of w.steps) for (const p of step.patches ?? []) {
    const f = files.get(p.path) ?? { added: 0, removed: 0, hunks: [] };
    f.added += p.added; f.removed += p.removed; f.hunks.push(...p.hunks);
    files.set(p.path, f);
  }
  return [...files].map(([path, f]) => {
    let left = DIFF_LINES;
    const hunks: DiffHunk[] = [];
    for (const h of f.hunks) {
      if (left <= 0) break;
      hunks.push(h.lines.length > left ? { header: h.header, lines: h.lines.slice(0, left) } : h);
      left -= h.lines.length;
    }
    return { path, added: f.added, removed: f.removed, hunks, ...(left < 0 || hunks.length < f.hunks.length ? { clipped: true } : {}) };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// one step, whole
// ---------------------------------------------------------------------------------------------------------------------

/** A command as it was written and what it printed: this much of each. */
export const STEP_TEXT_CHARS = 20000;
export type StepDetail = { readonly kind: StepKind; readonly text: string; readonly note?: string; readonly out?: string; readonly failed?: boolean;
  readonly images?: number;
  /** The command, or what it printed, is longer than is sent: the command's start, the output's end. */
  readonly clipped?: boolean };

/** The `n`-th step of the run of work `work`, with its command whole (its lines kept) and all it printed — the record
 *  itself carries one line and the end of the output. Null: no such run, no such step. */
export function readStep(harness: RecordHarness, path: string, o: { work: string; n: number; cwd?: string }): StepDetail | null {
  const step = stepOf(harness, path, o);
  if (!step) return null;
  const text = (step.cmd ?? step.text).replace(/\r\n?/g, "\n").trim();
  const out = (step.printed ?? step.out ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  const long = text.length > STEP_TEXT_CHARS || out.length > STEP_TEXT_CHARS;
  return {
    kind: step.kind, text: text.slice(0, STEP_TEXT_CHARS), ...(step.note ? { note: step.note } : {}),
    ...(out ? { out: out.length > STEP_TEXT_CHARS ? out.slice(out.length - STEP_TEXT_CHARS) : out } : {}),
    ...(step.failed ? { failed: true } : {}), ...(step.images ? { images: step.images } : {}), ...(long ? { clipped: true } : {}),
  };
}

function stepOf(harness: RecordHarness, path: string, o: { work: string; n: number; cwd?: string }): Step | null {
  const { size } = fileRev(path);
  const at = Number(o.work.split(".")[0]);
  if (!Number.isInteger(at) || at < 0 || at >= size || !Number.isInteger(o.n) || o.n < 0) return null;
  const built = build(harness, readLines(path, at, Math.min(size, at + WINDOWS[1]!)).lines.filter((l) => l.at >= at), o.cwd ?? "");
  const all = built?.items ?? [];
  const hit = all[ids(all).indexOf(o.work)];
  if (!hit || hit.type !== "work" || hit.at !== at) return null;
  return hit.steps[o.n] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// a picture the user sent with a message
// ---------------------------------------------------------------------------------------------------------------------

export type RecordImage = { readonly type: string; readonly data: Buffer };
/** A picture is shown as a thumbnail: one larger than this is not sent. */
export const IMAGE_BYTES = 12 * 1024 * 1024;
/** A line with pictures in it is long (base64): this much is read for one. */
const IMAGE_LINE_BYTES = 48 * 1024 * 1024;
const IMAGE_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" };
/** What is served as a picture: never a type a browser would run (SVG), whatever the record calls it. */
const SERVED = new Set(Object.values(IMAGE_TYPES));

/** The `n`-th picture of the user's message `item` (its id: where its line begins). Claude Code keeps the picture in
 *  the line itself; Codex keeps where the file is (`local_image`), which is read if it is still there and a picture
 *  by its name. Null: no such message, no such picture, or one too large. */
export function readImage(harness: RecordHarness, path: string, item: string, n: number): RecordImage | null {
  const at = Number(item.split(".")[0]);
  const { size } = fileRev(path);
  if (!Number.isInteger(at) || at < 0 || at >= size || !Number.isInteger(n) || n < 0) return null;
  const line = readLines(path, at, Math.min(size, at + IMAGE_LINE_BYTES)).lines.find((l) => l.at === at)?.value;
  if (!line) return null;
  const pictures: Json[] = harness === "claude-code"
    ? (line.type === "attachment" ? (Array.isArray(obj(line.attachment).prompt) ? (obj(line.attachment).prompt as unknown[]).map(obj) : []) : parts(line)).filter((p) => p.type === "image")
    : (Array.isArray(obj(obj(line.payload).item).content) ? (obj(obj(line.payload).item).content as unknown[]).map(obj) : []).filter((p) => /image/i.test(str(p.type)));
  const picture = pictures[n];
  if (!picture) return null;
  const source = obj(picture.source);
  if (source.type === "base64" && str(source.data)) return decoded(str(source.media_type), str(source.data));
  // Codex: a data URL, or a file on this Mac.
  const url = str(picture.image_url) || str(picture.url);
  const inline = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  if (inline) return decoded(inline[1]!, inline[2]!);
  return pictureFile(str(picture.path));
}

/** The `k`-th picture a step brought back (2026-10-07, user: 这种readpng能不能展开后看到真的png内容呢): of the `n`-th step of
 *  the run of work `work`. Claude Code keeps it in the line of the tool's result; for Codex the file it looked at is
 *  read, if it is still there and a picture by its name. Null: no such step, no such picture, or one too large. */
export function readStepImage(harness: RecordHarness, path: string, o: { work: string; n: number; k: number; cwd?: string }): RecordImage | null {
  if (!Number.isInteger(o.k) || o.k < 0) return null;
  const shots = stepOf(harness, path, o)?.shots;
  if (!shots) return null;
  if ("file" in shots) return o.k === 0 ? pictureFile(shots.file) : null;
  const line = readLines(path, shots.at, Math.min(fileRev(path).size, shots.at + IMAGE_LINE_BYTES)).lines.find((l) => l.at === shots.at)?.value;
  const result = line && parts(line).find((p) => p.type === "tool_result" && str(p.tool_use_id) === shots.id);
  const picture = (Array.isArray(result?.content) ? result.content.map(obj) : []).filter((p) => p.type === "image")[o.k];
  const source = obj(picture?.source);
  return source.type === "base64" && str(source.data) ? decoded(str(source.media_type), str(source.data)) : null;
}

/** A picture file on this Mac, by its name a picture and no larger than is shown. */
function pictureFile(file: string): RecordImage | null {
  const type = IMAGE_TYPES[file.split(".").pop()?.toLowerCase() ?? ""];
  if (!file.startsWith("/") || !type) return null;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > IMAGE_BYTES) return null;
    const fd = openSync(file, "r");
    try { const data = Buffer.alloc(st.size); readSync(fd, data, 0, st.size, 0); return { type, data }; } finally { closeSync(fd); }
  } catch { return null; }
}

function decoded(type: string, base64: string): RecordImage | null {
  const kind = type.toLowerCase() === "image/jpg" ? "image/jpeg" : type.toLowerCase();
  if (!SERVED.has(kind) || base64.length > IMAGE_BYTES * 1.4) return null;
  const data = Buffer.from(base64, "base64");
  return data.length && data.length <= IMAGE_BYTES ? { type: kind, data } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// agents whose record is read coarsely (OpenCode, pi, an older Codex rollout): words, and one line per tool
// ---------------------------------------------------------------------------------------------------------------------

function coarseKind(tool: string): StepKind {
  const t = tool.toLowerCase();
  if (/^(read|view|cat)$/.test(t)) return "read";
  if (/^(grep|glob|search|find|rg)$/.test(t)) return "search";
  if (/^(ls|list)$/.test(t)) return "list";
  if (/^(bash|shell|exec|run|local_shell)$/.test(t)) return "run";
  if (/^(edit|multiedit|patch|apply_patch)$/.test(t)) return "edit";
  if (t === "write") return "write";
  if (/^(webfetch|websearch|web_search|fetch)$/.test(t)) return "web";
  if (/^(task|agent)$/.test(t)) return "agent";
  if (/^(todowrite|todoread|update_plan)$/.test(t)) return "todo";
  return "tool";
}

export function recordFromMessages(messages: readonly SessionMessage[], rev: string): SessionRecord {
  const b = new Builder();
  messages.forEach((m, i) => {
    if (m.role === "user") b.user(i, m.ts, m.text);
    else if (m.role === "assistant") b.answer(i, m.ts, m.text);
    else { const kind = coarseKind(m.tool ?? ""); b.step(i, m.ts, { kind, text: firstLine(m.text), ...(kind === "tool" && m.tool ? { tool: m.tool } : {}) }); }
  });
  const names = ids(b.items);
  return { items: b.items.map((it, i) => shown(it, `m${names[i]!}`)), more: false, cursor: 0, rev, plan: [], usage: null, mode: null };
}
