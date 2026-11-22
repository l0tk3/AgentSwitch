/** Where Claude Code keeps a sign-in, and putting it away (docs/profiles-v0.md, 2026-11-22). On a Mac it is not in the config
 *  folder but in the login keychain, one entry per config folder: `Claude Code-credentials` for the user's own
 *  (`~/.claude`, no folder named), `Claude Code-credentials-<first 8 of sha256(folder)>` for any other (checked against
 *  this Mac's entries, 2026-11-22). Elsewhere it is `.credentials.json` in the folder. Deleting a profile's folder left
 *  its entry behind; so did resetting Default's identity. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

const SECURITY = "/usr/bin/security";

/** The keychain entry's name for a config folder; null: the user's own (`CLAUDE_CONFIG_DIR` unset). */
export function claudeKeychainService(configDir: string | null): string {
  return configDir === null ? "Claude Code-credentials" : `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
}

/** Puts a config folder's sign-in away: its keychain entry on a Mac, its credentials file elsewhere (`fallbackDir`:
 *  the folder itself for the user's own). One that is not there is nothing to do. Only the entry is removed — what is
 *  in it is never read. */
export function forgetClaudeLogin(configDir: string | null, fallbackDir: string, platform: NodeJS.Platform = process.platform,
                                  run: (file: string, args: readonly string[]) => Promise<void> = security): Promise<void> {
  if (platform !== "darwin") {
    rmSync(join(configDir ?? fallbackDir, ".credentials.json"), { force: true });
    return Promise.resolve();
  }
  return run(SECURITY, ["delete-generic-password", "-s", claudeKeychainService(configDir)]).catch(() => undefined);
}

function security(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
  });
}
