/** The profile folders of the browsers the daemon holds (browser/setup.ts): Chromium's password manager and autofill
 *  are switched off in each, so a value filled in is never saved and shown again; and the browser processes still on a
 *  profile are stopped before it is used again. (The old Dispatch's session slots, kept here until 2026-11-25, are
 *  gone with it.) */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Chromium reads these from the profile at start: no password saving or offering, no address or card autofill. */
export function disablePasswordManager(profileDir: string): void {
  const path = join(profileDir, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { prefs = {}; }
  const section = (key: string) => (typeof prefs[key] === "object" && prefs[key] !== null ? prefs[key] as Record<string, unknown> : {});
  const next = {
    ...prefs,
    credentials_enable_service: false,
    profile: { ...section("profile"), password_manager_enabled: false },
    autofill: { ...section("autofill"), profile_enabled: false, credit_card_enabled: false },
  };
  mkdirSync(join(profileDir, "Default"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
}

/** How the processes of a profile are found, signalled and waited for (a fake in the tests). */
export type ProfileProcesses = {
  /** Sends `signal` to every process whose command line matches `pattern`; true when one matched. */
  signal(pattern: string, signal: "TERM" | "KILL"): boolean;
  /** True while a process whose command line matches `pattern` runs. */
  running(pattern: string): boolean;
  sleep(ms: number): void;
};

/** Chrome is given this long to quit after SIGTERM, then this long after SIGKILL. */
const QUIT_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;
const QUIT_POLL_MS = 100;

const SYSTEM_PROCESSES: ProfileProcesses = {
  signal: (pattern, signal) => spawnSync("pkill", [`-${signal}`, "-f", pattern], { timeout: 2000, stdio: "ignore" }).status === 0,
  running: (pattern) => spawnSync("pgrep", ["-f", pattern], { timeout: 2000, stdio: "ignore" }).status === 0,
  sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
};

/** Waits (polling) until no process matches `pattern`, at most `ms`; true when none is left. */
function gone(ops: ProfileProcesses, pattern: string, ms: number): boolean {
  for (let waited = 0; ; waited += QUIT_POLL_MS) {
    if (!ops.running(pattern)) return true;
    if (waited >= ms) return false;
    ops.sleep(QUIT_POLL_MS);
  }
}

/** Browser processes started with this profile (their command line names it), stopped, and its `Singleton*` locks
 *  removed once they are gone (a lock removed under a Chrome still writing the profile lets a second Chrome in). Only
 *  this slot's own path is matched, so nothing else the user runs is touched. SIGTERM first, SIGKILL after a while;
 *  when a process still does not go, the locks stay and the next launch reports the profile as in use. True when the
 *  profile is free. */
export function closeBrowsersOf(dir: string, ops: ProfileProcesses = SYSTEM_PROCESSES): boolean {
  const pattern = `--user-data-dir=${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`;
  if (ops.signal(pattern, "TERM") && !gone(ops, pattern, QUIT_WAIT_MS)) {
    ops.signal(pattern, "KILL");
    if (!gone(ops, pattern, KILL_WAIT_MS)) {
      console.error(`browser: a Chrome on ${dir} did not quit; its profile stays locked`);
      return false;
    }
  }
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(join(dir, lock), { force: true });
  return true;
}

// File names models mention all the time; as a "top-level domain" they are never a site.
