/** Earlier versions of CONTEXT.md (app-v0 §6): before a save replaces the file, the old text is kept in
 *  `context-history/` next to it as `<ISO time>-<seq>-<source>.md` (source `local`, or `device-<id>` for a paired
 *  phone), newest CONTEXT_HISTORY_KEEP only. A bad edit, or one made with a lost phone's token, is undone on the Mac
 *  by copying a version back. */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CONTEXT_HISTORY_KEEP = 20;
const SEQ_DIGITS = 6;

export const contextHistoryDir = (contextPath: string): string => join(dirname(contextPath), "context-history");

/** Orders saves within one millisecond; names sort by time first, so a restart's counter reset does no harm. */
let seq = 0;

/** Keep the current file before `next` replaces it; the kept path, or null when there is nothing new to keep. */
export function keepPrevious(contextPath: string, next: string, source: string, now: Date = new Date()): string | null {
  if (!existsSync(contextPath)) return null;
  const previous = readFileSync(contextPath, "utf8");
  if (previous === next) return null;
  const dir = contextHistoryDir(contextPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  seq = (seq + 1) % 10 ** SEQ_DIGITS;
  const path = join(dir, `${now.toISOString().replace(/[:.]/g, "-")}-${String(seq).padStart(SEQ_DIGITS, "0")}-${source}.md`);
  writeFileSync(path, previous, { mode: 0o600 });
  prune(dir);
  return path;
}

function prune(dir: string): void {
  const versions = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  for (const name of versions.slice(0, Math.max(0, versions.length - CONTEXT_HISTORY_KEEP))) rmSync(join(dir, name), { force: true });
}
