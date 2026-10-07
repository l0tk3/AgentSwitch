/** Where Playwright comes from (docs/browser-v0.md §7.3): the copy bundled with the service, or one installed beside it
 *  by an engine update (`<engine>/playwright/current/node_modules/playwright-core`) — the app bundle is signed and cannot
 *  be changed while it runs. Every user of Playwright in the service asks here. */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { EngineStore } from "./store.js";

export type PlaywrightCopy = {
  readonly from: "bundled" | "installed";
  readonly version: string;
  /** The package's folder. */
  readonly dir: string;
  /** `require` as seen from that copy: `require("playwright-core")`, `require("playwright-core/lib/coreBundle")`. */
  readonly require: NodeJS.Require;
};

const bundledRequire = createRequire(import.meta.url);

function copyAt(require: NodeJS.Require, from: PlaywrightCopy["from"]): PlaywrightCopy {
  const manifest = require.resolve("playwright-core/package.json");
  const version = String((JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version ?? "");
  return { from, version, dir: dirname(manifest), require };
}

export function bundledPlaywright(): PlaywrightCopy {
  return copyAt(bundledRequire, "bundled");
}

/** The copy an unpacked folder holds (an update's, or the one in use), or null when there is none that loads. */
export function playwrightIn(dir: string): PlaywrightCopy | null {
  const anchor = join(dir, "node_modules", "playwright-core", "package.json");
  if (!existsSync(anchor)) return null;
  try { return copyAt(createRequire(join(dir, "anchor.js")), "installed"); } catch { return null; }
}

/** The copy to use now: the installed one when there is one, else the bundled one. */
export function activePlaywright(store: EngineStore | null): PlaywrightCopy {
  const installed = store?.installed("playwright") ? playwrightIn(store.dir("playwright")) : null;
  return installed ?? bundledPlaywright();
}

let inUse: PlaywrightCopy | null = null;

/** The copy the browser now running was started with. Whatever handles its pages comes from the same copy (the agents'
 *  tools are Playwright's own and know only their own copy's pages); the bundled copy while no browser was started. */
export function playwrightInUse(): PlaywrightCopy {
  return inUse ?? bundledPlaywright();
}

/** Said by whoever starts the browser, as it starts it. */
export function notePlaywrightInUse(copy: PlaywrightCopy): void {
  inUse = copy;
}

/** Which Firefox a copy drives (`156.0`), from its own list of browsers. */
export function firefoxVersion(copy: PlaywrightCopy): string | null {
  try {
    const list = JSON.parse(readFileSync(join(copy.dir, "browsers.json"), "utf8")) as { browsers?: { name?: string; browserVersion?: string }[] };
    return list.browsers?.find((b) => b.name === "firefox")?.browserVersion ?? null;
  } catch {
    return null;
  }
}
