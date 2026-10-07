/** Opt-in check of the browser with windows of its own (docs/browser-v0.md §7.2, §7.3 窗口) against a real Camoufox;
 *  not part of `npm test`. Opens real windows on this Mac for about twenty seconds. Everything else lives in a temporary
 *  folder; no model is called.
 *
 *    npx tsx scripts/browser_window_smoke.ts <Camoufox's program>
 *
 *  Checks: a tab's window keeps its own size (nothing is set), a screen that takes the tab gives it its size and the
 *  window has its own back on hand-back; frames come at the window's size; a tab opened in the browser by hand is a
 *  tab of the person's; input in an agent's window that the host did not send makes the person its holder, and the
 *  host's own input does not; a window is brought forward and pictured; the browser restarted comes back with its tabs. */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { camoufoxDriver } from "../src/browser/camoufoxDriver.js";
import { bundledPlaywright } from "../src/browser/engine/loader.js";
import { Forwarder } from "../src/browser/forwarder.js";
import { sharedBrowser } from "../src/browser/setup.js";
import { WINDOW_HOLDER, YOU, type BrowserEvent, type FrameEvent, type TabOwner } from "../src/browser/types.js";
import { defaultProtected } from "../src/executors/protected.js";

const executable = process.argv[2];
if (!executable) { console.error("usage: browser_window_smoke.ts <Camoufox's program>"); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), "agentswitch-browser-window-"));
const home = join(root, "home"), userHome = join(root, "user");
mkdirSync(home, { recursive: true });
mkdirSync(userHome, { recursive: true });
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
async function until<T>(get: () => T | undefined | null | false, what: string, ms = 10_000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) { check(true, what); return v; }
    if (Date.now() > end) { check(false, `${what} (timed out)`); return null; }
    await new Promise((r) => setTimeout(r, 50));
  }
}
const CODEX: TabOwner = { kind: "terminal", id: "t1", label: "codex · smoke" };

const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>${req.url}</title><button id=b style="position:absolute;left:20px;top:20px;width:160px;height:40px" onclick="document.title='clicked'">click</button>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const forwarder = new Forwarder({ ownPorts: () => [] });

async function main(): Promise<void> {
  const proxy = await forwarder.start();
  const api = sharedBrowser({ home, userHome, protected: defaultProtected({ ...process.env, HOME: userHome, AGENTSWITCH_HOME: home }), ownPorts: () => [],
    driver: camoufoxDriver({ executable: executable!, playwright: bundledPlaywright(), headless: false, proxy }) });
  const host = api.host;
  const page = (id: string) => host.page(id)?.playwright?.() as Page;

  const mine = await host.open(YOU, `${base}/mine`);
  await until(() => host.get(mine.id)?.title === "/mine", "a tab opens in a window");
  const inner = async (id: string) => await page(id).evaluate("[innerWidth, innerHeight]") as [number, number];
  const own = await inner(mine.id);
  check(own[0] !== 1280 || own[1] !== 800, `the window keeps its own size, nothing is set (${own.join("×")})`);
  const events: BrowserEvent[] = [];
  const stop = host.subscribe(mine.id, { quality: 60, fps: 10 }, (e) => events.push(e));
  const frame = await until(() => events.find((e): e is FrameEvent => e.type === "frame"), "a frame arrives from the window");
  check(!!frame && frame.viewport.width === own[0] && frame.viewport.height === own[1], `the frame is the window's size (${frame?.viewport.width}×${frame?.viewport.height}, ${frame?.width} pixels wide)`);

  host.take(mine.id, "phone-1");
  await host.setViewport(mine.id, "phone-1", { width: 520, height: 700, scale: 3, mobile: true });
  await until(() => events.some((e) => e.type === "frame" && e.viewport.width === 520 && e.viewport.height === 700), "the screen that holds the tab gives the window its size");
  host.release(mine.id, "phone-1");
  await until(() => [...events].reverse().find((e): e is FrameEvent => e.type === "frame")?.viewport.width === own[0], "the window has its own size back on hand-back");
  const back = await inner(mine.id);
  check(back[0] === own[0] && back[1] === own[1], `exactly (${back.join("×")})`);
  stop();

  // A tab made in the browser by hand: here by asking the browser itself, past the driver.
  await page(mine.id).context().newPage().then((p) => p.goto(`${base}/by-hand`));
  const byHand = await until(() => host.list().find((t) => t.url.endsWith("/by-hand")), "a tab opened in the browser itself becomes a tab");
  check(byHand?.owner.kind === "you", "of the person's");

  const theirs = await host.open(CODEX, `${base}/theirs`);
  await until(() => host.get(theirs.id)?.title === "/theirs", "an agent's tab opens in a window");
  // The host's own input (a screen's): not the person's.
  host.take(theirs.id, "phone-1");
  await host.input(theirs.id, "phone-1", [{ type: "mouse", action: "click", x: 40, y: 40, button: "left", clickCount: 1, modifiers: [] }]);
  await until(() => host.get(theirs.id)?.title === "clicked", "a screen's click reaches the window's page");
  await new Promise((r) => setTimeout(r, 1500));
  check(host.get(theirs.id)?.heldBy === "phone-1", "and is not taken for the person's");
  host.release(theirs.id, "phone-1");
  await new Promise((r) => setTimeout(r, 800));
  check(host.get(theirs.id)?.heldBy === null, "nobody holds the agent's tab");
  // Input the host did not send (a person's hand in the window; here the page's own mouse, past the host).
  await page(theirs.id).mouse.click(300, 300);
  await until(() => host.get(theirs.id)?.heldBy === WINDOW_HOLDER, "input in the agent's window the host did not send makes the person its holder");
  host.release(theirs.id, WINDOW_HOLDER);
  check(host.get(theirs.id)?.heldBy === null, "and they hand it back");

  await host.show(mine.id);
  check(true, "a window is brought forward");
  const picture = await host.picture(mine.id);
  check(picture.length > 1000 && picture[0] === 0xff && picture[1] === 0xd8, `and pictured (a JPEG of ${picture.length} bytes)`);

  await host.restart();
  await until(() => host.list().length === 3 && host.list().every((t) => t.title.startsWith("/") || t.title === "clicked"), "the browser restarted comes back with its three tabs", 30_000);
  check(host.list().filter((t) => t.owner.kind === "terminal").length === 1, "the agent's tab still the agent's");

  await host.shutdown();
  await api.stop();
}

main().catch((err) => { failures.push(String(err)); console.error(err); }).finally(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
  process.exit(failures.length ? 1 : 0);
});
