/** Where a task with no folder of its own works (docs/control-v0.md §2): a dated subfolder of a visible folder the user
 *  picks on the Mac (default `~/AgentSwitch`), kept after the task, instead of a hidden throw-away one in the data
 *  directory. A subfolder still empty when its task ends is removed, so a quick question leaves nothing behind. */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export const WORKDIR_FILE = "workdir.json";
const FOLDER_NAME = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;

const Saved = z.object({ path: z.string().min(1).max(1024) });

export function defaultWorkdir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? ".", "AgentSwitch");
}

/** The folder in force: the saved one, else the default. A broken file falls back to the default. */
export function loadWorkdir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = join(home, WORKDIR_FILE);
  if (!existsSync(file)) return defaultWorkdir(env);
  try { return Saved.parse(JSON.parse(readFileSync(file, "utf8"))).path; }
  catch { return defaultWorkdir(env); }
}

export function saveWorkdir(home: string, path: string): void {
  writeFileSync(join(home, WORKDIR_FILE), JSON.stringify({ path }, null, 2), { mode: 0o600 });
}

/** `~/x` → `$HOME/x`; relative paths are refused (null). */
export function expandWorkdir(path: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME ?? "";
  const full = path === "~" ? home : path.startsWith("~/") ? home + path.slice(1) : path;
  return isAbsolute(full) ? resolve(full) : null;
}

/** A new `<yyyy-MM-dd>-<8 hex>` folder under `root` (created with its parents). */
export function newTaskFolder(root: string, now: Date = new Date()): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dir = join(root, `${day}-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Puts back one of our task folders under `root` that was removed for being empty, before a follow-up or handoff
 *  runs in it; any other missing folder is left for the task to report. */
export function restoreTaskFolder(cwd: string, root: string): boolean {
  if (existsSync(cwd) || !isTaskFolder(cwd, root)) return false;
  mkdirSync(cwd, { recursive: true });
  return true;
}

/** Removes `cwd` when it is one of our task folders directly under `root` and nothing was put in it. */
export function removeIfEmptyTaskFolder(cwd: string, root: string): boolean {
  if (!isTaskFolder(cwd, root)) return false;
  try {
    if (readdirSync(cwd).length) return false;
    rmdirSync(cwd);
    return true;
  } catch {
    return false;
  }
}

function isTaskFolder(cwd: string, root: string): boolean {
  return resolve(dirname(cwd)) === resolve(root) && FOLDER_NAME.test(basename(cwd));
}
