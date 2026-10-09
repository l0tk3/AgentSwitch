/** The sign-in of a profile, the whole way, for real (docs/profiles-v0.md §3.1, §5.5) — everything but the Mac's app:
 *
 *  - a profile without a proxy, made in a scratch place from a stand-in for the user's folder;
 *  - the service's own start route, behind the local listener as the service has it (its guard, its token), started
 *    under that profile: the real Claude Code, at its sign-in;
 *  - once the choice of sign-in methods is on its screen, Return (the first one, an account);
 *  - Claude Code asks the system to open its sign-in page: the terminal's opener asks the service, the service opens
 *    it in the profile's own browser — the Camoufox the service itself would use, WITH A WINDOW (it shows for some
 *    seconds on this Mac's screen) — and what the page turns out to be is read.
 *
 *  Nobody is signed in; nothing of the user's is changed (only the engine's program is read from AgentSwitch's folder).
 *
 *    npx tsx scripts/profile_login_flow_probe.ts */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { LocalAuth } from "../src/api/localAuth.js";
import { exitKey, profileOfKey } from "../src/api/profiles.js";
import type { ApiDeps } from "../src/api/shared.js";
import { mountTerminals } from "../src/api/terminals.js";
import { EngineKit, engineRoot } from "../src/browser/engine/kit.js";
import { ExitPool } from "../src/browser/exits.js";
import { ProfileBrowsers } from "../src/browser/fleet.js";
import { sharedBrowser } from "../src/browser/setup.js";
import { listenLocal } from "../src/daemon.js";
import { ProfileStore } from "../src/profiles/store.js";
import { TerminalHost } from "../src/terminals/host.js";
import { agentLauncher } from "../src/terminals/launch.js";
import { claudeSignedIn } from "../src/terminals/signIn.js";

const say = (line: string) => console.log(line);
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const TOKEN = "probe-local-token-0123456789abcdefghijklmnopqrstuv";

