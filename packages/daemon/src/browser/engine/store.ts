/** The browser engine on disk (docs/browser-v0.md §7.3 引擎目录): Camoufox and, when one newer than the bundled copy was
 *  installed, playwright-core. One copy of each, ever:
 *
 *    <root>/camoufox/current/      the app itself and `installed.json`
 *    <root>/playwright/current/    `node_modules/playwright-core` and `installed.json` (absent: the bundled one is used)
 *    <root>/incoming-<part>-<id>/  an update under way: its archive and the copy being unpacked
 *
 *  Nothing else stays: an archive goes with its `incoming` folder, the copy replaced is deleted as the new one takes its
 *  place, and what an interrupted update left is cleared when the service starts (`sweep`). */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export type EnginePart = "camoufox" | "playwright";
export const ENGINE_PARTS: readonly EnginePart[] = ["camoufox", "playwright"];

/** What a copy says of itself (`installed.json`). `digest`: of the archive it came from, as published. */
export type Installed = { readonly version: string; readonly digest: string; readonly bytes: number; readonly installedAt: number };

const CURRENT = "current";
const NOTE = "installed.json";
const INCOMING = "incoming-";
const RM = { recursive: true, force: true } as const;

export class EngineStore {
  constructor(readonly root: string) {}

  /** Where the copy in use is (whether or not there is one). */
  dir(part: EnginePart): string {
    return join(this.root, part, CURRENT);
  }

  installed(part: EnginePart): Installed | null {
    try {
      const note = JSON.parse(readFileSync(join(this.dir(part), NOTE), "utf8")) as Partial<Installed>;
      if (typeof note.version !== "string" || !note.version) return null;
      return { version: note.version, digest: String(note.digest ?? ""), bytes: Number(note.bytes ?? 0), installedAt: Number(note.installedAt ?? 0) };
    } catch {
      return null;
    }
  }

  /** A new, empty folder for an update of `part`. */
  incoming(part: EnginePart): string {
    const dir = join(this.root, `${INCOMING}${part}-${randomBytes(4).toString("hex")}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** `from` (an unpacked copy) becomes the copy in use, and the one it replaces is deleted: one copy on disk after. The
   *  old copy is put back if the new one cannot take its place. */
  switchTo(part: EnginePart, from: string, note: Installed): void {
    const home = join(this.root, part);
    const current = this.dir(part);
    const aside = join(home, `previous-${randomBytes(4).toString("hex")}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(from, NOTE), JSON.stringify(note));
    const had = existsSync(current);
    if (had) renameSync(current, aside);
    try {
      renameSync(from, current);
    } catch (err) {
      if (had) renameSync(aside, current);
      throw err;
    }
    if (had) rmSync(aside, RM);
  }

  remove(part: EnginePart): void {
    rmSync(join(this.root, part), RM);
  }

  /** Clears what is not a copy in use: updates that never finished, a copy moved aside, stray files. Answers what went. */
  sweep(): string[] {
    const removed: string[] = [];
    const drop = (path: string) => { rmSync(path, RM); removed.push(path); };
    for (const name of list(this.root)) {
      if (!(ENGINE_PARTS as readonly string[]).includes(name)) { drop(join(this.root, name)); continue; }
      for (const inner of list(join(this.root, name))) if (inner !== CURRENT) drop(join(this.root, name, inner));
    }
    return removed;
  }
}

function list(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
