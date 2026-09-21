/** Paths no executor may write, whatever cwd is (threads-v0 §5.1): the daemon's own home, the
 *  secret-gate home, the daemon's config, thread private dirs. "The model cannot edit its own
 *  guard rails" — a hard deny, never an approval. Claude Code enforces it in canUseTool, OpenCode
 *  through static deny patterns, and every harness through the engine's snapshot/restore backstop. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type ProtectedPaths = {
  readonly roots: readonly string[];    // canonical absolute paths
  readonly exempt: readonly string[];   // subtrees inside a root that executors may use (work dirs, uploads, artifacts)
};

const HERE = new URL(".", import.meta.url).pathname;
export const DAEMON_CONFIG_DIR = resolve(HERE, "..", "..", "config");
const EXEMPT_UNDER_HOME = ["work", "artifacts", "uploads"] as const;

export const NO_PROTECTED: ProtectedPaths = { roots: [], exempt: [] };

/** Canonical form used for every comparison: resolved, without a trailing separator. */
export function canonicalPath(p: string): string {
  const r = resolve(p);
  try { return realpathSync(r); } catch { return r; }
}

export function defaultProtected(env: NodeJS.ProcessEnv = process.env): ProtectedPaths {
  const home = env.AGENTSWITCH_HOME ?? join(env.HOME ?? ".", ".agentswitch");
  const gate = env.SECRET_GATE_HOME ?? join(env.HOME ?? ".", ".secret-gate");
  return {
    roots: [home, gate, DAEMON_CONFIG_DIR].map(canonicalPath),
    exempt: EXEMPT_UNDER_HOME.map((d) => canonicalPath(join(home, d))),
  };
}

const under = (p: string, root: string): boolean => p === root || p.startsWith(root + sep);

/** True when `path` (absolute or relative to cwd) lands inside a protected root and not in an exempt subtree. */
export function isProtected(path: string, cwd: string, prot: ProtectedPaths): boolean {
  const p = canonicalPath(resolve(cwd, path));
  if (prot.exempt.some((e) => under(p, e))) return false;
  return prot.roots.some((r) => under(p, r));
}

/** Path-looking tokens of a shell command, so `rm -rf ~/.agentswitch/skills` or `> config/targets.yaml` are caught. */
export function pathTokens(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? "";
  return (command.match(/[^\s"'`;&|<>()]+/g) ?? [])
    .filter((t) => t.includes("/") || t.startsWith("~") || t.startsWith("."))
    .map((t) => (t.startsWith("~") ? home + t.slice(1) : t));
}

/** The first protected path a shell command names, or null. Heuristic: a deny here is a floor, the snapshot backstop is the wall. */
export function commandTouchesProtected(command: string, cwd: string, prot: ProtectedPaths, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const t of pathTokens(command, env)) if (isProtected(t, cwd, prot)) return t;
  return null;
}

/** Protected subtrees that lie inside cwd (e.g. cwd = this repo → packages/daemon/config). */
export function protectedInside(cwd: string, prot: ProtectedPaths): string[] {
  const c = canonicalPath(cwd);
  return prot.roots.filter((r) => under(r, c) && !prot.exempt.some((e) => under(r, e)));
}

export type Snapshot = Readonly<Record<string, { readonly hash: string; readonly content: Buffer } | null>>;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
}

/** Hash + content of every file under the protected subtrees inside cwd. Missing roots are recorded as absent. */
export function snapshotProtected(cwd: string, prot: ProtectedPaths): Snapshot {
  const out: Record<string, { hash: string; content: Buffer } | null> = {};
  for (const root of protectedInside(cwd, prot)) {
    if (!existsSync(root)) { out[root] = null; continue; }
    const files: string[] = [];
    walk(root, files);
    for (const f of files) {
      const content = readFileSync(f);
      out[f] = { hash: createHash("sha256").update(content).digest("hex"), content };
    }
  }
  return out;
}

/** Compare the tree with the snapshot, put every changed/added/removed file back, return what was touched. */
export function restoreProtected(cwd: string, prot: ProtectedPaths, before: Snapshot): string[] {
  const touched: string[] = [];
  const after = snapshotProtected(cwd, prot);
  for (const [path, was] of Object.entries(before)) {
    if (was === null) { if (after[path] !== undefined && after[path] !== null) { rmSync(path, { recursive: true, force: true }); touched.push(path); } continue; }
    const now = after[path];
    if (now && now.hash === was.hash) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, was.content);
    touched.push(path);
  }
  for (const path of Object.keys(after)) {
    if (before[path] === undefined && after[path] !== null) { rmSync(path, { force: true }); touched.push(path); }
  }
  return [...new Set(touched)].sort();
}
