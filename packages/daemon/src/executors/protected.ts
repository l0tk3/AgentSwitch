/** Paths no executor may write, whatever cwd is (threads-v0 §5.1): the daemon's own home, the
 *  secret-gate home, the daemon's config, thread private dirs. "The model cannot edit its own
 *  guard rails" — a hard deny, never an approval. Claude Code enforces it in canUseTool, OpenCode
 *  through static deny patterns, and every harness through the engine's snapshot/restore backstop. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath, dataVolumeSpellings, isWithin, lineage } from "../core/paths.js";

export { canonicalPath } from "../core/paths.js";

export type ProtectedPaths = {
  readonly roots: readonly string[];    // canonical absolute paths
  readonly exempt: readonly string[];   // subtrees inside a root that executors may use (work dirs, uploads, artifacts)
  /** Credentials at rest that no executor may even read (2026-09-24): the gate home (its private keys), the browser
   *  session profiles (cookies), the shared browser's agent tokens and Playwright MCP's unredacted files, and the remote
   *  listener's TLS key. Claude checks its read tools, OpenCode gets read denies; Codex has no per-path read rule (a
   *  known gap, BOUNDARY.md). */
  readonly readDenied?: readonly string[];
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const DAEMON_CONFIG_DIR = resolve(HERE, "..", "..", "config");
const EXEMPT_UNDER_HOME = ["work", "artifacts", "uploads"] as const;

export const NO_PROTECTED: ProtectedPaths = { roots: [], exempt: [] };

/** What an executor is told when it reaches for a protected path (Claude's tools, Codex's escalated commands). */
export const PROTECTED_DENIAL = "denied by AgentSwitch: this path holds the daemon's own configuration or credentials; the model cannot change its own constraints";

/** The daemon's home, the gate's home and the gate service's socket, as `env` places them. */
function places(env: NodeJS.ProcessEnv): { home: string; gate: string; socket: string } {
  return {
    home: env.AGENTSWITCH_HOME ?? join(env.HOME ?? ".", ".agentswitch"),
    gate: env.SECRET_GATE_HOME ?? join(env.HOME ?? ".", ".secret-gate"),
    // The gate service's socket (gate-service-v0 §4): a best-effort stop for the plainest `nc -U`; the same uid is not a boundary.
    socket: join(env.SECRET_GATE_PUBLIC || GATE_PUBLIC_DIR, "gate.sock"),
  };
}

/** What stays closed in AgentSwitch's own terminals (docs/terminal-v0.md §3; 2026-09-30, user: a terminal is used like
 *  any terminal): only the gate's keys and socket, which open every ciphertext — neither read nor written. The daemon's
 *  files, its local token, the kept browser sessions and the remote TLS key are open there; the managed executors keep
 *  the whole table (`defaultProtected`). */
export function terminalProtected(env: NodeJS.ProcessEnv = process.env): ProtectedPaths {
  const { gate, socket } = places(env);
  const closed = [gate, socket].map(canonicalPath);
  return { roots: closed, exempt: [], readDenied: closed };
}

export function defaultProtected(env: NodeJS.ProcessEnv = process.env): ProtectedPaths {
  const { home, gate, socket } = places(env);
  return {
    roots: [home, gate, DAEMON_CONFIG_DIR, socket].map(canonicalPath),
    exempt: EXEMPT_UNDER_HOME.map((d) => canonicalPath(join(home, d))),
    // The local API's token too: an executor that read it could call the API to loosen its own approval policy.
    readDenied: [gate, socket, join(home, BROWSER_PROFILES_DIR), join(home, BROWSER_STATE_DIR), join(home, "remote"), join(home, LOCAL_TOKEN_NAME)].map(canonicalPath),
  };
}

/** Under `$AGENTSWITCH_HOME`: the local API token (api/localAuth.ts keeps the same name; executors never read it). */
export const LOCAL_TOKEN_NAME = "local-token";

/** Where the gate service publishes its CA, public keys and socket when it runs as its own account (gate-service-v0 §2). */
export const GATE_PUBLIC_DIR = "/Library/Application Support/AgentSwitch/gate-public";

/** Under `$AGENTSWITCH_HOME`: the browser session slots (browserSlots.ts). */
export const BROWSER_PROFILES_DIR = "browser-profiles";

/** Under `$AGENTSWITCH_HOME`: the shared browser's audit, its agents' token files and Playwright MCP's folders
 *  (browser/setup.ts). */
export const BROWSER_STATE_DIR = "browser";

/* Paths are compared by canonical spelling and by identity (core/paths.ts): `..`, symlinks, letter case and the data
 * volume's firmlinks (`/System/Volumes/Data/Users/…`, which got past these checks before 2026-10-02) all land on the
 * root they are inside. */

/** True when `path` (absolute or relative to cwd) lands inside a read-denied root. */
export function isReadDenied(path: string, cwd: string, prot: ProtectedPaths): boolean {
  const p = canonicalPath(resolve(cwd, path));
  const chain = lineage(p);
  return (prot.readDenied ?? []).some((r) => isWithin(p, r, chain));
}

