/** The files of a terminal's folder by name, for a reply's `@` (docs/simple-view-v0.md §5.5): what the agent's own
 *  prompt completes when a file is mentioned. Git's own list where the folder is a repository (tracked and untracked,
 *  ignored files left out), else a bounded walk that skips what nobody mentions (dot folders, node_modules, build
 *  output). Read at most every 15 s per folder; the folder is the terminal's, never a caller's. */

import { spawn } from "node:child_process";
import { existsSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { gitBinary } from "./gitStatus.js";

/** No more than this many files are listed or looked through. */
export const MAX_FILES = 40_000;
const FRESH_MS = 15_000;
const SKIPPED = new Set(["node_modules", "build", "dist", "DerivedData", "target", "out", "vendor", "Pods", "__pycache__"]);

const held = new Map<string, { at: number; files: Promise<readonly string[]> }>();

/** Every file under `cwd`, as paths from it. */
export function folderFiles(cwd: string, now: () => number = Date.now): Promise<readonly string[]> {
  const had = held.get(cwd);
  if (had && now() - had.at < FRESH_MS) return had.files;
  const files = (async () => (await gitFiles(cwd)) ?? walked(cwd))();
  held.set(cwd, { at: now(), files });
  if (held.size > 60) held.delete(held.keys().next().value!);
  return files;
}

function gitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    // The git that is really there (macOS's stub without the developer tools would ask to install them).
    const git = gitBinary();
    if (!git || !existsSync(cwd)) return resolve(null);
    let out = "", done = false;
    const finish = (v: string[] | null) => { if (!done) { done = true; resolve(v); } };
    const child = spawn(git, ["-c", "core.fsmonitor=false", "--no-optional-locks", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, 2500);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { out += d; if (out.length > 8_000_000) { child.kill("SIGKILL"); } });
    child.on("error", () => { clearTimeout(timer); finish(null); });
    // Not a repository (git says so and lists nothing): the folder is walked instead.
    child.on("close", (code) => { clearTimeout(timer); finish(code === 0 ? out.split("\0").filter(Boolean).slice(0, MAX_FILES) : null); });
  });
}

function walked(cwd: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (files.length >= MAX_FILES || depth > 8) return;
    let handle;
    try { handle = opendirSync(dir); } catch { return; }
    try {
      for (let e = handle.readSync(); e && files.length < MAX_FILES; e = handle.readSync()) {
        if (e.name.startsWith(".") || SKIPPED.has(e.name)) continue;
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), path, depth + 1);
        else if (e.isFile()) files.push(path);
      }
    } finally { handle.closeSync(); }
  };
  walk(cwd, "", 0);
  return files;
}

/** The files `query` may mean, best first, at most `limit`: a name that starts with it, then a name that has it, then
 *  a path that has it — each time the shorter path first. Nothing typed: the files nearest the folder's top. Case is
 *  not told apart. */
export function matchFiles(files: readonly string[], query: string, limit = 12): string[] {
  const q = query.toLowerCase();
  const scored: { path: string; rank: number }[] = [];
  for (const path of files) {
    const low = path.toLowerCase();
    const name = low.slice(low.lastIndexOf("/") + 1);
    const rank = !q ? 3 : name.startsWith(q) ? 0 : name.includes(q) ? 1 : low.includes(q) ? 2 : -1;
    if (rank >= 0) scored.push({ path, rank });
  }
  const depth = (p: string) => p.split("/").length;
  return scored.sort((a, b) => a.rank - b.rank || (q ? a.path.length - b.path.length : depth(a.path) - depth(b.path)) || (a.path < b.path ? -1 : 1))
    .slice(0, limit).map((s) => s.path);
}
