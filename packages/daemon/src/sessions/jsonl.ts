/** Reading the start and the end of a transcript without loading it: Claude Code's run to tens of megabytes. */

import { closeSync, openSync, readSync, statSync } from "node:fs";

export const HEAD_BYTES = 256 * 1024;
export const TAIL_BYTES = 512 * 1024;

function readRange(path: string, start: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Parsed JSON lines of the first `bytes` (the last, possibly cut, line dropped). */
export function headLines(path: string, bytes = HEAD_BYTES): unknown[] {
  const size = statSync(path).size;
  const text = readRange(path, 0, Math.min(size, bytes));
  const lines = text.split("\n");
  if (size > bytes) lines.pop();
  return parseLines(lines);
}

/** Parsed JSON lines of the last `bytes` (the first, possibly cut, line dropped). */
export function tailLines(path: string, bytes = TAIL_BYTES): unknown[] {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const lines = readRange(path, start, size - start).split("\n");
  if (start > 0) lines.shift();
  return parseLines(lines);
}

function parseLines(lines: readonly string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line still being written */ }
  }
  return out;
}

export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? v as Json : {});
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const time = (v: unknown): number => {
  const t = typeof v === "number" ? v : Date.parse(str(v));
  return Number.isFinite(t) ? t : 0;
};

/** Text a user typed, not what a tool or the harness put in the user turn (reminders, command echoes, contexts). */
export function isTypedText(text: string): boolean {
  const t = text.trim();
  return !!t && !/^(<[a-z_-]+[\s>]|Caveat:|\[Request interrupted|# AGENTS\.md|<environment_context|<user_instructions)/i.test(t);
}
