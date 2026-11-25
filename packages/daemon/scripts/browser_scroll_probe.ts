/** Opt-in check, against a real Camoufox, that a tab's pictures are of what the page shows — not of the document's top
 *  — and that the frame around what an agent acted on stays on it as the page scrolls (docs/browser-v0.md §8;
 *  src/browser/camoufoxPictures.ts, actionBox.ts). Not part of `npm test`. Everything lives in a temporary folder; no
 *  model is called.
 *
 *    npx tsx scripts/browser_scroll_probe.ts <Camoufox's program> [window|headless]
 *
 *  `window` (the default) opens a real window on this Mac for about half a minute: that is the browser the bug was in
 *  (with windows Camoufox drew its own screencast from the document's top-left corner). The page is ten coloured bands
 *  400 px high, a strip fixed to the window's foot, and a white button at 1700 px: what a picture shows at a point
 *  says which part of the document it is of. Each line ends in ok or WRONG; the exit code is the number of WRONG. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { type BrowserEvent, type FrameEvent, type TabOwner } from "../src/browser/types.js";
import { defaultProtected } from "../src/core/protected.js";

const executable = process.argv[2];
const mode = process.argv[3] ?? "window";
if (!executable) { console.error("usage: browser_scroll_probe.ts <Camoufox's program> [window|headless]"); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), "agentswitch-browser-scroll-"));
const home = join(root, "home"), userHome = join(root, "user");
mkdirSync(home, { recursive: true });
mkdirSync(userHome, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let wrong = 0;
const check = (what: string, ok: boolean, detail = ""): void => { if (!ok) wrong += 1; console.log(`  ${ok ? "ok   " : "WRONG"} ${what}${detail ? ` — ${detail}` : ""}`); };

const BANDS = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#808080", "#ff8000", "#8000ff", "#008080", "#804000"];
const NAMES = ["red", "green", "blue", "yellow", "cyan", "grey", "orange", "violet", "teal", "brown"];
const html = `<!doctype html><title>probe</title><style>html,body{margin:0}.band{height:400px}</style>
${BANDS.map((c) => `<div class=band style="background:${c}"></div>`).join("")}
<div id=foot style="position:fixed;left:0;right:0;bottom:0;height:14px;background:#000"></div>
<button id=b style="position:absolute;left:100px;top:1700px;width:200px;height:60px;background:#fff;border:0;color:#fff">target</button>`;

const server = createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** A JPEG's pixels by way of `sips` (to BMP): the colour at (x, y) from the top left. */
function decode(frame: FrameEvent, name: string): { width: number; height: number; at(x: number, y: number): [number, number, number] } {
  const jpg = join(root, `${name}.jpg`), bmp = join(root, `${name}.bmp`);
  writeFileSync(jpg, Buffer.from(frame.data, "base64"));
  execFileSync("sips", ["-s", "format", "bmp", jpg, "--out", bmp], { stdio: "ignore" });
  const b = readFileSync(bmp);
  const off = b.readUInt32LE(10), width = b.readInt32LE(18), rawH = b.readInt32LE(22), bpp = b.readUInt16LE(28) / 8;
  const height = Math.abs(rawH), stride = Math.floor((width * bpp + 3) / 4) * 4;
  return { width, height, at(x, y) { const i = off + (rawH > 0 ? height - 1 - y : y) * stride + x * bpp; return [b[i + 2]!, b[i + 1]!, b[i]!]; } };
}
const near = (rgb: readonly number[], hex: string): boolean => [1, 3, 5].every((at, i) => Math.abs(rgb[i]! - parseInt(hex.slice(at, at + 2), 16)) < 48);
const named = (rgb: readonly number[]): string => NAMES[BANDS.findIndex((c) => near(rgb, c))] ?? (near(rgb, "#000000") ? "black" : near(rgb, "#ffffff") ? "white" : `rgb(${rgb.join(",")})`);

