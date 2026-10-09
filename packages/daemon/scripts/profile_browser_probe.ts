/** A profile's own browser tried for real (docs/profiles-v0.md §5.1): the real Google Chrome, on a folder of its own in
 *  a temporary place, started through a forwarder whose proxy is the running Clash's own proxy port. Checks that what
 *  the browser loads leaves through the forwarder — the address a page sees is the proxy's exit — and that a page on
 *  this Mac is still reached. No window is shown unless `PROBE_WINDOW=1`; nothing of the user's is changed.
 *
 *    npx tsx scripts/profile_browser_probe.ts */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { EngineKit, engineRoot } from "../src/browser/engine/kit.js";
import { exitLookup } from "../src/browser/exit.js";
import { ExitPool } from "../src/browser/exits.js";
import { sharedBrowser } from "../src/browser/setup.js";
import { YOU } from "../src/browser/types.js";
import { ClashController } from "../src/clash/controller.js";
import { vergeSocket } from "../src/clash/verge.js";

const say = (line: string) => console.log(line);
const mask = (ip: string) => ip.replace(/\d+\.\d+$/, "x.x");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const socket = vergeSocket();
  const port = socket ? (await new ClashController(socket).status()).proxyPort : null;
  if (!port) { say("no proxy at hand to try with (Clash is not running, or has no proxy port)"); return; }
  const proxy = { server: `http://127.0.0.1:${port}` };
  const exits = new ExitPool({ ownPorts: () => [], lookup: exitLookup() });
  // The proxy at hand is Clash, which sends different names out by different nodes: to compare like with like, the
  // address is asked of the same place the page will ask (a real proxy of one's own has one way out for everything).
  const same = new ExitPool({ ownPorts: () => [], lookup: "https://www.cloudflare.com/cdn-cgi/trace", others: [] });
  const home = mkdtempSync(join(tmpdir(), "as-profile-browser-"));
  const local = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title>on this Mac</title><p>local page</p>"));
  await new Promise<void>((ok) => local.listen(0, "127.0.0.1", ok));
  // The engine the service itself would use: the Camoufox installed in AgentSwitch's own folder, when there is one
  // (only its program is used; nothing in that folder is written, and the browser's own folder is the temporary one).
  // `PROBE_ENGINE=chrome`: Chrome all the same.
  const kit = process.env.PROBE_ENGINE === "chrome" ? null : new EngineKit({ root: engineRoot(process.env.AGENTSWITCH_HOME ?? join(homedir(), "Library", "Application Support", "AgentSwitch")) });
  let zone: string | null = null;
  // `PROBE_WINDOW=1`: with a window, as the service starts a profile's browser on a Mac (it shows for a few seconds).
  const browser = sharedBrowser({ home, userHome: home, protected: { roots: [], exempt: [] }, ownPorts: () => [], headless: process.env.PROBE_WINDOW !== "1", ...(kit?.executable() ? { kit } : {}),
    own: { name: "claude-code.probe00000", forwarder: { start: () => exits.address("probe", proxy) }, zone: () => zone } });
  try {
    const exit = await exits.check("probe", proxy);
    zone = exit.timezone ?? (process.env.PROBE_ZONE || null);
    say(`1) the profile's exit, by the check: ${mask(exit.ip)} · ${exit.place}${zone ? ` · ${zone}` : ""}`);
    const before = exits.requests("probe");
    const tab = await browser.host.open(YOU, "https://www.cloudflare.com/cdn-cgi/trace");
    const page = browser.host.page(tab.id)?.playwright?.() as { innerText(selector: string): Promise<string>; waitForLoadState(state: string, o: { timeout: number }): Promise<void>; evaluate<T>(fn: string): Promise<T> } | undefined;
    await page?.waitForLoadState("load", { timeout: 20_000 }).catch(() => undefined);
    let seen = "";
    for (let i = 0; i < 20 && !seen; i += 1) { seen = /^ip=(\S+)$/m.exec(await page?.innerText("body").catch(() => "") ?? "")?.[1] ?? ""; if (!seen) await sleep(500); }
    const told = await page?.evaluate<{ zone: string; agent: string }>("({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, agent: navigator.userAgent })").catch(() => null);
    say(`   the page is told: time zone ${told?.zone}; browser ${told?.agent.replace(/^.*?(Firefox\/[\d.]+|Chrome\/[\d.]+).*$/, "$1")}`);
    const there = await same.check("probe", proxy).catch(() => null);
    say(`2) the real browser (engine ${browser.engine()}, ${browser.visible() ? "with a window" : "no window"}), through the forwarder: a page sees ${seen ? mask(seen) : "nothing"} — ${seen && seen === there?.ip ? "the same as the forwarder's own way out to that place" : `the forwarder's own way out to that place is ${there ? mask(there.ip) : "not known"}`}; the forwarder was asked ${exits.requests("probe") - before} time(s)`);
    const mid = exits.requests("probe");
    const here = await browser.host.open(YOU, `http://127.0.0.1:${(local.address() as AddressInfo).port}/`);
    await sleep(1500);
    say(`3) a page on this Mac: "${browser.host.get(here.id)?.title}" — asked of the forwarder ${exits.requests("probe") - mid} time(s), which sends what is on this Mac straight`);
    say(`   its folder: ${join("browser-profiles", "claude-code.probe00000")} (the shared browser's is browser-profiles/main)`);
  } finally {
    await browser.agents.shutdown().catch(() => undefined);
    await browser.host.shutdown().catch(() => undefined);
    await exits.stop();
    await same.stop();
    local.close();
    rmSync(home, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
