/** Searching what was said in the Mac's coding sessions (docs/terminal-v0.md §1 搜索): the prompts the user typed and
 *  the agents' replies — not tool calls or their output — in the sessions the tree lists. The names of folders,
 *  terminals and sessions are searched where they are shown; this is the part only the Mac can do. Each session's words
 *  are kept once read and only what was added since is read again (a transcript grows at its end), so a search after
 *  the first is quick; the reading yields between sessions so terminals keep streaming. */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { claudeSaid } from "./claude.js";
import { codexSaid } from "./codex.js";
import { piSaid } from "./pi.js";
import { obj } from "./jsonl.js";
import type { SessionMonitor } from "./monitor.js";
import { openCodeMessages } from "./opencode.js";
import type { SessionHarness, SessionSummary } from "./types.js";

export type SessionHit = {
  readonly harness: SessionHarness;
  readonly id: string;
  /** The words around the first match, on one line, with `…` where cut. */
  readonly excerpt: string;
};

/** A session's words as far as read: `offset` is where its file was read up to (a whole line). */
type Words = { offset: number; updatedAt: number; text: string; lower: string };

/** At most this much of a session's words is kept (the latest). */
const KEEP_CHARS = 1_000_000;
/** A transcript is read in slices of this much. */
const SLICE_BYTES = 4 * 1024 * 1024;
/** Only the last this much of a transcript is read the first time (tens of megabytes are mostly tool output). */
const FIRST_READ_BYTES = 48 * 1024 * 1024;
const BEFORE = 24;
const AFTER = 56;

export class SessionSearch {
  private readonly words = new Map<string, Words>();

  constructor(private readonly monitor: SessionMonitor) {}

  /** The sessions among the newest `within` (all the tree lists) whose words contain `query` (case aside), newest
   *  first, at most `max`. */
  async search(query: string, within = Infinity, max = 30): Promise<SessionHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: SessionHit[] = [];
    const listed = this.monitor.list(within);
    // Words of sessions no longer listed (deleted, aged out) are let go.
    const keys = new Set(listed.map((s) => `${s.harness}:${s.id}`));
    for (const key of this.words.keys()) if (!keys.has(key)) this.words.delete(key);
    for (const s of listed) {
      const w = this.read(s);
      await new Promise((r) => setImmediate(r));
      const at = w?.lower.indexOf(q) ?? -1;
      if (at < 0 || !w) continue;
      hits.push({ harness: s.harness, id: s.id, excerpt: excerpt(w.text, at, q.length) });
      if (hits.length >= max) break;
    }
    return hits;
  }

  private read(s: SessionSummary): Words | null {
    const key = `${s.harness}:${s.id}`;
    const source = this.monitor.source(s.harness, s.id);
    if (!source) return null;
    const had = this.words.get(key);
    try {
      if (s.harness === "opencode") {
        if (had && had.updatedAt === s.updatedAt) return had;
        const text = keep(openCodeMessages(source, s.id, 5000).filter((m) => m.role !== "tool").map((m) => m.text).join("\n"));
        return this.store(key, { offset: 0, updatedAt: s.updatedAt, text, lower: text.toLowerCase() });
      }
      const size = statSync(source).size;
      if (had && had.offset === size) return had;
      // Grown: only what was added. Shorter than read before: rewritten (compacted, restored), read again.
      const grown = had !== undefined && had.offset < size;
      const from = grown ? had.offset : Math.max(0, size - FIRST_READ_BYTES);
      const said = s.harness === "claude-code" ? claudeSaid : s.harness === "pi" ? piSaid : codexSaid;
      const { lines, end } = readLines(source, from, size, !grown && from > 0);
      const added = lines.map((line) => lineSaid(line, s.harness, said)).filter((t): t is string => !!t).join("\n");
      const base = grown ? had.text : "";
      const text = keep(base && added ? `${base}\n${added}` : base || added);
      return this.store(key, { offset: end, updatedAt: s.updatedAt, text, lower: text.toLowerCase() });
    } catch {
      return had ?? null;
    }
  }

  private store(key: string, w: Words): Words {
    this.words.set(key, w);
    return w;
  }
}

/** A line's words, parsed only when it can hold them: Claude Code's tool results (often whole files), Codex's
 *  non-message lines and pi's tool results are passed over without parsing. */
function lineSaid(line: string, harness: SessionHarness, said: (l: Record<string, unknown>) => string | null): string | null {
  if (harness === "claude-code") {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return null;
    if (line.includes('"type":"tool_result"') && !line.includes('"type":"text"')) return null;
  } else if (!line.includes('"type":"message"')) return null;
  else if (harness === "pi" && line.includes('"role":"toolResult"')) return null;
  try { return said(obj(JSON.parse(line))); } catch { return null; }
}

/** Whole lines of `path` from `from` to `size`: the first dropped when it may be cut, a last one without its newline
 *  left for next time (it is still being written). `end`: where the next read starts. */
function readLines(path: string, from: number, size: number, cutFirst: boolean): { lines: string[]; end: number } {
  const fd = openSync(path, "r");
  const lines: string[] = [];
  let pos = from, carry = Buffer.alloc(0), first = cutFirst;
  try {
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(SLICE_BYTES, size - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      let chunk = Buffer.concat([carry, buf.subarray(0, n)]);
      let nl: number;
      while ((nl = chunk.indexOf(10)) >= 0) {
        const line = chunk.subarray(0, nl).toString("utf8");
        chunk = chunk.subarray(nl + 1);
        if (first) { first = false; continue; }
        if (line.trim()) lines.push(line);
      }
      carry = chunk;
    }
  } finally {
    closeSync(fd);
  }
  return { lines, end: pos - carry.length };
}

function keep(text: string): string {
  return text.length > KEEP_CHARS ? text.slice(text.length - KEEP_CHARS) : text;
}

function excerpt(text: string, at: number, length: number): string {
  const from = Math.max(0, at - BEFORE);
  const to = Math.min(text.length, at + length + AFTER);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}
