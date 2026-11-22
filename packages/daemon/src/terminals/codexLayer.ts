/** A layer of AgentSwitch's own in Codex's configuration (2026-11-22): `$CODEX_HOME/agentswitch.config.toml`, read
 *  only by a Codex started with `--profile agentswitch` — the terminals here; the user's own `codex` never sees it.
 *
 *  Why a file at all, when a terminal's `browser` server is given with `-c` flags (launch.ts `codexBrowserArgs`): Codex
 *  names a thread from its first message in a hidden thread (tui/src/app/thread_title.rs, since 0.169), started with
 *  every MCP server switched off — `mcp_servers = { <name> = { enabled = false }, … }` as one override. That override
 *  replaces the whole `mcp_servers` table of the session's flags, so a server defined by flags alone is left as
 *  `{ enabled = false }`, with no command: "invalid transport in `mcp_servers.browser`", the hidden thread does not
 *  start, and the session is never named (every Codex session started here, seen in Codex's own log). A server that is
 *  also defined in a file keeps its command there. The file says only that much — the bridge with no session, which
 *  serves nothing; what a terminal's own bridge is still comes from its flags, which stand above the file. */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CODEX_LAYER = "agentswitch";
const MARK = "CONFIG_PROFILE_V2";

/** Codex's flag for the layer, once its file is in `home` as it should be; [] when it could not be written (the
 *  terminal starts as before, unnamed). */
export function codexLayerArgs(home: string, server: string, command: string, script: string, more: readonly { readonly server: string; readonly command: string; readonly script: string }[] = []): string[] {
  const file = join(home, `${CODEX_LAYER}.config.toml`);
  const text = `# AgentSwitch: read only by Codex terminals it starts (--profile ${CODEX_LAYER}). Rewritten when it starts one.\n`
    + [{ server, command, script }, ...more].map((s) => `[mcp_servers.${s.server}]\ncommand = ${JSON.stringify(s.command)}\nargs = [${JSON.stringify(s.script)}]\n`).join("");
  try {
    let now: string | null = null;
    try { now = readFileSync(file, "utf8"); } catch { /* not there yet */ }
    if (now !== text) {
      mkdirSync(home, { recursive: true });
      const part = `${file}.${process.pid}.part`;
      writeFileSync(part, text, { mode: 0o600 });
      renameSync(part, file);
    }
    return ["--profile", CODEX_LAYER];
  } catch { return []; }
}

const asked = new Map<string, boolean>();

/** This Codex takes `--profile <name>` as a file layered on the user's config (0.168 on; before, the flag named a
 *  `[profiles.<name>]` table and an unknown one stopped it). Asked of the program itself, once per program file. */
export function codexTakesLayer(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let key: string;
  try { const st = statSync(binary); key = `${binary}:${st.mtimeMs}:${st.size}`; } catch { return false; }
  const known = asked.get(key);
  if (known !== undefined) return known;
  let takes = false;
  try {
    const out = spawnSync(binary, ["--help"], { env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    takes = out.status === 0 && out.stdout.includes(MARK);
  } catch { /* not asked: as before */ }
  asked.set(key, takes);
  return takes;
}

/** The user's own config selects a `[profiles.<name>]` table (`profile = "…"`): left as it is — how the two kinds of
 *  profile meet was not tried. */
export function codexNamesOwnProfile(home: string): boolean {
  try { return /^\s*profile\s*=/m.test(readFileSync(join(home, "config.toml"), "utf8").split(/^\s*\[/m)[0] ?? ""); } catch { return false; }
}
