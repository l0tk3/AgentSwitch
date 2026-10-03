/** The shared browser as the daemon builds it (docs/browser-v0.md §2): the `main` profile under
 *  `$AGENTSWITCH_HOME/browser-profiles` (read-denied to the executors, protected.ts), password manager and autofill off
 *  as in the session slots, a Chrome left on the profile by an earlier run stopped before each launch, the audit, the
 *  agents' sessions and Playwright MCP's files under `$AGENTSWITCH_HOME/browser` (read-denied to the executors too), the
 *  gate's fill for people, and the local servers without AgentSwitch's own. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { closeBrowsersOf, disablePasswordManager } from "../executors/browserSlots.js";
import { BROWSER_PROFILES_DIR, BROWSER_STATE_DIR, canonicalPath, type ProtectedPaths } from "../executors/protected.js";
import { playwrightEngine } from "./agentMcp.js";
import { BrowserAgents, type AgentEngine } from "./agents.js";
import { BrowserAudit } from "./audit.js";
import type { BrowserDriver } from "./driver.js";
import type { FillResolver } from "./fill.js";
import { BrowserHost } from "./host.js";
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
  const host = new BrowserHost({
    driver: opts.driver ?? playwrightDriver(),
    profileDir: join(opts.home, BROWSER_PROFILES_DIR, MAIN_PROFILE),
    files: { protected: opts.protected, home: userHome, ownFolders: [opts.home, ...(opts.gateHome ? [opts.gateHome] : [])] },
    ownPorts: opts.ownPorts,
    prepareProfile: (dir) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (real) closeBrowsersOf(dir);
      disablePasswordManager(dir);
    },
    onIdleRelease: (tab, holder) => audit.record({ tab, action: "release", via: "daemon", detail: { screen: holder, reason: "idle" } }),
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
    servers: () => listLocalServers({ ports: opts.ownPorts(), pid: process.pid, home: userHome }, ...(opts.exec ? [opts.exec] : [])),
  };
}