/** True when a search rooted at `path` would reach into a read-denied root (`Grep` over `~` finds the gate's keys). */
export function containsReadDenied(path: string, cwd: string, prot: ProtectedPaths): boolean {
  const p = canonicalPath(resolve(cwd, path));
  return (prot.readDenied ?? []).some((r) => isWithin(r, p));
}

/** True when `path` (absolute or relative to cwd) lands inside a protected root and not in an exempt subtree. */
export function isProtected(path: string, cwd: string, prot: ProtectedPaths): boolean {
  const p = canonicalPath(resolve(cwd, path));
  const chain = lineage(p);
  if (prot.exempt.some((e) => isWithin(p, e, chain))) return false;
  return prot.roots.some((r) => isWithin(p, r, chain));
}

/** The spellings a static rule (OpenCode's, Claude Code's, Codex's: matched as text) needs for `root`: as it is and on
 *  the data volume (`/System/Volumes/Data/Users/…`), which the file system takes for the same place. */
export function rootSpellings(root: string): string[] {
  return dataVolumeSpellings(root);
}

/** A shell command's words as the shell would read them: quotes and backslash escapes resolved, so
 *  `Application\ Support/AgentSwitch` and "…/Application Support/AgentSwitch" are one path each (the Mac app's home has
 *  a space; a whitespace split missed both, 2026-09-24). Operators and redirections end a word. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | "\"" | null = null;
  const end = () => { if (started) words.push(word); word = ""; started = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    // A backslash-newline outside single quotes is a line continuation: gone, not part of the word.
    if (ch === "\\" && command[i + 1] === "\n" && quote !== "'") { i++; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === "\"" && ch === "\\" && i + 1 < command.length && "\"\\$`".includes(command[i + 1]!)) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") { quote = ch; started = true; continue; }
    if (ch === "\\" && i + 1 < command.length) { word += command[++i]; started = true; continue; }
    if (/\s/.test(ch) || ";&|<>()`".includes(ch)) { end(); continue; }
    word += ch;
    started = true;
  }
  end();
  return words;
}

/** Path-looking words of a shell command, `~` and `$HOME` expanded, so `rm -rf ~/.agentswitch/skills`,
 *  `> config/targets.yaml` and `cat "$HOME/Library/Application Support/AgentSwitch/x"` are caught. */
export function pathTokens(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? "";
  const expand = (t: string) => t.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
  return shellWords(command).map(expand).filter((t) => t.includes("/") || t.startsWith("."));
}

/** The command as one string with quotes, escapes and line continuations gone and `~`, `$HOME`, `${HOME}` expanded:
 *  a root spelled anywhere in it — inside `sh -c "…"`, a `python3 -c` string, `--cacert=…`, `$(…)` — shows up whole. */
export function flattenShell(command: string, home: string): string {
  const text = command.replace(/\\\r?\n/g, "").replace(/\\(.)/g, "$1").replace(/["']/g, "");
  if (!home) return text;
  return text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home).replace(/(^|[\s=:(|;&<>`])~(?=\/|$|[\s;|&)<>`])/g, `$1${home}`);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** macOS names the temp dirs with and without `/private`. */
const spellings = (root: string): string[] => (/^\/private\/(var|tmp)\//.test(root) ? [root, root.slice("/private".length)] : [root]);

/** Every protected or read-denied root the flattened command spells out, with the path that follows it
 *  (`<root>/work/t1` is still judged as the exempt work dir). Case-insensitive: the Mac's disk is. */
function namedRoots(command: string, prot: ProtectedPaths, env: NodeJS.ProcessEnv): string[] {
  const text = flattenShell(command, env.HOME ?? "");
  const out: string[] = [];
  for (const root of new Set([...prot.roots, ...(prot.readDenied ?? [])])) {
    for (const spelling of spellings(root)) {
      for (const m of text.matchAll(new RegExp(`${escapeRegExp(spelling)}([^\\s;&|<>()\`]*)`, "gi"))) out.push(root + m[1]);
    }
  }
  return out;
}

/** The first protected path a shell command names, or null. String matching, so a floor: a path reached relative to a
 *  `cd`, through a glob, a variable or `find` is not seen (BOUNDARY.md); the snapshot backstop covers roots inside cwd. */
export function commandTouchesProtected(command: string, cwd: string, prot: ProtectedPaths, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const t of [...pathTokens(command, env), ...namedRoots(command, prot, env)]) if (isProtected(t, cwd, prot) || isReadDenied(t, cwd, prot)) return t;
  return null;
}

/** Protected subtrees that lie inside cwd (e.g. cwd = this repo → packages/daemon/config). */
export function protectedInside(cwd: string, prot: ProtectedPaths): string[] {
  const c = canonicalPath(cwd);
  return prot.roots.filter((r) => isWithin(r, c) && !prot.exempt.some((e) => isWithin(r, e)));
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
