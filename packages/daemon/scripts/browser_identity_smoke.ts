/** Opt-in check of the browser's identity (docs/browser-v0.md §7.2 第 5 条) against a real Camoufox, without windows;
 *  not part of `npm test`. Everything lives in a temporary folder and on this Mac: the "upstream proxy" and the exit
 *  lookup are local stand-ins, no outside service is asked, no model is called, the gate is a stand-in too.
 *
 *    npx tsx scripts/browser_identity_smoke.ts <Camoufox's program>
 *
 *  Checks: a page reads the fingerprint (in the request and in the page, nothing of Camoufox), the same after a
 *  restart; a new one differs and the tabs come back; a proxy with a sealed password carries what leaves this Mac, with
 *  the password, at once, and not what stays on it; its exit is looked up through it; the exit's time zone is in force
 *  after a restart; `Direct` at once; a proxy whose password is not to be had lets nothing out. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { EngineKit } from "../src/browser/engine/kit.js";
import { bundledPlaywright } from "../src/browser/engine/loader.js";
import { FillRefused } from "../src/browser/fill.js";
import { sharedBrowser } from "../src/browser/setup.js";
import { YOU } from "../src/browser/types.js";
import { defaultProtected } from "../src/executors/protected.js";

const executable = process.argv[2];
if (!executable) { console.error("usage: browser_identity_smoke.ts <Camoufox's program>"); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), "agentswitch-browser-identity-"));
const home = join(root, "home"), userHome = join(root, "user");
mkdirSync(home, { recursive: true });
mkdirSync(userHome, { recursive: true });
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
const TOKEN = "enc:v1:smokesmokesmokesmokesmoke";
const PASSWORD = "p@ss word/1";

// A page on this Mac that says what the request carried.
const seenAgents: string[] = [];
const local = createServer((req, res) => {
  seenAgents.push(String(req.headers["user-agent"] ?? ""));
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>local ${req.url}</title>`);
});
// The stand-in upstream proxy: asks for the password, answers every outside name itself, and is the exit lookup too.
const upstreamSaw: { url: string; auth: string }[] = [];
const basic = (req: IncomingMessage) => Buffer.from(String(req.headers["proxy-authorization"] ?? "").replace(/^Basic /, ""), "base64").toString();
const upstream = createServer((req, res) => {
  upstreamSaw.push({ url: req.url ?? "", auth: basic(req) });
  if (basic(req) !== `smoke:${PASSWORD}`) { res.statusCode = 407; res.setHeader("proxy-authenticate", "Basic"); res.end(); return; }
  if (req.url?.startsWith("http://exit.test/")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ip: "203.0.113.24", city: "Tokyo", timezone: "Asia/Tokyo" })); return; }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end("<!doctype html><title>via upstream</title>");
});
await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
const proxyServer = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
process.env.AGENTSWITCH_BROWSER_EXIT_LOOKUP = "http://exit.test/json";

async function main(): Promise<void> {
  const copy = bundledPlaywright();
  // The engine as far as the browser's setup asks it: this Camoufox, the Playwright that came with the daemon.
  const kit = { executable: () => executable!, playwright: () => copy, store: { installed: () => ({ version: "156.0.1" }) }, status: () => ({ playwright: { firefox: "156.0" } }) } as unknown as EngineKit;
  let gateUp = true;
  const asked: (readonly string[])[] = [];
  const api = sharedBrowser({ home, userHome, protected: defaultProtected({ ...process.env, HOME: userHome, AGENTSWITCH_HOME: home }), ownPorts: () => [], kit, headless: true,
    fill: async (token, urls) => { asked.push(urls); if (!gateUp || token !== TOKEN) throw new FillRefused("refused"); return { value: PASSWORD, label: "browser/proxy" }; } });
  const { host, identity } = api;
  const page = (id: string) => host.page(id)?.playwright?.() as Page;
  const read = (id: string) => page(id).evaluate(`({ ua: navigator.userAgent, platform: navigator.platform, cores: navigator.hardwareConcurrency, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })`) as Promise<{ ua: string; platform: string; cores: number; tz: string }>;
  /** The title a page at `url` ends up with (an error page's, where it cannot be had). */
  const titleOf = async (url: string) => {
    const t = await host.open(YOU, url);
    let title = "";
    for (const end = Date.now() + 8_000; Date.now() < end && !title;) {
      await new Promise((r) => setTimeout(r, 100));
      title = page(t.id).url() === "about:blank" ? "" : await page(t.id).title().catch(() => "");
    }
    await host.close(t.id);
    return title;
  };
  const settled = async (id: string) => { for (const end = Date.now() + 8_000; Date.now() < end && !(await page(id).title().catch(() => "")).startsWith("local");) await new Promise((r) => setTimeout(r, 100)); };

  try {
    check(api.engine() === "camoufox", "the browser is Camoufox");
    const first = await host.open(YOU, `${base}/first`);
    await settled(first.id);
    const config = identity.config();
    const seen = await read(first.id);
    check(seen.ua === config["navigator.userAgent"] && /Firefox\/156\.0$/.test(seen.ua), `a page reads the fingerprint's browser: ${seen.ua}`);
    check(seenAgents.at(-1) === seen.ua, "the request says the same browser");
    check(!/camoufox/i.test(JSON.stringify(seen)) && !seenAgents.some((a) => /camoufox/i.test(a)), "nothing of Camoufox in either");
    check(seen.cores === config["navigator.hardwareConcurrency"] && seen.platform === config["navigator.platform"], `cores and platform are the fingerprint's: ${seen.cores}, ${seen.platform}`);
    const zone = seen.tz;

    await host.restart();
    const again = host.list().find((t) => t.url.endsWith("/first"));
    check(Boolean(again), "after a restart the tab is back");
    await settled(again!.id);
    check(JSON.stringify(await read(again!.id)) === JSON.stringify(seen), "and reads the same fingerprint");

    // A new fingerprint: in force after a restart (the API does both).
    for (let i = 0; i < 6 && identity.config()["audio:seed"] === config["audio:seed"]; i++) await identity.setFingerprint("new");
    check(identity.config()["audio:seed"] !== config["audio:seed"], "a new fingerprint is another one");
    await identity.setFingerprint({ config: { ...identity.config(), "navigator.hardwareConcurrency": 6 } });
    await host.restart();
    const third = host.list().find((t) => t.url.endsWith("/first"))!;
    await settled(third.id);
    check((await read(third.id)).cores === 6, "a fingerprint brought from elsewhere is read after the restart");

    // A proxy with a sealed password: at once, for what leaves this Mac only.
    check(await titleOf("http://outside.test/a").then((t) => t !== "via upstream"), "without a proxy an outside name does not reach the stand-in");
    await identity.setProxy({ server: proxyServer, username: "smoke", password: TOKEN });
    check(asked.at(-1)?.[0] === `${proxyServer}/`, "the gate is asked for the password for the proxy's own host");
    check(!readFileSync(join(home, "browser", "identity.json"), "utf8").includes(PASSWORD), "the password is not written down");
    check(await titleOf("http://outside.test/b") === "via upstream", "with the proxy, an outside name goes through it, with the password, at once");
    check(upstreamSaw.every((s) => !s.url.includes("127.0.0.1")), "what stays on this Mac does not go to the proxy");
    check((await titleOf(`${base}/local`)).startsWith("local"), "and still loads");
    const view = identity.view({ running: host.running });
    check(view.exit !== null && "ip" in view.exit && view.exit.ip === "203.0.113.24" && view.exit.place === "Tokyo", `the exit is looked up through the proxy: ${JSON.stringify(view.exit)}`);
    check(upstreamSaw.some((s) => s.url === "http://exit.test/json"), "the lookup went the browser's way");
    check(view.fingerprint.summary.timezone === "Asia/Tokyo" && view.restartNeeded, "the time zone follows the exit, from the next start");
    check((await read(third.id)).tz === zone, `until then the running browser keeps its zone: ${zone}`);
    await host.restart();
    const fourth = host.list().find((t) => t.url.endsWith("/first"))!;
    await settled(fourth.id);
    check((await read(fourth.id)).tz === "Asia/Tokyo", "after a restart pages read the exit's time zone");
    check(!identity.view({ running: host.running }).restartNeeded, "and nothing waits for a restart any more");

    // Direct, at once.
    await identity.setProxy(null);
    const before = upstreamSaw.length;
    check(await titleOf("http://outside.test/c").then((t) => t !== "via upstream") && upstreamSaw.length === before, "Direct: nothing goes to the proxy any more");

    // A stored proxy whose password the gate does not give: nothing leaves, not straight either.
    await identity.setProxy({ server: proxyServer, username: "smoke", password: TOKEN });
    gateUp = false;
    const later = sharedBrowser({ home, userHome, protected: defaultProtected({ ...process.env, HOME: userHome, AGENTSWITCH_HOME: home }), ownPorts: () => [], kit, headless: true,
      fill: async () => { throw new FillRefused("refused"); } });
    await later.identity.start();
    let refused = false;
    try { later.identity.upstream(); } catch { refused = true; }
    check(refused, "a proxy whose password is not to be had lets nothing out");
    await later.stop();
  } finally {
    await host.shutdown().catch(() => undefined);
    await api.stop().catch(() => undefined);
  }
}

try { await main(); } catch (err) { check(false, `the run: ${(err as Error).stack?.split("\n").slice(0, 4).join(" / ")}`); }
local.close();
upstream.close();
rmSync(root, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed` : "\nall ok");
process.exit(failures.length ? 1 : 0);
