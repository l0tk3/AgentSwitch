/** Task file access: list a directory tree, resolve a download path safely inside it, copy out/ into
 *  the artifacts store before an ephemeral working directory is deleted, sweep old entries. */

import { cpSync, existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { OUT_DIR } from "./names.js";

export type TreeEntry = { readonly path: string; readonly size: number; readonly mtime: number };

const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", ".DS_Store"]);
export const MAX_TREE_ENTRIES = 500;

/** Files under `root` (relative POSIX paths, sorted), skipping VCS and dependency folders. */
export function listTree(root: string, max = MAX_TREE_ENTRIES): TreeEntry[] {
  if (!existsSync(root)) return [];
  const out: TreeEntry[] = [];
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= max || SKIP.has(d.name)) continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) { const st = statSync(p); out.push({ path: relative(root, p).split(sep).join("/"), size: st.size, mtime: st.mtimeMs }); }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Absolute path of a regular file `rel` inside `root`, or null (missing, directory, or escapes root). */
export function resolveInside(root: string, rel: string): string | null {
  const base = resolve(root);
  const target = resolve(base, rel);
  if (target !== base && !target.startsWith(base + sep)) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  try {
    const real = realpathSync(target);
    const realBase = realpathSync(base);
    if (!real.startsWith(realBase + sep)) return null;   // symlink pointing outside
  } catch { return null; }
  return target;
}

/** Copy <cwd>/out into `dest`; returns how many files were copied (0 = nothing to keep, dest untouched). */
export function collectOut(cwd: string, dest: string): number {
  const src = join(cwd, OUT_DIR);
  const files = listTree(src);
  if (!files.length) return 0;
  cpSync(src, dest, { recursive: true, dereference: true });
  return files.length;
}

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
