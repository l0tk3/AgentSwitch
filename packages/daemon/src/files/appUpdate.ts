/** Swapping in a new AgentSwitch.app (assistant-v0 §5). A build is staged next to the running bundle
 *  (`<dir>/next/AgentSwitch.app`, where `APP_OUT=build/next/AgentSwitch.app scripts/build-app.sh` puts it), the user
 *  confirms on the Mac or the phone, and the Mac app swaps it in and keeps it only if its daemon answers; otherwise the
 *  previous bundle comes back. The daemon only reads what is staged, records the phone's confirmation and reads the
 *  outcome: it runs inside the bundle and never touches the bundles itself. */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Written by the daemon when the phone confirms; the Mac app polls for it, installs, and removes it. */
export const UPDATE_REQUEST_FILE = "update-request.json";
/** Written by the Mac app's install helper once the new bundle answered, or after it put the old one back. */
export const UPDATE_RESULT_FILE = "update-result.json";
const ANNOUNCED_SUFFIX = ".announced";
const STAGED = ["next", "AgentSwitch.app"] as const;
const VERSIONS = ["Contents", "Resources", "runtime", "VERSIONS"] as const;

export type Bundle = { readonly path: string; readonly built: string | null };
export type UpdateState = { readonly running: Bundle; readonly staged: Bundle | null };

/** `built=` of a bundle's runtime/VERSIONS (an ISO time from scripts/build-app.sh), or null. */
export function builtAt(app: string): string | null {
  try {
    const line = readFileSync(join(app, ...VERSIONS), "utf8").split("\n").find((l) => l.startsWith("built="));
    return line ? line.slice("built=".length).trim() || null : null;
  } catch {
    return null;
  }
}

/** The running bundle and a staged one built after it, if any. Null when the daemon does not run from a bundle. */
export function updateState(runningApp: string | undefined): UpdateState | null {
  if (!runningApp) return null;
  const running: Bundle = { path: runningApp, built: builtAt(runningApp) };
  const path = join(dirname(runningApp), ...STAGED);
  const built = existsSync(path) ? builtAt(path) : null;
  const newer = built !== null && (running.built === null || built > running.built);
  return { running, staged: newer ? { path, built } : null };
}

export function requestInstall(home: string, by: string, now: number): void {
  const path = join(home, UPDATE_REQUEST_FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ at: now, by })}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export const UpdateResult = z.object({
  ok: z.boolean(),
  reverted: z.boolean().default(false),
  from: z.string().default(""),
  to: z.string().default(""),
  at: z.number().default(0),
  reason: z.string().default(""),
});
export type UpdateResult = z.infer<typeof UpdateResult>;

/** The last install's outcome, announced or not. */
export function lastResult(home: string): UpdateResult | null {
  for (const name of [UPDATE_RESULT_FILE, UPDATE_RESULT_FILE + ANNOUNCED_SUFFIX]) {
    try {
      const parsed = UpdateResult.safeParse(JSON.parse(readFileSync(join(home, name), "utf8")));
      if (parsed.success) return parsed.data;
    } catch { /* next */ }
  }
  return null;
}

/** An outcome not told yet, which is marked told: each install is announced once, whichever daemon starts after it. */
export function takeUnannounced(home: string): UpdateResult | null {
  const path = join(home, UPDATE_RESULT_FILE);
  if (!existsSync(path)) return null;
  const result = lastResult(home);
  renameSync(path, path + ANNOUNCED_SUFFIX);
  return result;
}
