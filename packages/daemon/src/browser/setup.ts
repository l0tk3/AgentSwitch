/** The shared browser as the daemon builds it (docs/browser-v0.md §2): the `main` profile under
 *  `$AGENTSWITCH_HOME/browser-profiles` (read-denied to the executors, protected.ts), password manager and autofill off
 *  as in the session slots, a Chrome left on the profile by an earlier run stopped before each launch, the audit, the
 *  agents' sessions and Playwright MCP's files under `$AGENTSWITCH_HOME/browser` (read-denied to the executors too), the
 *  gate's fill for people, and the local servers without AgentSwitch's own. */

import { exitLookup, exitProbe } from "./exit.js";
import { BrowserIdentity } from "./identity.js";
import { WINDOW_HOLDER } from "./types.js";
import { camoufoxDriver } from "./camoufoxDriver.js";
import type { EngineKit } from "./engine/kit.js";
import { Forwarder } from "./forwarder.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { closeBrowsersOf, disablePasswordManager } from "../executors/browserSlots.js";
import { BROWSER_PROFILES_DIR, BROWSER_STATE_DIR, canonicalPath, type ProtectedPaths } from "../executors/protected.js";
import { playwrightEngine } from "./agentMcp.js";
import { BrowserAgents, type AgentEngine } from "./agents.js";
import { BrowserAudit } from "./audit.js";
import type { BrowserDriver } from "./driver.js";
import type { FillResolver } from "./fill.js";
import { BrowserHost, LaunchProblem } from "./host.js";
import { playwrightDriver } from "./playwrightDriver.js";
import { listLocalServers, type LocalServer, type Run } from "./servers.js";

/** The persistent profile people and the terminals' agents share (browser-v0 §4.3). */
export const MAIN_PROFILE = "main";

/** What the API serves the browser from (api/browser.ts). */
export type SharedBrowser = {
  readonly host: BrowserHost;
  readonly audit: BrowserAudit;
  /** The agents' sessions and connections (the agent bridge). */
  readonly agents: BrowserAgents;
  /** The gate's answer for a person's Fill Ciphertext; absent without the gate. */
  readonly fill?: FillResolver;
  /** The user's home folder (`~` in paths typed into the address bar). */
  readonly home: string;
  /** The user's local servers now, AgentSwitch's own left out. */
  readonly servers: () => Promise<readonly LocalServer[]>;
  /** Which browser the host starts now (docs/browser-v0.md §7.2 第 2 条): Camoufox once it is installed, else Chrome. */
  readonly engine: () => "camoufox" | "chrome";
  /** Its tabs have windows of their own (Camoufox, not headless). */
  readonly windows: () => boolean;
  /** Stops what the browser was given besides itself (the forwarder). */
  readonly stop: () => Promise<void>;
  /** The fingerprint Camoufox is started with and the proxy its traffic leaves through (§7.2 第 5 条). */
  readonly identity: BrowserIdentity;
};

export type SharedBrowserOptions = {
  /** `$AGENTSWITCH_HOME`. */
  readonly home: string;
  /** The user's home folder (`~`). */
  readonly userHome: string;
  /** What no tab may open: the executors' table (`defaultProtected`). */
  readonly protected: ProtectedPaths;
  /** The gate's home (`SECRET_GATE_HOME`): its name, like AgentSwitch's home's, is refused anywhere (a copy elsewhere). */
  readonly gateHome?: string;
  readonly ownPorts: () => readonly number[];
  /** Tests: a fake browser (no Chrome, no stale-browser sweep). */
  readonly driver?: BrowserDriver;
  /** The engine on disk (§7): with a Camoufox installed the host starts it, through a forwarder of its own; without
   *  one, or without a kit, Chrome as before. */
  readonly kit?: EngineKit;
  /** Camoufox without a window (the default; the service on a Mac with its app asks for windows — §7.2 第 1 条). */
  readonly headless?: boolean;
  /** Tests: the agents' MCP engine (default: Playwright MCP in this process). */
  readonly engine?: AgentEngine;
  /** People's fill through the gate (fill.ts `gateFill`); absent: fill answers that the gate is not there. */
  readonly fill?: FillResolver;
  readonly holdWaitMs?: number;
  /** Tests: how `lsof` and `ps` are run. */
  readonly exec?: Run;
  readonly afterExit?: () => void;
  readonly holdIdleMs?: number;
  readonly idleCloseMs?: number;
};