async function main(): Promise<void> {
  const binary = process.env.CLAUDE_BIN_FOR_PROBE ?? execFileSync("/bin/sh", ["-lc", "command -v claude"], { encoding: "utf8" }).trim();
  const root = mkdtempSync(join(process.env.PROBE_TMP ?? tmpdir(), "as-login-"));
  const userHome = join(root, "user"), home = join(root, "as"), work = join(root, "work");
  mkdirSync(join(userHome, ".claude"), { recursive: true });
  mkdirSync(work);
  writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", projects: { [work]: { hasTrustDialogAccepted: true } } }));
  // As on a Mac where Claude Code's own warning about skipping permissions was answered once (a terminal is started
  // with the way to that mode left open): without it a new profile stops at that warning before anything else.
  writeFileSync(join(userHome, ".claude", "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  const kit = new EngineKit({ root: engineRoot(process.env.AGENTSWITCH_HOME ?? join(homedir(), "Library", "Application Support", "AgentSwitch")) });
  if (!kit.executable()) { say("no Camoufox installed in AgentSwitch's folder: nothing to try with"); rmSync(root, { recursive: true, force: true }); return; }

  const store = new ProfileStore({ home, userHome });
  const profile = store.create("claude-code", "Probe", "subscription");
  const key = exitKey("claude-code", profile.id);
  let port = 0;
  const exits = new ExitPool({ ownPorts: () => [port], lookup: "http://unused.test/" });
  const fleet = new ProfileBrowsers((k, forwarder) => sharedBrowser({ home, userHome, protected: { roots: [], exempt: [] }, ownPorts: () => [port], headless: false, kit, own: { name: k, forwarder } }),
    exits, (k) => { const p = profileOfKey(k); return p && store.homeOf(p.agent, p.id) ? { proxy: store.proxyOf(p.agent, p.id) } : null; });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^(https?|all|no)_proxy$/i.test(k))) as Record<string, string>;
  const host = new TerminalHost({ launcher: agentLauncher({ binaries: { "claude-code": binary }, hookUrl: () => `http://127.0.0.1:${port}`, stateDir: join(home, "terminals"), env }) });
  const app = new Hono();
  mountTerminals(app, { profiles: store, exits, profileBrowsers: fleet, terminals: { host, audit: { record() { /* not kept */ } }, agents: ["claude-code"], style: () => ({}), elsewhere: async () => null,
    signedIn: (_h: string, folder: string) => claudeSignedIn(binary, folder) } } as unknown as ApiDeps);
  const server = await new Promise<ReturnType<typeof listenLocal>>((ok) => { const s = listenLocal({ app }, 0, (info: AddressInfo) => { port = info.port; ok(s); }, new LocalAuth(TOKEN)); });
  try {
    const started = await fetch(`http://127.0.0.1:${port}/terminals`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ harness: "claude-code", cwd: work, profile: profile.id, mode: "manual", cols: 100, rows: 30 }) });
    const info = ((await started.json()) as { terminal?: { id: string; profile: unknown }; error?: string });
    if (!info.terminal) { say(`the start route said ${started.status}: ${info.error}`); return; }
    const id = info.terminal.id;
    say(`1) started under the profile by the service's own route (${started.status}) · profile on it: ${JSON.stringify(info.terminal.profile)}`);
    let screen = "";
    for (let i = 0; i < 30 && !/Select login method/.test(screen); i += 1) { await wait(500); screen = host.screenTail(id, 30).join("\n"); }
    if (!/Select login method/.test(screen) || !/❯\s*1\. Claude account/.test(screen)) { say("2) the choice of sign-in methods is not on its screen: nothing pressed"); for (const l of host.screenTail(id, 12)) if (l.trim()) say(`   ${l.trim().slice(0, 100)}`); return; }
    say("2) its screen shows the choice of sign-in methods, the first under the pointer: Return");
    host.write(id, "\r");
    let tab: { id: string; url: string; title: string } | undefined;
    const from = Date.now();
    for (let i = 0; i < 80 && !tab; i += 1) { await wait(500); tab = fleet.get(key)?.host.list()[0]; }
    if (!tab) { say(`3) nothing was opened in the profile's browser within ${Math.round((Date.now() - from) / 1000)} s`); for (const l of host.screenTail(id, 12)) if (l.trim()) say(`   ${l.trim().slice(0, 100)}`); return; }
    const browser = fleet.get(key)!;
    say(`3) opened in the profile's own browser after ${((Date.now() - from) / 1000).toFixed(1)} s · engine ${browser.engine()} · ${browser.visible() ? "with a window" : "no window"} · asked to come forward: ${fleet.shown?.browser === key}`);
    const page = browser.host.page(tab.id)?.playwright?.() as { waitForLoadState(s: string, o: { timeout: number }): Promise<void>; title(): Promise<string>; url(): string; innerText(s: string): Promise<string>; screenshot(o: { path: string }): Promise<unknown> } | undefined;
    await page?.waitForLoadState("load", { timeout: 25_000 }).catch(() => undefined);
    // The page draws itself after it has loaded: waited for until it says something (or for `PROBE_PAGE_MS`).
    let words = "";
    const until = Date.now() + Number(process.env.PROBE_PAGE_MS ?? 45_000);
    while (!words && Date.now() < until) { await wait(1_500); words = ((await page?.innerText("body").catch(() => "")) ?? "").replace(/\s+/g, " ").trim(); }
    await wait(1_500);
    const at = page ? new URL(page.url()) : null;
    say(`4) the page ${((Date.now() - from) / 1000).toFixed(0)} s after Return: ${at ? `${at.origin}${at.pathname}` : "?"} · title "${await page?.title().catch(() => "?")}"`);
    say(`   it says: ${words.slice(0, 260) || "(nothing)"}`);
    const shot = join(process.env.PROBE_TMP ?? tmpdir(), "as-login-page.png");
    await page?.screenshot({ path: shot }).catch(() => undefined);
    say(`   its picture: ${shot}`);
    say(`5) folders made for it: ${readdirSync(join(home, "browser-profiles")).join(", ")}`);
    say("   the terminal's screen meanwhile:");
    for (const l of host.screenTail(id, 30)) if (/Login|Browser|Paste|sign|Opening/i.test(l)) say(`     ${l.trim().slice(0, 100)}`);
  } finally {
    host.closeAll();
    await fleet.stop();
    await exits.stop();
    server.close();
    await wait(500);
    rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
