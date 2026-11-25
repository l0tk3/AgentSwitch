/** The default work folder (docs/control-v0.md §2): a visible folder the user picks on the Mac (default
 *  `~/AgentSwitch`), kept in `workdir.json`. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export const WORKDIR_FILE = "workdir.json";

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
