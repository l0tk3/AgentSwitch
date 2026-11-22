/** A terminal's own folder (`$AGENTSWITCH_HOME/terminals/<id>`: the settings, mcp.json, `open` shim and sockets the
 *  launcher and the holder make for it) is of use only while its program runs. It is removed when the program has
 *  ended, and what earlier daemons left (terminals that ended with a daemon, or before this was done: 241 folders on
 *  one Mac in five weeks) is swept once at start. A held terminal waiting to be taken up (`meta.json`) is never touched. */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TERMINAL_ID = /^[0-9a-f]{8}$/;

/** The folder of a terminal whose program has ended. */
export function forgetTerminalFiles(dir: string, id: string): void {
  if (!TERMINAL_ID.test(id)) return;
  try { rmSync(join(dir, id), { recursive: true, force: true }); } catch { /* swept at the next start */ }
}

/** Folders of terminals that are neither live here (`live`) nor held for a daemon to take up. Returns how many went. */
export function sweepTerminalFiles(dir: string, live: ReadonlySet<string>): number {
  let names: string[];
  try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && TERMINAL_ID.test(d.name)).map((d) => d.name); } catch { return 0; }
  let removed = 0;
  for (const id of names) {
    if (live.has(id) || existsSync(join(dir, id, "meta.json"))) continue;
    try { rmSync(join(dir, id), { recursive: true, force: true }); removed += 1; } catch { /* left for the next start */ }
  }
  return removed;
}

/** What was sent to terminals that are no more (`$TMPDIR/agentswitch-attach/<id>`: pictures and files of a reply). The
 *  folder goes when its terminal is deleted; one whose terminal ended with a daemon stayed. `keep` is given each
 *  folder first (Codex's record names a picture by its place there: session monitor's `keepPicturesIn`). */
export function sweepAttachments(dir: string, live: ReadonlySet<string>, keep?: (folder: string) => void): number {
  let names: string[];
  try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && TERMINAL_ID.test(d.name)).map((d) => d.name); } catch { return 0; }
  let removed = 0;
  for (const id of names) {
    if (live.has(id)) continue;
    try { keep?.(join(dir, id)); } catch { continue; }
    try { rmSync(join(dir, id), { recursive: true, force: true }); removed += 1; } catch { /* left for the next start */ }
  }
  return removed;
}
