/** `which` without a shell or a dependency: find a command on a PATH string. POSIX only (no PATHEXT). */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** True for a regular file this process may execute. */
function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the first executable `name` on `path`, or null. Empty and relative entries are skipped: they mean
 *  "wherever the process happens to run", which is no place to pick up a binary from. */
export function which(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}

/** A configured command: an absolute path that exists wins; a missing absolute path (a catalog written on another
 *  Mac, e.g. a CLI inside an app bundle) falls back to `name` on PATH; a bare name is looked up on PATH. When nothing is
 *  found the configured value is returned unchanged, so the failure names what was configured. */
export function resolveCommand(configured: string | undefined, name: string, path: string | undefined): string {
  if (configured && isAbsolute(configured)) return executable(configured) ? configured : which(name, path) ?? configured;
  return which(configured || name, path) ?? (configured || name);
}