async function main(): Promise<void> {
  const forwarder = new Forwarder({ ownPorts: () => [] });
  let api: SharedBrowser | null = null;
  const driver: BrowserDriver = {
    async launch(launch) {
      const proxy = await forwarder.start();
      let config: Record<string, unknown> = {};
      try { config = api!.identity.launchConfig() as Record<string, unknown>; } catch { /* no identity yet: Camoufox's own */ }
      return camoufoxDriver({ executable: executable!, playwright: bundledPlaywright(), headless: mode !== "window", proxy, config }).launch(launch);
    },
  };
  api = sharedBrowser({ home, userHome, protected: defaultProtected({ ...process.env, HOME: userHome, AGENTSWITCH_HOME: home }), ownPorts: () => [], driver });
  const host = api.host;
  const AGENT: TabOwner = { kind: "terminal", id: "t1", label: "codex · probe" };
  const tab = await host.open(AGENT, `${base}/`);
  const page = host.page(tab.id)?.playwright?.() as Page;
  await sleep(2500);
  const events: BrowserEvent[] = [];
  // As another Mac asks: its display's 2 pixels a point, within a 1728 × 1117 display's pixels.
  // `PROBE_FPS=30`: as the Mac that runs the browser asks (15: another Mac, a phone).
  const fps = Number(process.env.PROBE_FPS ?? 15);
  const stop = host.subscribe(tab.id, { quality: 70, fps, scale: 2, maxWidth: 3456, maxHeight: 2234 }, (e) => events.push(e));
  const frames = (): FrameEvent[] => events.filter((e): e is FrameEvent => e.type === "frame");
  let shot = 0;
  /** The latest frame once the page has settled, with what it shows at CSS points. */
  const look = async () => {
    await sleep(1200);
    const frame = frames().at(-1);
    if (!frame) throw new Error("no frame came");
    const px = decode(frame, `frame-${++shot}`);
    const at = (x: number, y: number) => px.at(Math.min(px.width - 1, Math.max(0, Math.round(x * frame.scale))), Math.min(px.height - 1, Math.max(0, Math.round(y * frame.scale))));
    return { frame, at };
  };
  const where = async () => { const [w, h, x, y] = await page.evaluate("[innerWidth, innerHeight, scrollX, scrollY]") as number[]; return { w: w!, h: h!, x: x!, y: y! }; };

  for (const [label, scrollTo] of [["as opened", 0], ["scrolled to 1600", 1600], ["scrolled to 2500", 2500], ["back at the top", 0]] as const) {
    await page.evaluate(`scrollTo(0, ${scrollTo})`);
    const { frame, at } = await look();
    const now = await where();
    console.log(`\n== ${label}: the page says inner ${now.w}×${now.h}, scrolled to ${now.y}; frame ${frame.width}×${frame.height} at scale ${frame.scale}`);
    check("the frame says how far the page is scrolled", frame.scrollY === now.y, `frame ${frame.scrollY}, page ${now.y}`);
    const want = NAMES[Math.floor((now.y + 50) / 400)]!;
    check(`the picture's top is the document at ${now.y + 50}`, named(at(50, 50)) === want, `${named(at(50, 50))}, want ${want}`);
    check("the strip fixed to the window's foot is in the picture", named(at(50, frame.viewport.height - 5)) === "black", named(at(50, frame.viewport.height - 5)));
  }

  // What an agent acts on: measured as the bridge measures it (brought into view, with the page's scroll), then the
  // page scrolled by something else. The frame the screens are told of has to stay on the white button.
  console.log("\n== the frame around what an agent acted on");
  const locator = page.locator("#b");
  await locator.scrollIntoViewIfNeeded();
  const measured = (await locator.boundingBox())!;
  const at0 = await where();
  host.setAction(tab.id, { tool: "browser_click", description: "click \"target\"", box: { x: Math.round(measured.x), y: Math.round(measured.y), width: Math.round(measured.width), height: Math.round(measured.height) } }, { x: at0.x, y: at0.y });
  for (const by of [0, 120, -90]) {
    if (by) await page.evaluate(`scrollBy(0, ${by})`);
    const { at } = await look();
    const box = host.get(tab.id)!.action?.box;
    const now = await where();
    if (!box) { check(`scrolled by ${by}: a box is said`, false, "none"); continue; }
    const inside = named(at(box.x + 6, box.y + 6)), outside = named(at(box.x + 6, box.y - 8));
    check(`scrolled to ${now.y}: the box (${box.x}, ${box.y}) is on the button`, inside === "white" && outside !== "white", `inside ${inside}, just above ${outside}`);
  }
  await page.evaluate("scrollTo(0, 0)");
  await look();
  check("out of view: no box is said, what was done still is", !host.get(tab.id)!.action?.box && host.get(tab.id)!.action?.description === "click \"target\"", JSON.stringify(host.get(tab.id)!.action));

  // How many pictures a page that keeps moving gives, and what one costs.
  console.log("\n== pictures of a page that moves");
  const before = frames().length, began = Date.now();
  await page.evaluate("(() => { let y = 0; const t = setInterval(() => { scrollTo(0, y += 12); if (y > 2400) clearInterval(t); }, 16); })()");
  await sleep(3000);
  const got = frames().length - before;
  console.log(`  ${got} frames in ${((Date.now() - began) / 1000).toFixed(1)} s for a stream asking ${fps} a second`);
  check("a moving page gives pictures steadily", got >= 15, `${got}`);
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) await page.screenshot({ type: "jpeg", quality: 70, scale: "device", caret: "initial", animations: "allow" });
  console.log(`  one screenshot at the page's own pixels: ${((Date.now() - t0) / 10).toFixed(1)} ms`);
  // Once the scrolling is over and its scroll bar has faded.
  await sleep(4000);
  const still = frames().length;
  await sleep(3000);
  check("a page that stands still gives none", frames().length - still <= 1, `${frames().length - still}`);

  stop();
  await host.shutdown();
  await api.stop();
  await forwarder.stop().catch(() => undefined);
}

main().catch((err) => { wrong += 1; console.error(err); }).finally(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
  console.log(wrong ? `\n${wrong} WRONG` : "\nall ok");
  process.exit(wrong);
});
