/** Chrome's code-sign clones (2026-09-25). At every launch Google Chrome copies its app bundle to
 *  `<user temp>/../X/com.google.Chrome.code_sign_clone/code_sign_clone.XXXXXX`, so a running Chrome keeps a valid
 *  signature while an update replaces the installed one, and deletes the copy when it quits. The executors' browsers are
 *  stopped rather than quit, so every browser run left a copy behind (35 in five days). APFS shares a copy's data with
 *  the installed Chrome only until Chrome updates; from then on each old copy holds a whole old version.
 *
 *  After a browser run the daemon removes copies that no Chrome process has open and that are old enough that a Chrome
 *  starting right now cannot be halfway through making its own. When the open-file check fails, nothing is removed. */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The Chromium builds whose clones are looked at: what Playwright MCP launches (Chrome, Chrome for Testing, Chromium). */
export const CLONE_PARENTS = ["com.google.Chrome.code_sign_clone", "com.google.chrome.for.testing.code_sign_clone", "org.chromium.Chromium.code_sign_clone"] as const;
const CLONE_NAME = /^code_sign_clone\.[A-Za-z0-9]+$/;
/** A copy younger than this may belong to a Chrome that is still starting (it makes the copy before opening it). */
export const MIN_CLONE_AGE_MS = 5 * 60_000;
/** After a browser run: the stopped browser has time to go away first. */
export const SWEEP_DELAY_MS = 30_000;
/** Process names of Chrome and its helpers ("Google Chrome", "Google Chrome Helper", "Chromium"): lsof `-c` prefixes. */
const CHROME_COMMANDS = ["Google", "Chromium"] as const;
const LSOF_TIMEOUT_MS = 20_000;
const LSOF_MAX_BUFFER = 64 * 1024 * 1024;

/** `…/X` next to the per-user temp dir (`getconf DARWIN_USER_TEMP_DIR` = `…/T/`); null off macOS or when unknown. */
export function cloneRoot(): string | null {
  if (process.platform !== "darwin") return null;
  const r = spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 2000 });
  const temp = r.status === 0 ? r.stdout.trim().replace(/\/+$/, "") : "";
  if (!temp) return null;
  const root = join(dirname(temp), "X");
  try { return realpathSync(root); } catch { return null; }
}

/** Clone directory names that appear in `lsof -Fn` output (lines `n<path>`). */
export function clonesInOutput(lsofOutput: string): Set<string> {
  const names = new Set<string>();
  for (const m of lsofOutput.matchAll(/\/(code_sign_clone\.[A-Za-z0-9]+)(?=\/|$)/gm)) names.add(m[1]!);
  return names;
}

/** Clones a Chrome process has open right now; null when lsof could not tell (then nothing may be removed). */
export async function openClones(): Promise<Set<string> | null> {
  const args = ["-w", "-Fn", ...CHROME_COMMANDS.flatMap((c) => ["-c", c])];
  try {
    const { stdout } = await execFileAsync("lsof", args, { timeout: LSOF_TIMEOUT_MS, maxBuffer: LSOF_MAX_BUFFER });
    return clonesInOutput(stdout);
  } catch (err) {
    // lsof exits 1 when no process matched (no Chrome running): its output is still complete.
    const e = err as { code?: unknown; stdout?: string; killed?: boolean };
    if (e.code === 1 && !e.killed && typeof e.stdout === "string") return clonesInOutput(e.stdout);
    return null;
  }
}

/** Removes the clones under `root` that are not in `open` and older than `minAgeMs`; returns their paths. */
export function sweepClones(root: string, open: ReadonlySet<string>, now: number, minAgeMs = MIN_CLONE_AGE_MS): string[] {
  const removed: string[] = [];
  for (const parent of CLONE_PARENTS) {
    const dir = join(root, parent);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!CLONE_NAME.test(name) || open.has(name)) continue;
      const path = join(dir, name);
      const st = lstatSync(path);
      if (!st.isDirectory() || now - st.mtimeMs < minAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return removed;
}

export type CloneSweeperOptions = {
  readonly root: string;
  readonly open?: () => Promise<ReadonlySet<string> | null>;
  readonly now?: () => number;
  readonly delayMs?: number;
  readonly log?: (line: string) => void;
};

/** One pending sweep at a time, a while after the last browser run asked for it. */
export class CloneSweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: CloneSweeperOptions) {}

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.sweepNow(); }, this.opts.delayMs ?? SWEEP_DELAY_MS);
    this.timer.unref();
  }

  async sweepNow(): Promise<string[]> {
    const log = this.opts.log ?? console.error;
    try {
      const open = await (this.opts.open ?? openClones)();
      if (!open) { log("Chrome code-sign clones: could not tell which are in use (lsof failed); none removed"); return []; }
      const removed = sweepClones(this.opts.root, open, (this.opts.now ?? Date.now)());
      if (removed.length) log(`Chrome code-sign clones: removed ${removed.length} left behind by stopped browsers`);
      return removed;
    } catch (err) {
      log(`Chrome code-sign clones: sweep failed: ${(err as Error).message}`);
      return [];
    }
  }
}
