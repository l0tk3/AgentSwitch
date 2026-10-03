/** Where a path really is, however it is spelled (packages/secret-gate/BOUNDARY.md; docs/browser-v0.md §6). Every
 *  "is this inside a protected folder?" check of the daemon goes through here: the executors' protected paths
 *  (protected.ts) and the shared browser's file rules (browser/rules.ts).
 *
 *  A path has many spellings on a Mac: `..`, symlinks, any letter case (the disk ignores case), and the data volume's
 *  firmlinks: `/System/Volumes/Data/Users/<u>/…` is `/Users/<u>/…`, and `realpath` keeps whichever was asked
 *  (2026-10-02 review: `/System/Volumes/Data$AGENTSWITCH_HOME/local-token` got past the browser's deny list). So a path
 *  is compared twice: by its canonical spelling (resolved, symlinks followed, the disk's own case, the data volume's
 *  prefix gone), and by identity — the device and inode of the path and of every folder above it, against the root's —
 *  which no other alias (a mount of the same volume elsewhere, a spelling not thought of here) changes. Hard links to a
 *  file have one identity per name only as far as their folder goes; folders cannot be hard-linked on APFS. */

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Where macOS mounts the data volume; its top folders (`Users`, `private`, `Applications`, …) are firmlinked to `/`. */
export const DATA_VOLUME = "/System/Volumes/Data";

/** The folders of `/` that are the data volume's own (/usr/share/firmlinks, as far as a person's or AgentSwitch's files
 *  go): under them, `/System/Volumes/Data/<path>` is `<path>`. */
const FIRMLINKED = ["/Users", "/Applications", "/Library", "/private", "/opt", "/usr/local", "/Volumes", "/cores"];

/** `path` as written, and as the data volume spells it when it lies under a firmlinked folder: for rules that match
 *  paths as text (OpenCode's, Claude Code's, Codex's own settings). */
export function dataVolumeSpellings(path: string): string[] {
  return FIRMLINKED.some((f) => startsWithFolder(path, f)) ? [path, `${DATA_VOLUME}${path}`] : [path];
}

/** A file's identity (device and inode), or null when it does not exist or cannot be read. */
export function fileId(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

const startsWithFolder = (p: string, root: string): boolean => {
  const a = p.toLowerCase();
  const b = root.toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** `/System/Volumes/Data/<rest>` → `/<rest>` when the two are the same place (the deepest part of `<rest>` that exists
 *  is the same file in both spellings); anything else as it is. */
export function withoutDataVolume(p: string): string {
  if (!startsWithFolder(p, DATA_VOLUME) || p.length === DATA_VOLUME.length) return p;
  const rest = p.slice(DATA_VOLUME.length);
  for (let a = rest; a !== dirname(a); a = dirname(a)) {
    const plain = fileId(a);
    if (plain === null) continue;
    return fileId(DATA_VOLUME + a) === plain ? rest : p;
  }
  return p;
}

/** The canonical spelling used for every comparison: resolved, the deepest part that exists with its symlinks followed
 *  and in the disk's own case (`realpath`, native), the rest as given, the data volume's prefix gone, no trailing
 *  separator. */
export function canonicalPath(p: string): string {
  const full = resolve(p);
  let head = full;
  const tail: string[] = [];
  for (;;) {
    try {
      head = realpathSync.native(head);
      break;
    } catch {
      const parent = dirname(head);
      if (parent === head) return withoutDataVolume(full);
      tail.unshift(basename(head));
      head = parent;
    }
  }
  return withoutDataVolume(tail.length ? join(head, ...tail) : head);
}

/** The identities of `path` and of every folder above it that exists, innermost first. */
export function lineage(path: string): readonly string[] {
  const out: string[] = [];
  for (let a = resolve(path); ; a = dirname(a)) {
    const id = fileId(a);
    if (id !== null) out.push(id);
    if (a === dirname(a)) return out;
  }
}

/** True when `path` is `root` or inside it: by canonical spelling (case ignored, as the disk does) or by identity (an
 *  existing `root` is `path` or one of the folders above it). Pass `chain` (`lineage(path)`) to check many roots. */
export function isWithin(path: string, root: string, chain: readonly string[] = lineage(path)): boolean {
  if (startsWithFolder(path, root)) return true;
  const id = fileId(root);
  if (id !== null) return chain.includes(id);
  // A root that does not exist (yet): by spelling, the canonical one too (`/tmp/x` is `/private/tmp/x`).
  const canonical = canonicalPath(root);
  return canonical !== root && startsWithFolder(path, canonical);
}
