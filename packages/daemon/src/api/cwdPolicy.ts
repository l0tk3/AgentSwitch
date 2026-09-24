/** Where a task may run (design-v0 B.2 rule 4, the deny half): an existing absolute directory that is not the
 *  filesystem root, the home directory itself, one of the places holding credentials or the daemon's own state, or a
 *  directory containing one of them (`/Users` holds `~/.secret-gate`).
 *
 *  Paths are compared the way the OS will open them: symlinks resolved (`/Volumes/Macintosh HD` → `/`, `/tmp` →
 *  `/private/tmp`, `..` after a symlink), and by device + inode as well as by path, which also catches spellings realpath
 *  keeps (the firmlink `/System/Volumes/Data/Users` = `/Users`, `/.vol/<dev>/<ino>`, `/.nofollow/…`, case variants). */

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type CwdRules = { readonly home: string; readonly denied: readonly string[] };

const DENIED_UNDER_HOME = [".ssh", ".claude", ".codex", ".agentswitch", ".secret-gate", "Library", ".gnupg", ".aws", ".config"] as const;
/** macOS mounts the data volume here too; `/Users/x` is also `/System/Volumes/Data/Users/x`. */
const DATA_VOLUME = "/System/Volumes/Data";

export function defaultCwdRules(env: NodeJS.ProcessEnv = process.env, daemonHome?: string): CwdRules {
  const home = env.HOME ?? "/";
  const denied = [...DENIED_UNDER_HOME.map((d) => resolve(home, d)), ...(daemonHome ? [resolve(daemonHome)] : []), ...(env.SECRET_GATE_HOME ? [resolve(env.SECRET_GATE_HOME)] : [])];
  return { home, denied };
}

/** `p` with every symlink resolved by the OS (so `..` after a symlink goes where the OS goes): realpath of the nearest
 *  existing ancestor, the missing rest appended. */
export function physicalPath(p: string): string {
  const missing: string[] = [];
  for (let head = p; ;) {
    try { return join(realpathSync.native(head), ...missing); }
    catch {
      const up = dirname(head);
      if (up === head) return resolve(p);
      missing.unshift(basename(head));
      head = up;
    }
  }
}

/** Device + inode of what `p` names (symlinks followed), or null when it does not exist. */
function identity(p: string): string | null {
  try { const s = statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; } catch { return null; }
}

/** A directory as a path the OS resolves to plus, when it exists, its identity. */
type Place = { readonly path: string; readonly id: string | null };
const place = (p: string): Place => ({ path: physicalPath(p), id: identity(p) });

/** `path` and each of its parents up to "/". */
function lineage(path: string): string[] {
  const out = [path];
  for (let p = path; dirname(p) !== p;) { p = dirname(p); out.push(p); }
  return out;
}

/** True when `outer` is `inner` or one of its parents, by path or by identity. */
function contains(outer: Place, inner: Place): boolean {
  return lineage(inner.path).some((p) => p === outer.path || (outer.id !== null && identity(p) === outer.id));
}

/** The places a denied root can be reached by: its physical path and, on macOS, the same directory under the data volume. */
function deniedPlaces(rules: CwdRules): { readonly root: string; readonly places: readonly Place[] }[] {
  return rules.denied.map((root) => {
    const at = place(root);
    const alias = DATA_VOLUME + at.path;
    return { root, places: at.id !== null && identity(alias) === at.id ? [at, { path: alias, id: at.id }] : [at] };
  });
}

/** Paths directly under "/" whose name starts with a dot are resolution tricks on macOS (/.vol, /.nofollow, /.resolve). */
const special = (path: string): boolean => path.split(sep)[1]?.startsWith(".") ?? false;

/** The denied root that `path` (a file or directory) lies in, or null. For re-checking what the API is about to serve. */
export function deniedRootOf(path: string, rules: CwdRules): string | null {
  const target = place(path);
  return deniedPlaces(rules).find((d) => d.places.some((p) => contains(p, target)))?.root ?? null;
}

/** null when `cwd` is somewhere a task may run, whether or not it exists yet, else the reason. */
function placeProblem(cwd: string, rules: CwdRules): string | null {
  if (!isAbsolute(cwd)) return "cwd must be an absolute path";
  const at = place(cwd);
  const p = at.path;
  if (special(resolve(cwd)) || special(p)) return `cwd ${p} is a special system path; pick a project directory`;
  const broad = [place("/"), place(rules.home)];
  if (broad.some((b) => b.path === p || (b.id !== null && b.id === at.id))) return `cwd ${p} is too broad; pick a project directory`;
  for (const { root, places } of deniedPlaces(rules)) {
    if (places.some((d) => contains(d, at))) return `cwd ${p} is under ${root}, which holds credentials or the daemon's own state`;
    if (places.some((d) => contains(at, d))) return `cwd ${p} contains ${root}, which holds credentials or the daemon's own state`;
  }
  return null;
}

const isDirectory = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** null when the directory is acceptable, else the reason. */
export function checkCwd(cwd: string, rules: CwdRules): string | null {
  return placeProblem(cwd, rules) ?? (isDirectory(cwd) ? null : `cwd ${physicalPath(cwd)} is not an existing directory`);
}

/** True when `cwd` is a work dir the daemon made (under `workRoot`, inside the daemon's own home). */
export function isWorkDir(cwd: string, workRoot: string): boolean {
  const p = physicalPath(cwd);
  const root = physicalPath(workRoot);
  return p.startsWith(root + sep);
}

/** For a cwd taken over from an earlier task (follow-up, handoff, file downloads): a daemon work dir is fine, any other
 *  must still be an allowed place (a task stored before the rules were tightened may hold one they refuse). Whether it
 *  still exists is left to the caller, as before. */
export function checkStoredCwd(cwd: string, rules: CwdRules, workRoot: string): string | null {
  return isWorkDir(cwd, workRoot) ? null : placeProblem(cwd, rules);
}
