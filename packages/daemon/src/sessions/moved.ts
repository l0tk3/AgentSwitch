/** A session whose folder is gone: moved, renamed or deleted (docs/terminal-v0.md §5, 2026-10-03, user: 如果会话没了选择
 *  新目录继续). The agents keep sessions by the folder they ran in; continued in another folder, they go on there. */

import { statSync } from "node:fs";
import { basename, dirname } from "node:path";

/** Folders of the same name offered at most. */
const MAX_ALIKE = 5;

export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Where a session lives now: the folder it began in, unless that folder is gone and the session went on since in one
 *  that is there (continued after a move). A session that only `cd`'d into a subfolder stays where it began. */
export function currentFolder(began: string, latest: string | undefined, isDir: (path: string) => boolean = isDirectory): string {
  return latest && latest !== began && !isDir(began) && isDir(latest) ? latest : began;
}

/** Where a session the agent itself moved lives now: the folder it was moved to while that is there (Claude Code's
 *  `relocated`, a Codex turn in another folder — said only when it went on elsewhere), else where it began. */
export function movedFolder(began: string, movedTo: string | undefined, isDir: (path: string) => boolean = isDirectory): string {
  return movedTo && movedTo !== began && isDir(movedTo) ? movedTo : began;
}

/** Where a gone folder may be now: folders of the same name the Mac knows (its sessions', its terminals'), and the
 *  nearest folder above it that is still there. */
export function whereNow(gone: string, known: Iterable<string>, isDir: (path: string) => boolean = isDirectory): { alike: string[]; near: string | null } {
  const name = basename(gone);
  const alike = [...new Set(known)].filter((p) => p !== gone && basename(p) === name && isDir(p)).sort().slice(0, MAX_ALIKE);
  let near: string | null = null;
  for (let p = dirname(gone); near === null; p = dirname(p)) {
    if (isDir(p)) near = p;
    else if (p === dirname(p)) break;
  }
  // Offered once: a folder of the same name may be the nearest one above too (an Xcode project's MyApp/MyApp).
  return { alike, near: near !== null && alike.includes(near) ? null : near };
}
