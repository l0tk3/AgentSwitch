/** Opt-in check, against a real Camoufox, that a click on a page still lands while screens watch it (docs/browser-v0.md
 *  §8; src/browser/camoufoxPictures.ts). A page that keeps moving is looked at as often as the watcher asks, and each
 *  look is a screenshot the page itself draws. And that the agent's own click is not taken for a person stepping into
 *  the window (host.ts `AGENT_INPUT_MS`): the tab would then be held and the agent's next call would wait. Not part of `npm test`; a temporary folder; no model.
 *
 *    PROBE_FPS=30 npx tsx scripts/browser_click_probe.ts <Camoufox's program> [window|headless]
 *
 *  `window` (the default) opens a real window on this Mac for some twenty seconds. Each line is how long a click took,
 *  or that it did not land in 15 s; the exit code is the number that did not. */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { camoufoxDriver } from "../src/browser/camoufoxDriver.js";
import type { BrowserDriver } from "../src/browser/driver.js";
import { bundledPlaywright } from "../src/browser/engine/loader.js";
import { Forwarder } from "../src/browser/forwarder.js";
import { sharedBrowser, type SharedBrowser } from "../src/browser/setup.js";
import { type BrowserEvent, type TabOwner } from "../src/browser/types.js";
import { defaultProtected } from "../src/core/protected.js";

const executable = process.argv[2];
const mode = process.argv[3] ?? "window";
if (!executable) { console.error("usage: browser_click_probe.ts <Camoufox's program> [window|headless]"); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), "agentswitch-browser-click-"));
const home = join(root, "home"), userHome = join(root, "user");
mkdirSync(home, { recursive: true });
mkdirSync(userHome, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let missed = 0;

// A page that never stands still (a bar that slides, as a spinner or a carousel does) with a button that counts.
const html = `<!doctype html><title>probe</title><style>html,body{margin:0;font:16px system-ui}
#bar{position:fixed;top:0;left:0;width:120px;height:8px;background:#f06;animation:slide 1s linear infinite}
@keyframes slide{from{transform:translateX(0)}to{transform:translateX(100vw)}}
button{margin:120px;padding:16px 28px;font-size:18px}</style>
<div id=bar></div><button id=b onclick="this.dataset.n=(+this.dataset.n||0)+1;this.textContent='clicked '+this.dataset.n">Verify</button>`;
const server = createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function main(): Promise<void> {
  const forwarder = new Forwarder({ ownPorts: () => [] });
  let api: SharedBrowser | null = null;
  const driver: BrowserDriver = {
    async launch(launch) {
      const proxy = await forwarder.start();
      let config: Record<string, unknown> = {};
      try { config = api!.identity.launchConfig() as Record<string, unknown>; } catch { /* no identity yet */ }
      return camoufoxDriver({ executable: executable!, playwright: bundledPlaywright(), headless: mode !== "window", proxy, config }).launch(launch);
    },
  };
  api = sharedBrowser({ home, userHome, protected: defaultProtected({ ...process.env, HOME: userHome, AGENTSWITCH_HOME: home }), ownPorts: () => [], driver });
  const host = api.host;
  const AGENT: TabOwner = { kind: "terminal", id: "t1", label: "codex · probe" };
  const tab = await host.open(AGENT, `${base}/`);
  const page = host.page(tab.id)?.playwright?.() as Page;
  await sleep(2000);
  const click = async (label: string): Promise<void> => {
    const began = Date.now();
    try {
      // As the agent bridge brackets a call (agents.ts): the input the page sees is the agent's own.
      await host.agentActing(AGENT);
      await page.locator("#b").click({ timeout: 15_000 });
      host.agentDone(AGENT);
      const took = Date.now() - began;
      // The page's count of input is read twice a second: by then the call is over. Nobody stepped in.
      await sleep(1200);
      const held = host.get(tab.id)?.heldBy ?? null;
      if (held) { missed += 1; host.release(tab.id, held); }
      console.log(`  ${label}: landed in ${took} ms; ${held ? `THE TAB WAS THEN HELD BY ${held} (the agent's next call would wait)` : "nobody holds the tab"}`);
    } catch (err) {
      missed += 1;
      console.log(`  ${label}: DID NOT LAND in ${Date.now() - began} ms — ${(err as Error).message.split("\n")[0]}`);
    }
  };
  console.log("== nobody watching");
  await click("click");
  for (const fps of (process.env.PROBE_FPS ?? "15,30").split(",").map(Number)) {
    const events: BrowserEvent[] = [];
    const stop = host.subscribe(tab.id, { quality: 70, fps, scale: 2, maxWidth: 3456, maxHeight: 2234 }, (e) => events.push(e));
    await sleep(1500);
    const before = events.filter((e) => e.type === "frame").length, began = Date.now();
    console.log(`== a screen watching, asking ${fps} a second`);
    for (let i = 1; i <= 3; i++) await click(`click ${i}`);
    console.log(`  ${events.filter((e) => e.type === "frame").length - before} frames in ${((Date.now() - began) / 1000).toFixed(1)} s meanwhile`);
    stop();
    await sleep(500);
  }
  console.log(`the button says: ${await page.locator("#b").textContent()}`);
  await host.shutdown();
  await api.stop();
  await forwarder.stop().catch(() => undefined);
}

main().catch((err) => { missed += 1; console.error(err); }).finally(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
  console.log(missed ? `\n${missed} did not land` : "\nall landed");
  process.exit(missed);
});
