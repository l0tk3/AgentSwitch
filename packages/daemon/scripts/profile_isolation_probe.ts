/** Two profiles' own browsers tried for real, side by side (docs/profiles-v0.md §5.5): the Camoufox the service itself
 *  would use, each browser on a folder of its own in a temporary place, neither with a proxy (each through a forwarder
 *  with nothing behind it). Checks that what one is signed in to the other does not have — a cookie and a stored value
 *  set by a page in one are not there in the other — that the two are started with different fingerprints, each kept
 *  for the next start, and that a browser stopped and started again still has its own sign-in.
 *  No window is shown; nothing of the user's is changed (only the engine's program is read from AgentSwitch's folder).
 *
 *    npx tsx scripts/profile_isolation_probe.ts */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EngineKit, engineRoot } from "../src/browser/engine/kit.js";
import { ExitPool } from "../src/browser/exits.js";
import { ProfileBrowsers } from "../src/browser/fleet.js";
import { sharedBrowser, type SharedBrowser } from "../src/browser/setup.js";
import { YOU } from "../src/browser/types.js";

const say = (line: string) => console.log(line);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Page = { evaluate<T>(fn: string): Promise<T>; waitForLoadState(state: string, o: { timeout: number }): Promise<void> };
type Told = { cookie: string; stored: string | null; screen: string; cores: number; canvas: string; gl: string; audio: string; fonts: string };
/** What a page can measure of the browser it is in — what a site would tell browsers apart by: a drawing's pixels, the
 *  graphics card's name, a sound's samples, a text's width. */
const MEASURE = `(async () => {
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); };
  const c = document.createElement("canvas"); c.width = 240; c.height = 60;
  const x = c.getContext("2d"); x.textBaseline = "top"; x.font = "16px Arial"; x.fillStyle = "#f60"; x.fillRect(10, 5, 120, 30);
  x.fillStyle = "#069"; x.fillText("AgentSwitch, 1ςδ €", 4, 12); x.arc(180, 30, 20, 0, Math.PI * 1.7); x.stroke();
  let gl = "none";
  try { const g = document.createElement("canvas").getContext("webgl"); const e = g.getExtension("WEBGL_debug_renderer_info"); gl = e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); } catch {}
  let audio = "none";
  try {
    const a = new OfflineAudioContext(1, 5000, 44100), o = a.createOscillator(), d = a.createDynamicsCompressor();
    o.type = "triangle"; o.frequency.value = 10000; o.connect(d); d.connect(a.destination); o.start(0);
    const b = (await a.startRendering()).getChannelData(0); let s = 0; for (let i = 4500; i < 5000; i++) s += Math.abs(b[i]); audio = s.toFixed(10);
  } catch {}
  const m = document.createElement("canvas").getContext("2d"); m.font = "72px monospace";
  return { cookie: document.cookie, stored: localStorage.getItem("account"), screen: screen.width + "x" + screen.height, cores: navigator.hardwareConcurrency,
    canvas: hash(c.toDataURL()), gl: String(gl), audio, fonts: String(m.measureText("mmmmmmmmmmlli").width) };
})()`;

