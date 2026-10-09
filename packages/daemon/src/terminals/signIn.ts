/** Whether an agent is signed in, in the folder it would be started with (docs/profiles-v0.md §3.1): a profile that
 *  is not is started at its sign-in, not at an empty prompt that says `API Usage Billing` and answers nothing.
 *  Claude Code is asked itself (`claude auth status`); it knows where it keeps a sign-in (the keychain, by folder). */

import { execFile } from "node:child_process";

export type SignInCheck = (binary: string, configHome: string) => Promise<boolean | null>;

const TIMEOUT_MS = 6_000;

/** True or false as Claude Code says; null when it does not say (an older one, it took too long): nothing is assumed. */
export const claudeSignedIn: SignInCheck = (binary, configHome) => new Promise((resolve) => {
  // Asked as the terminal's agent will be started: its own folder, and no session of another Claude Code around it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_?CODE|^CLAUDECODE$|^CLAUDE_CONFIG_DIR$/.test(k)));
  execFile(binary, ["auth", "status"], { env: { ...env, CLAUDE_CONFIG_DIR: configHome }, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 }, (_err, stdout) => {
    // It answers in JSON, and exits 1 when nobody is signed in: what it printed is the answer either way.
    try {
      const said = (JSON.parse(String(stdout)) as { loggedIn?: unknown }).loggedIn;
      resolve(typeof said === "boolean" ? said : null);
    } catch { resolve(null); }
  });
});
