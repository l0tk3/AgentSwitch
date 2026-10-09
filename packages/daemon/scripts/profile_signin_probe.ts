/** A profile nobody is signed in to, started for real (docs/profiles-v0.md §3.1), with nothing of the user's touched:
 *
 *  - a profile is made from a stand-in for the user's folder (in a scratch place), as a new one is on this Mac;
 *  - the real Claude Code is asked whether anybody is signed in there (`claude auth status`);
 *  - a terminal is started under it through the real launcher and the real host, with what the start route gives it
 *    (`/login` as its first input when nobody is signed in), and its screen is read after a moment.
 *
 *  Nothing is typed into it and nobody is signed in: the screen is only looked at.
 *
 *    npx tsx scripts/profile_signin_probe.ts */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../src/profiles/store.js";
import { TerminalHost } from "../src/terminals/host.js";
import { agentLauncher } from "../src/terminals/launch.js";
import { claudeSignedIn } from "../src/terminals/signIn.js";

const say = (line: string) => console.log(line);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function main(): Promise<void> {
  const binary = process.env.CLAUDE_BIN_FOR_PROBE ?? execFileSync("/bin/sh", ["-lc", "command -v claude"], { encoding: "utf8" }).trim();
  const root = mkdtempSync(join(process.env.PROBE_TMP ?? tmpdir(), "as-signin-"));
  const userHome = join(root, "user"), home = join(root, "as"), work = join(root, "work");
  mkdirSync(join(userHome, ".claude"), { recursive: true });
  mkdirSync(work);
  // What a new profile carries over from the user's own: that the first-run set-up was done, and the folder's trust.
  writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", projects: { [work]: { hasTrustDialogAccepted: true } } }));
  const store = new ProfileStore({ home, userHome });
  const profile = store.create("claude-code", "Probe", "subscription");
  const folder = store.homeOf("claude-code", profile.id)!;
  say(`profile ${profile.name} · colour ${profile.color} · folder under the scratch place`);

  const started = Date.now();
  const signedIn = await claudeSignedIn(binary, folder);
  say(`claude auth status → signed in: ${signedIn} (${Date.now() - started} ms)`);
  const firstInput = signedIn === false ? "/login" : null;

  // No session of another Claude Code around it, and no proxy of this shell's.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^(https?|all|no)_proxy$/i.test(k))) as Record<string, string>;
  const host = new TerminalHost({ launcher: agentLauncher({ binaries: { "claude-code": binary }, hookUrl: () => "http://127.0.0.1:9", stateDir: join(home, "terminals"), env }) });
  try {
    const info = await host.spawn({ harness: "claude-code", cwd: work, profile: { id: profile.id, name: profile.name, home: folder, ...(profile.color ? { color: profile.color } : {}) },
      ...(firstInput ? { firstInput } : {}), cols: 100, rows: 30 });
    say(`terminal started · profile on it: ${JSON.stringify(info.profile)}`);
    await wait(Number(process.env.PROBE_WAIT_MS ?? 7_000));
    say("--- its screen:");
    for (const line of host.screenTail(info.id, 30)) if (line.trim()) say(`  ${line.replace(/\s+$/, "").slice(0, 110)}`);
  } finally {
    host.closeAll();
    await wait(300);
    rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