async function main(): Promise<void> {
  const home = mkdtempSync(join(process.env.PROBE_TMP ?? tmpdir(), "as-isolation-"));
  // A site on this Mac standing in for one a person signs in to: `/in?who=…` signs in (a cookie and a stored value),
  // `/` says who is signed in.
  const site = createServer((req, res) => {
    const who = new URL(req.url ?? "/", "http://x").searchParams.get("who");
    res.writeHead(200, { "content-type": "text/html", ...(who ? { "set-cookie": `account=${who}; Path=/; Max-Age=86400` } : {}) })
      .end(`<title>site</title><script>${who ? `localStorage.setItem("account", ${JSON.stringify(who)});` : ""}</script><p>ok</p>`);
  });
  await new Promise<void>((ok) => site.listen(0, "127.0.0.1", ok));
  const at = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const kit = new EngineKit({ root: engineRoot(process.env.AGENTSWITCH_HOME ?? join(homedir(), "Library", "Application Support", "AgentSwitch")) });
  if (!kit.executable()) { say("no Camoufox installed in AgentSwitch's folder: nothing to try with"); site.close(); rmSync(home, { recursive: true, force: true }); return; }
  const exits = new ExitPool({ ownPorts: () => [], lookup: "http://unused.test/" });
  const profiles = new Set(["claude-code.aaaaaaaaaa", "claude-code.bbbbbbbbbb"]);
  const fleet = new ProfileBrowsers((key, forwarder) => sharedBrowser({ home, userHome: home, protected: { roots: [], exempt: [] }, ownPorts: () => [], headless: true, kit, own: { name: key, forwarder } }),
    exits, (key) => (profiles.has(key) ? { proxy: null } : null));
  const seen = async (browser: SharedBrowser, url: string) => {
    const tab = await browser.host.open(YOU, url);
    const page = browser.host.page(tab.id)?.playwright?.() as Page | undefined;
    await page?.waitForLoadState("load", { timeout: 20_000 }).catch(() => undefined);
    await sleep(400);
    return page?.evaluate<Told>(MEASURE).catch(() => null);
  };
  try {
    const a = fleet.of("claude-code.aaaaaaaaaa")!, b = fleet.of("claude-code.bbbbbbbbbb")!;
    say(`engine: ${a.engine()} · two browsers, no proxy behind either`);
    const inA = await seen(a, `${at}/in?who=alice`);
    const inB = await seen(b, `${at}/`);
    say(`1) signed in as alice in A: A's page has cookie "${inA?.cookie}", stored "${inA?.stored}"`);
    say(`   the same site in B: cookie "${inB?.cookie}", stored ${JSON.stringify(inB?.stored)} — ${!inB?.cookie && !inB?.stored ? "B knows nothing of A's sign-in" : "B SEES A'S SIGN-IN"}`);
    await seen(b, `${at}/in?who=bob`);
    const againA = await seen(a, `${at}/`);
    say(`2) signed in as bob in B; A still has: cookie "${againA?.cookie}", stored "${againA?.stored}" — ${againA?.cookie === "account=alice" ? "A's own" : "CHANGED"}`);
    const fa = a.identity.config(), fb = b.identity.config();
    const differ = Object.keys({ ...fa, ...fb }).filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k]));
    say(`3) fingerprints: ${differ.length} of ${Object.keys(fa).length} settings differ between A and B (${differ.slice(0, 6).join(", ")}${differ.length > 6 ? ", …" : ""})`);
    const same = (k: keyof Told) => (inA?.[k] === "none" || inB?.[k] === "none" ? "not measured here" : inA?.[k] === inB?.[k] ? "the same in both" : "differs");
    say(`   what a page can measure — cores: A ${inA?.cores}, B ${inB?.cores} · sound: ${same("audio")} · drawing (canvas): ${same("canvas")} · graphics card: ${same("gl")} (${inA?.gl.slice(0, 40)}) · text width: ${same("fonts")} · screen: ${same("screen")}`);
    const folders = readdirSync(join(home, "browser-profiles")).sort();
    say(`4) folders: ${folders.join(", ")} · a fingerprint kept for each: ${["aaaaaaaaaa", "bbbbbbbbbb"].map((id) => existsSync(join(home, "browser", "of", `claude-code.${id}`, "identity.json"))).join(", ")}`);
    // Stopped and started again: the same browser to the site as before.
    await fleet.drop("claude-code.aaaaaaaaaa");
    const again = fleet.of("claude-code.aaaaaaaaaa")!;
    const later = await seen(again, `${at}/`);
    say(`5) A stopped and started again: cookie "${later?.cookie}", stored "${later?.stored}" · the same fingerprint kept: ${JSON.stringify(again.identity.config()) === JSON.stringify(fa)} · its drawing as before: ${later?.canvas === inA?.canvas}`);
    say(`   (drawing — A ${inA?.canvas}, B ${inB?.canvas}, A again ${later?.canvas})`);
  } finally {
    await fleet.stop();
    await exits.stop();
    site.close();
    rmSync(home, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
