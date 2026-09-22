/** Where a task may run (design-v0 B.2 rule 4, the deny half): an existing absolute directory that is not the
 *  filesystem root, the home directory itself, or one of the places holding credentials or the daemon's own state. */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export type CwdRules = { readonly home: string; readonly denied: readonly string[] };

const DENIED_UNDER_HOME = [".ssh", ".claude", ".codex", ".agentswitch", ".secret-gate", "Library", ".gnupg", ".aws", ".config"] as const;

export function defaultCwdRules(env: NodeJS.ProcessEnv = process.env, daemonHome?: string): CwdRules {
  const home = env.HOME ?? "/";
  const denied = [...DENIED_UNDER_HOME.map((d) => resolve(home, d)), ...(daemonHome ? [resolve(daemonHome)] : []), ...(env.SECRET_GATE_HOME ? [resolve(env.SECRET_GATE_HOME)] : [])];
  return { home, denied };
}

/** null when the directory is acceptable, else the reason. */
export function checkCwd(cwd: string, rules: CwdRules): string | null {
  if (!isAbsolute(cwd)) return "cwd must be an absolute path";
  const p = resolve(cwd);
  if (p === "/" || p === resolve(rules.home)) return `cwd ${p} is too broad; pick a project directory`;
  const hit = rules.denied.find((d) => p === d || p.startsWith(d + sep));
  if (hit) return `cwd ${p} is under ${hit}, which holds credentials or the daemon's own state`;
  if (!existsSync(p) || !statSync(p).isDirectory()) return `cwd ${p} is not an existing directory`;
  return null;
}