export function sharedBrowser(opts: SharedBrowserOptions): SharedBrowser {
  const userHome = canonicalPath(opts.userHome);
  const audit = new BrowserAudit(join(opts.home, BROWSER_STATE_DIR, "audit.jsonl"));
  const real = !opts.driver;
  const lookup = real ? exitLookup() : null;
  const identity: BrowserIdentity = new BrowserIdentity({
    file: join(opts.home, BROWSER_STATE_DIR, "identity.json"), ...(opts.fill ? { resolve: opts.fill } : {}),
    ...(lookup ? { probe: () => exitProbe({ forwarder: () => forwarder.start(), url: lookup })() } : {}),
    firefox: () => opts.kit?.store.installed("camoufox")?.version.split(".")[0] ?? opts.kit?.status().playwright.firefox?.split(".")[0] ?? null,
  });
  const forwarder: Forwarder = new Forwarder({ ownPorts: opts.ownPorts, upstream: () => identity.upstream(), log: (line) => console.error(line) });
  void identity.start();
  const chosen = opts.driver ? null : engineDriver({ ...(opts.kit ? { kit: opts.kit } : {}), identity, chrome: playwrightDriver(opts.kit ? { playwright: () => opts.kit!.playwright() } : {}), forwarder, headless: opts.headless ?? true });
  const host = new BrowserHost({
    driver: opts.driver ?? chosen!,
    profileDir: join(opts.home, BROWSER_PROFILES_DIR, MAIN_PROFILE),
    files: { protected: opts.protected, home: userHome, ownFolders: [opts.home, ...(opts.gateHome ? [opts.gateHome] : [])] },
    ownPorts: opts.ownPorts,
    prepareProfile: (dir) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (real) closeBrowsersOf(dir);
      disablePasswordManager(dir);
    },
    onIdleRelease: (tab, holder) => audit.record({ tab, action: "release", via: "daemon", detail: { screen: holder, reason: "idle" } }),
    onWindowTake: (tab) => audit.record({ tab, action: "take", via: "daemon", detail: { screen: WINDOW_HOLDER, reason: "input in its window" } }),
    ...(opts.afterExit ? { afterExit: opts.afterExit } : {}),
    ...(opts.holdIdleMs !== undefined ? { holdIdleMs: opts.holdIdleMs } : {}),
    ...(opts.idleCloseMs !== undefined ? { idleCloseMs: opts.idleCloseMs } : {}),
  });
  const agents = new BrowserAgents({
    host, audit, dir: join(opts.home, BROWSER_STATE_DIR), engine: opts.engine ?? playwrightEngine(host),
    ...(opts.holdWaitMs !== undefined ? { holdWaitMs: opts.holdWaitMs } : {}),
  });
  return {
    host, audit, agents, home: userHome, ...(opts.fill ? { fill: opts.fill } : {}),
    engine: () => chosen?.engine() ?? "chrome",
    windows: () => chosen?.engine() === "camoufox" && opts.headless === false,
    stop: () => forwarder.stop(),
    identity,
    servers: () => listLocalServers({ ports: opts.ownPorts(), pid: process.pid, home: userHome }, ...(opts.exec ? [opts.exec] : [])),
  };
}

/** The driver that starts whichever browser there is to start: Camoufox when the engine has one installed — on a
 *  profile of its own beside Chrome's (the two cannot share one), its traffic through the forwarder — else Chrome.
 *  Asked at every launch, so a Camoufox installed while Chrome runs is used from the next start. */
export function engineDriver(opts: { readonly kit?: EngineKit; readonly chrome: BrowserDriver; readonly forwarder: Forwarder; readonly headless: boolean; readonly identity?: BrowserIdentity }): BrowserDriver & { engine(): "camoufox" | "chrome" } {
  const executable = () => opts.kit?.executable() ?? null;
  return {
    engine: () => executable() ? "camoufox" : "chrome",
    async launch(launch) {
      const program = executable();
      if (!program || !opts.kit) return opts.chrome.launch(launch);
      const proxy = await opts.forwarder.start();
      try { return await camoufoxDriver({ executable: program, playwright: opts.kit.playwright(), headless: opts.headless, proxy, ...(opts.identity ? { config: opts.identity.launchConfig() } : {}) }).launch({ ...launch, profileDir: `${launch.profileDir}${CAMOUFOX_PROFILE_SUFFIX}` }); }
      catch (err) { throw new LaunchProblem(camoufoxLaunchFailure(err)); }
    },
  };
}

/** Why Camoufox did not start, in the user's words: its program is gone, or it would not run (the first line of what
 *  it said — an engine that no longer matches the Playwright in use says so there). Both end where it can be put right. */
export function camoufoxLaunchFailure(err: unknown): string {
  const text = String((err as Error)?.message ?? err);
  const where = "可在 Browser 页状态栏右端的引擎一栏重新下载。";
  if (/executable doesn't exist|ENOENT|EACCES/i.test(text)) return `未找到 Camoufox 的程序。${where}`;
  return `Camoufox 未能启动：${text.split("\n")[0]!.trim()}。${where}`;
}

/** Camoufox's profile beside Chrome's `main`: `main-camoufox`. */
export const CAMOUFOX_PROFILE_SUFFIX = "-camoufox";
