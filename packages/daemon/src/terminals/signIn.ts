/** Whether an agent is signed in, in the folder it would be started with (docs/profiles-v0.md §3.1): a profile that
 *  is not is started at its sign-in, not at an empty prompt that says `API Usage Billing` and answers nothing.
 *  Claude Code is asked itself (`claude auth status`); it knows where it keeps a sign-in (the keychain, by folder).
 *  So is Codex (`codex login status`), told to keep its sign-in in the folder's own file (§6.2). */

import { profileEnvironment } from "./profileEnvironment.js";
import { execFile } from "node:child_process";

export type SignInCheck = (binary: string, configHome: string, isolated?: boolean) => Promise<boolean | null>;

const TIMEOUT_MS = 6_000;

/** True or false as Claude Code says; null when it does not say (an older one, it took too long): nothing is assumed. */
export const claudeSignedIn: SignInCheck = (binary, configHome, isolated) => new Promise((resolve) => {
  // Asked as the terminal's agent will be started: its own folder, and no session of another Claude Code around it.
  const source = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
  const env = profileEnvironment(source, { harness: "claude-code", configHome, ...(isolated ? { isolated: true } : {}) });
  execFile(binary, [...(isolated ? ["--setting-sources", "user"] : []), "auth", "status"], { env: { ...env, CLAUDE_CONFIG_DIR: configHome }, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 }, (_err, stdout) => {
    // It answers in JSON, and exits 1 when nobody is signed in: what it printed is the answer either way.
    try {
      const said = (JSON.parse(String(stdout)) as { loggedIn?: unknown }).loggedIn;
      resolve(typeof said === "boolean" ? said : null);
    } catch { resolve(null); }
  });
});

/** Where a Codex profile keeps its sign-in: `auth.json` in its own folder, never the keychain, where an entry could
 *  be taken for another account's (docs/profiles-v0.md §6.1). Given to every Codex started under such a profile. */
export const CODEX_FILE_STORE = ["-c", 'cli_auth_credentials_store="file"'] as const;

/** True when Codex says it is signed in (it exits 0), false when it says nobody is (`Not logged in`, exit 1); null
 *  when it says neither (an error, an older one, it took too long). */
export const codexSignedIn: SignInCheck = (binary, configHome) => new Promise((resolve) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CODEX_/.test(k)));
  execFile(binary, [...CODEX_FILE_STORE, "login", "status"], { env: { ...env, CODEX_HOME: configHome }, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
    if (!err) return resolve(true);
    resolve(err.code === 1 && /\bNot logged in\b/.test(`${stdout}\n${stderr}`) ? false : null);
  });
});
