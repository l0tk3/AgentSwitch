/** Kept files that go when their time is up: staged uploads, and what the old Dispatch's tasks kept. */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Remove entries in `dir` whose mtime is older than `maxAgeMs`; returns the removed names. */
export function sweepDir(dir: string, maxAgeMs: number, now = Date.now()): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (now - statSync(p).mtimeMs <= maxAgeMs) continue;
    rmSync(p, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
