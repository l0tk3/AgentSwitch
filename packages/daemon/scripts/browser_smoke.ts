/** Opt-in smoke test of the shared browser against the real Google Chrome (docs/browser-v0.md §3 step 2); not part of
 *  `npm test`. Everything lives in a temporary folder: AgentSwitch's home, the `main` profile, the user's home and the
 *  pages. No model is called and the user's own Chrome profiles are never touched.
 *
 *    npx tsx scripts/browser_smoke.ts
 *
 *  Checks: Chrome runs over the pipe with no debugging port and listens on no TCP port; a local page opens, streams
 *  frames and follows its title; clicks, text and keys reach it; a credential file is refused before opening and when a
 *  page links or embeds it; AgentSwitch's own port is refused; a popup becomes a tab of the same owner; the holder's
 *  size applies and goes back on release; Chrome quits on shutdown.
 *
 *  Then the agent bridge (step 3), through the real gate (the repo's secret-gate, with a throw-away key in the temporary
 *  folder and no gate service): an MCP client speaks to `secret-gate browser -- <bridge>`, the bridge to a local
 *  listener with the session's token, Playwright MCP runs in this process on the agent's own tabs. Navigate and
 *  snapshot; the agent's tab, action and status on the host; the person's tab out of the agent's list; secret_fill of a
 *  ciphertext typed and redacted, a masked screenshot written by the daemon and verified by the gate; a held tab's call
 *  waiting and failing; a person's Fill Ciphertext refused on the agent's tab, refused into a text field and typed
 *  into a password field of the person's own tab through `secret-gate fill-value`; a login the person types into the
 *  agent's tab while holding it kept out of the agent's network and console logs, also for a second, reconnecting
 *  bridge; the code tools held to the gate's probes; Playwright MCP's folder empty after the calls; an SVG file opened
 *  as a page (a document without a body) answered at once and said to be one.
 *
 *  Also (review 2026-10-02): AgentSwitch's data refused under the data volume's spelling, a redirect to AgentSwitch's own
 *  port refused for a subresource (Chrome blocks it) and for a navigation (stopped, the refusal shown).
 *
 *  Device pixels (§5, 2026-10-03): a stream that asks for scale 2 gets the page drawn at 2 (2560×1600 frames of a
 *  1280×800 page) and a click on such a frame lands; when a tab opened after it closes (Chrome then makes it the
 *  window's front tab and sets its view to the window's size) its frames are still 2560×1600 of the 1280×800 page;
 *  without that stream the frames are the CSS size again; an agent's click through the gate lands while a screen shows
 *  its tab at 2, which is at 2 again a moment after the call; an agent's screenshots meanwhile are 1280×800 pictures
 *  and leave the page 1280×800. */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import type { Page } from "playwright-core";
import { mountBrowser } from "../src/api/browser.js";
import { LocalAuth } from "../src/api/localAuth.js";
import type { ApiDeps } from "../src/api/shared.js";
import { bridgeCommand, terminalOwner } from "../src/browser/agents.js";
import { gateFill } from "../src/browser/fill.js";
import { listenLocal } from "../src/daemon.js";
import { VENV_GATE_BIN } from "../src/executors/gate.js";
import { defaultProtected } from "../src/executors/protected.js";
import { sharedBrowser } from "../src/browser/setup.js";
import { BrowserError, YOU, type BrowserEvent, type FrameEvent } from "../src/browser/types.js";

const root = mkdtempSync(join(tmpdir(), "agentswitch-browser-smoke-"));
const home = join(root, "agentswitch-home");
const userHome = join(root, "user");
const site = join(userHome, "site");
mkdirSync(site, { recursive: true });
mkdirSync(home, { recursive: true });

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

function listen(): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(req.url ?? ""); res.end("<title>own</title>own"); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, hits })));
}

/** A server that sends every request on to AgentSwitch's own port. */
function redirector(to: number): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${to}${req.url ?? "/"}` }); res.end(); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

async function main(): Promise<void> {
  own = await listen();
  redirect = await redirector(own.port);
  writeFileSync(join(site, ".env"), "SECRET=1\n");
  writeFileSync(join(site, "page2.html"), "<title>Second</title><p>second page</p>");
  writeFileSync(join(site, "index.html"), `<!doctype html><title>Smoke</title>
<style>body{margin:0;font:16px sans-serif} #b{position:absolute;left:10px;top:10px;width:200px;height:50px}
#t{position:absolute;left:10px;top:80px;width:300px;height:30px} #l{position:absolute;left:10px;top:130px} #p{position:absolute;left:10px;top:170px}
#n{position:absolute;left:900px;top:600px;width:120px;height:40px}</style>
<button id="b" onclick="document.title='Clicked'">click</button>
<button id="n" onclick="this.textContent=String(Number(this.textContent)+1);document.title='count:'+this.textContent">0</button>
<input id="t" oninput="document.title='typed:'+this.value">
<a id="l" href=".env">env</a>
<a id="p" href="page2.html" target="_blank">popup</a>
<iframe src=".env" style="position:absolute;top:220px"></iframe>
<img src="http://127.0.0.1:${own.port}/pixel.png"><img src="http://localhost:${redirect.port}/redirected-pixel.png">`);

  const api = sharedBrowser({ home, userHome, protected: defaultProtected({ ...process.env, HOME: userHome, AGENTSWITCH_HOME: home }), ownPorts: () => [own.port] });
  const host = api.host;
  const profile = join(home, "browser-profiles", "main");

  const url = pathToFileURL(join(site, "index.html")).href;
  const tab = await host.open(YOU, url);
  check(tab.owner.kind === "you" && tab.kind === "file", "a local page opens as the user's tab");

  // The pipe, not a port.
  const pids = execFileSync("pgrep", ["-f", "--", `--user-data-dir=${profile}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const main = pids.find((pid) => !execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).includes("--type="));
  const command = main ? execFileSync("ps", ["-ww", "-o", "command=", "-p", main], { encoding: "utf8" }) : "";
  check(command.includes("--remote-debugging-pipe") && !command.includes("--remote-debugging-port"), "Chrome is driven over --remote-debugging-pipe, with no --remote-debugging-port");
  check(command.includes("--headless") && !command.includes("--no-sandbox"), "new headless, sandbox on");
  let listening = "";
  try { listening = execFileSync("lsof", ["-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" }); } catch { listening = ""; }
  check(listening.trim() === "", "no Chrome process of the profile listens on a TCP port");

  const events: BrowserEvent[] = [];
  const stop = host.subscribe(tab.id, { quality: 60, fps: 10 }, (ev) => events.push(ev));
  const frame = await until(() => events.find((e): e is FrameEvent => e.type === "frame"), "a frame arrives");
  check(!!frame && frame.width === 1280 && frame.viewport.width === 1280 && frame.scale === 1, `the frame is 1280 wide at scale 1 (${frame?.width}, ${frame?.scale})`);
  await until(() => host.get(tab.id)?.title === "Smoke", "the title is read");
  await new Promise((r) => setTimeout(r, 500));
  check(own.hits.length === 0, `a page's request to AgentSwitch's own port is blocked, a redirect to it too (${own.hits.join(", ") || "none reached it"})`);

  await host.input(tab.id, "smoke", [{ type: "mouse", action: "click", x: 50, y: 30, button: "left", clickCount: 1, modifiers: [] }]);
  await until(() => events.some((e) => e.type === "title" && e.title === "Clicked"), "a click reaches the page (title event)");
  await host.input(tab.id, "smoke", [{ type: "mouse", action: "click", x: 50, y: 90, button: "left", clickCount: 1, modifiers: [] }, { type: "text", text: "hello" }]);
  await until(() => host.get(tab.id)?.title === "typed:hello", "text is inserted");
  await host.input(tab.id, "smoke", [{ type: "key", key: "Backspace", modifiers: [] }]);
  await until(() => host.get(tab.id)?.title === "typed:hell", "Backspace edits the field");

  try { host.navigate(tab.id, "smoke", pathToFileURL(join(site, ".env")).href); check(false, "navigating to .env is refused"); }
  catch (err) { check(err instanceof BrowserError && err.code === "forbidden", `navigating to .env is refused: ${(err as Error).message}`); }
  try { await host.open(YOU, `http://127.0.0.1:${own.port}/`); check(false, "opening AgentSwitch's own port is refused"); }
  catch (err) { check(err instanceof BrowserError && err.code === "forbidden", "opening AgentSwitch's own port is refused"); }
  try { await host.open(YOU, `http://localhost.:${own.port}/`); check(false, "opening AgentSwitch's own port as localhost. is refused"); }
  catch (err) { check(err instanceof BrowserError && err.code === "forbidden", "opening AgentSwitch's own port as localhost. is refused"); }
  writeFileSync(join(home, "local-token"), "smoke-token");
  try { await host.open(YOU, pathToFileURL(`/System/Volumes/Data${realpathSync(home)}/local-token`).href); check(false, "AgentSwitch's data under the data volume's spelling is refused"); }
  catch (err) { check(err instanceof BrowserError && err.code === "forbidden", `AgentSwitch's data under the data volume's spelling is refused (${(err as Error).message})`); }
  // A navigation a redirect brings to the own port: it reaches the server (nothing can stop a redirect hop), the page
  // shows the refusal instead of the answer.
  const bounced = await host.open(YOU, `http://localhost:${redirect.port}/bounced`);
  await until(() => host.get(bounced.id)?.title === "Not Viewable", "a navigation redirected to AgentSwitch's own port shows the refusal page");
  await host.close(bounced.id);

  // The popup first (the page is still there), then the link to the credential file.
  await host.input(tab.id, "smoke", [{ type: "mouse", action: "click", x: 20, y: 178, button: "left", clickCount: 1, modifiers: [] }]);
  const popup = await until(() => host.list().find((t) => t.id !== tab.id), "a popup becomes a tab");
  check(!!popup && popup.owner.kind === "you", "the popup belongs to the opener's owner");
  if (popup) await until(() => host.get(popup.id)?.title === "Second", "the popup loads");

  await host.input(tab.id, "smoke", [{ type: "mouse", action: "click", x: 20, y: 138, button: "left", clickCount: 1, modifiers: [] }]);
  await until(() => host.get(tab.id)?.url.endsWith("/.env") && host.get(tab.id)?.title === "Not Viewable", "a link to .env shows the refusal page");

  host.take(tab.id, "phone-1");
  await host.setViewport(tab.id, "phone-1", { width: 390, height: 844, scale: 2, mobile: true });
  // Chrome draws screencast frames at viewport size whatever the pixel ratio: 390 wide, scale 1.
  await until(() => events.some((e) => e.type === "frame" && e.viewport.width === 390 && e.width === 390), "the holder's size applies (390 wide, mobile)");
  host.release(tab.id, "phone-1");
  await until(() => [...events].reverse().find((e): e is FrameEvent => e.type === "frame")?.viewport.width === 1280, "the size goes back on release");
  stop();

  // Device pixels (§5, 2026-10-03): a stream that asks for 2 gets the page drawn at 2; a click on such a frame lands
  // where it was aimed; without that stream the frames are the CSS size again.
  const crisp = await host.open(YOU, url);
  await until(() => host.get(crisp.id)?.title === "Smoke", "a second tab of the page loads");
  const sharp: BrowserEvent[] = [];
  const stopSharp = host.subscribe(crisp.id, { quality: 80, fps: 10, scale: 2 }, (ev) => sharp.push(ev));
  const big = await until(() => sharp.find((e): e is FrameEvent => e.type === "frame" && e.width === 2560), "a stream that asks for scale 2 gets 2560-wide frames");
  check(!!big && big.height === 1600 && big.scale === 2 && big.viewport.width === 1280 && big.viewport.height === 800,
    `the frame is the 1280x800 page at 2 (${big?.width}x${big?.height}, scale ${big?.scale}, viewport ${big?.viewport.width}x${big?.viewport.height})`);
  // The button is CSS (10..210, 10..60): frame (100, 60) is CSS (50, 30).
  await host.input(crisp.id, "smoke", [{ type: "mouse", action: "click", x: 100, y: 60, button: "left", clickCount: 1, modifiers: [], seq: big?.seq }]);
  await until(() => host.get(crisp.id)?.title === "Clicked", "a click on a frame of the page at 2 lands on the button");
  // A tab opened after it, and closed: Chrome makes this one the window's front tab and sets its view to the window's
  // 1280×713 (review, 2026-10-03). The view is drawn again: what repaints next comes as the 1280×800 page at 2.
  const later = await host.open(YOU, url);
  await until(() => host.get(later.id)?.title === "Smoke", "a tab opened after it loads");
  const closedAt = sharp.length;
  await host.close(later.id);
  await new Promise((r) => setTimeout(r, 300));
  // The counting button is CSS (900..1020, 600..640), outside the window's 1280×713 at 2: frame (1900, 1240).
  await host.input(crisp.id, "smoke", [{ type: "mouse", action: "click", x: 1900, y: 1240, button: "left", clickCount: 1, modifiers: [] }]);
  await until(() => host.get(crisp.id)?.title === "count:1", "after that tab closed, a click near the far corner of the watched tab lands");
  await new Promise((r) => setTimeout(r, 500));
  const since = sharp.slice(closedAt).filter((e): e is FrameEvent => e.type === "frame");
  const whole = (f: FrameEvent) => f.width === 2560 && f.height === 1600 && f.scale === 2 && f.viewport.width === 1280 && f.viewport.height === 800;
  const cut = since.find((f) => !whole(f));
  check(since.length > 0 && !cut, `and its frames are still 2560x1600 of the 1280x800 page (${since.length} frames since`
    + `${cut ? `, one ${cut.width}x${cut.height} of a ${cut.viewport.width}x${cut.viewport.height} page` : ""})`);
  stopSharp();
  const plain: BrowserEvent[] = [];
  const stopPlain = host.subscribe(crisp.id, { quality: 60, fps: 10 }, (ev) => plain.push(ev));
  const small = await until(() => plain.find((e): e is FrameEvent => e.type === "frame" && e.width === 1280), "without it, frames are the CSS size again");
  await host.input(crisp.id, "smoke", [{ type: "mouse", action: "click", x: 50, y: 90, button: "left", clickCount: 1, modifiers: [], seq: small?.seq }, { type: "text", text: "1x" }]);
  await until(() => host.get(crisp.id)?.title === "typed:1x", "and a click on a CSS-size frame lands too");
  stopPlain();
  await host.close(crisp.id);

  // A blank tab (Chrome's own first page, sent to about:blank again) still closes.
  const blank = await host.open(YOU, "about:blank");
  const closed = await Promise.race([host.close(blank.id).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3_000))]);
  check(closed && !host.get(blank.id), "a blank tab closes at once");

  const servers = await api.servers();
  check(!servers.some((s) => s.port === own.port), "AgentSwitch's own port is not listed as a local server");

  await host.shutdown();
  await new Promise((r) => setTimeout(r, 500));
  let left = "";
  try { left = execFileSync("pgrep", ["-f", "--", `--user-data-dir=${profile}`], { encoding: "utf8" }).trim(); } catch { left = ""; }
  check(left === "", "Chrome quits on shutdown");
}

/** A PNG's pixel size (its IHDR), from base64. */
function pngSize(data: string | undefined): string {
  const png = Buffer.from(data ?? "", "base64");
  return png.length >= 24 ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : "no picture";
}

/** An MCP client on a child's stdio (the agent's side of the gate). */
function mcpClient(child: ChildProcessWithoutNullStreams) {
  let buffer = "";
  let next = 0;
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try { const m = JSON.parse(line) as Record<string, unknown>; if (typeof m.id === "number") waiting.get(m.id)?.(m); } catch { /* not ours */ }
    }
  });
  const request = (method: string, params: object = {}, ms = 60_000): Promise<Record<string, unknown>> => {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), ms);
      waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  const call = async (name: string, args: object = {}, ms?: number) => {
    const m = await request("tools/call", { name, arguments: args }, ms);
    const result = (m.result ?? {}) as { content?: { type: string; text?: string; data?: string }[]; isError?: boolean };
    const text = (result.content ?? []).map((c) => c.text ?? `[${c.type}]`).join("\n");
    return { error: result.isError === true || m.error !== undefined, text: text || JSON.stringify(m.error ?? ""), result };
  };
  return { request, notify, call };
}

/** Step 3: an agent through the real gate, the bridge and Playwright MCP in this process. */
async function bridgeRoundTrip(): Promise<void> {
  if (!existsSync(VENV_GATE_BIN)) { check(false, `the repo's secret-gate exists (${VENV_GATE_BIN})`); return; }
  const bhome = join(root, "bridge-home");
  const gateHome = join(root, "gate-home");
  const noService = join(root, "no-gate-public");
  mkdirSync(bhome, { recursive: true });
  mkdirSync(noService, { recursive: true });
  // Never the machine's own gate service: the people's fill (`gateFill`) runs the CLI with this process's env.
  process.env.SECRET_GATE_PUBLIC = noService;
  const gateEnv: NodeJS.ProcessEnv = { ...process.env, SECRET_GATE_HOME: gateHome, SECRET_GATE_PUBLIC: noService };
  for (const v of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) delete gateEnv[v];
  execFileSync(VENV_GATE_BIN, ["keygen"], { env: gateEnv, stdio: "ignore" });

  // A page with a field that shows what reaches it, and a site for it.
  const site = createServer((req, res) => {
    if (req.url === "/report.bin") { res.setHeader("content-disposition", "attachment; filename=report.bin"); res.end("data"); return; }
    if (req.url === "/ride.svg") {
      // A picture opened as a page: a document without a body, moving all the time.
      res.setHeader("content-type", "image/svg+xml");
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><title>Ride</title><circle cx="20" cy="50" r="12" fill="teal"><animate attributeName="cx" values="20;180;20" dur="2s" repeatCount="indefinite"/></circle></svg>`);
      return;
    }
    if (req.method === "POST") { req.resume(); req.on("end", () => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end("<title>Signed in</title><p>welcome</p>"); }); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>Portal</title><style>body{margin:0} #pw{position:absolute;left:10px;top:60px;width:240px;height:30px}
#user{position:absolute;left:10px;top:110px;width:240px;height:30px} #hand{position:absolute;left:10px;top:160px;width:240px;height:30px}</style>
<button id="m" onclick="document.title='merged'">Merge pull request</button> <a href="/report.bin">Download report</a>
<input id="pw" type="password" aria-label="Password" oninput="document.title='typed:'+this.value">
<input id="user" type="text" aria-label="User" oninput="document.title='user:'+this.value">
<form method="post" action="/session"><input id="hand" name="password" type="password" aria-label="Hand" oninput="console.log('typed ' + this.value)"></form>`);
  });
  const sitePort = await new Promise<number>((r) => site.listen(0, "127.0.0.1", () => r((site.address() as AddressInfo).port)));
  const siteUrl = `http://127.0.0.1:${sitePort}/login`;
  const PLAIN = `smoke-secret-${Date.now()}`;
  const token = execFileSync(VENV_GATE_BIN, ["enc", "--label", "smoke/pw", "--host", `127.0.0.1:${sitePort}`, "--use", "fill", "--use", "http", "--stdin"], { env: gateEnv, input: PLAIN, encoding: "utf8" }).trim();
  check(token.startsWith("enc:v1:"), "a throw-away ciphertext for the test site");

  const api = sharedBrowser({ home: bhome, userHome, protected: defaultProtected({ ...process.env, HOME: userHome, AGENTSWITCH_HOME: bhome }), ownPorts: () => [own.port],
    holdWaitMs: 1_500, fill: gateFill({ bin: VENV_GATE_BIN, home: gateHome }) });
  const host = api.host;
  const app = new Hono();
  mountBrowser(app, { browser: api } as unknown as ApiDeps);
  const localToken = "smoke-local-token-0123456789abcdefghijklmnop";
  let listener: ReturnType<typeof listenLocal> | null = null;
  const port = await new Promise<number>((r) => { listener = listenLocal({ app }, 0, (info) => r(info.port), new LocalAuth(localToken)); });
  const owner = terminalOwner("smoke1", "codex", "/Users/me/AgentSwitch");
  const session = api.agents.mint(owner);
  const mine = await host.open(YOU, `${siteUrl}?mine=1`);

  const gate = spawn(VENV_GATE_BIN, ["browser", "--", ...bridgeCommand(session, `http://127.0.0.1:${port}`)], { env: gateEnv, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  let gateErr = "";
  gate.stderr.on("data", (d: Buffer) => { gateErr += d.toString(); });
  const mcp = mcpClient(gate);
  try {
    const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    check(!!init.result, "the gate in front of the bridge answers initialize");
    mcp.notify("notifications/initialized");
    const tools = ((await mcp.request("tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name);
    check(tools.includes("browser_navigate") && tools.includes("secret_fill") && !tools.includes("browser_run_code_unsafe") && !tools.includes("browser_evaluate"),
      "the gate lists Playwright MCP's tools from the daemon, with secret_fill, without the code tools");

    const nav = await mcp.call("browser_navigate", { url: siteUrl });
    check(!nav.error && nav.text.includes("Opened in tab \"codex · AgentSwitch\""), `navigate opens the agent's own tab (${nav.text.split("\n")[0]})`);
    const tab = host.tabsOf(owner)[0];
    check(!!tab && tab.owner.label === "codex · AgentSwitch", "the tab is listed under the agent's name");
    if (!tab) return;
    await until(() => host.get(tab.id)?.title === "Portal", "the agent's page loads in the shared browser");
    check(host.get(tab.id)?.action?.description === `open 127.0.0.1:${sitePort}` && host.get(tab.id)?.status === "idle", "the overlay says what it did; idle after");

    const snap = await mcp.call("browser_snapshot");
    const ref = /button "Merge pull request" \[ref=(e\d+)\]/.exec(snap.text)?.[1];
    const pwRef = /textbox "Password" \[ref=(e\d+)\]/.exec(snap.text)?.[1];
    check(!!ref && !!pwRef, "a snapshot through the gate shows the page");
    const list = await mcp.call("browser_tabs", { action: "list" });
    check(!list.text.includes("mine=1") && list.text.includes("/login"), "the person's tab is not in the agent's list");

    const filled = await mcp.call("secret_fill", { target: pwRef, token });
    await until(() => host.get(tab.id)?.title === `typed:${PLAIN}`, "secret_fill types the value into the agent's page");
    check(!filled.error && !filled.text.includes(PLAIN), `the gate's answer holds no value (${filled.text.replace(/\s+/g, " ").slice(0, 120)})`);
    const after = await mcp.call("browser_snapshot");
    check(!after.text.includes(PLAIN), "the snapshot after the fill holds no value");
    const shot = await mcp.call("browser_take_screenshot");
    check(!shot.error && shot.text.includes("masked"), `a screenshot after the fill is masked and verified (${shot.text.slice(0, 100)})`);

    const box = host.get(tab.id)?.action?.box;
    // A screen shows the agent's tab at 2 (§5): Playwright's click, in CSS pixels, still lands; the tab is at 2 again
    // a moment after the call.
    const watched: BrowserEvent[] = [];
    const stopWatching = host.subscribe(tab.id, { quality: 80, fps: 10, scale: 2 }, (ev) => watched.push(ev));
    await until(() => watched.some((e) => e.type === "frame" && e.scale === 2), "a screen sees the agent's tab at 2");
    await mcp.call("browser_click", { target: ref, element: "Merge pull request" });
    await until(() => host.get(tab.id)?.title === "merged", "a click through the gate reaches the page (the tab shown at 2)");
    const action = host.get(tab.id)?.action;
    check(action?.description === 'click "Merge pull request"' && !!action.box && action.box.width > 50, `the overlay shows the click and the button's box (${JSON.stringify(action?.box ?? box)})`);
    // At 2 again: by the frame's size too, and by what the page says of its own.
    const at2 = (from: number) => watched.slice(from).some((e) => e.type === "frame" && e.scale === 2 && e.width === 2560 && e.height === 1600 && e.viewport.width === 1280);
    const pageSize = async (): Promise<string> => String(await (host.page(tab.id)?.playwright?.() as Page | undefined)?.evaluate("innerWidth + 'x' + innerHeight").catch(() => "gone"));
    const clickedAt = watched.length;
    await until(() => at2(clickedAt), "the agent's tab is at 2 again after the call (2560x1600 frames)", 8_000);
    // A screenshot while a screen shows the tab at 2 (review, 2026-10-03): Playwright's capture of a view drawn at a
    // scale laid the page out at 2560×1600 and left it so. The picture is taken on the CSS size: 1280×800 both times,
    // and the page is 1280×800 before, between and after.
    const sizes = [await pageSize()];
    const pictures: string[] = [];
    for (let i = 0; i < 2; i++) {
      const taken = await mcp.call("browser_take_screenshot");
      pictures.push(taken.error ? `refused: ${taken.text.slice(0, 80)}` : pngSize(taken.result.content?.find((c) => c.type === "image")?.data));
      sizes.push(await pageSize());
    }
    check(pictures.every((p) => p === "1280x800") && sizes.every((p) => p === "1280x800"),
      `two screenshots of the tab shown at 2 are 1280x800 pictures of a page that stays 1280x800 (pictures ${pictures.join(", ")}; the page ${sizes.join(", ")})`);
    const shotAt = watched.length;
    await until(() => at2(shotAt), "and the tab is at 2 again after them", 8_000);
    check(await pageSize() === "1280x800", `the page still 1280x800 (${await pageSize()})`);
    stopWatching();

    host.take(tab.id, "phone-1");
    const waited = Date.now();
    const held = await mcp.call("browser_snapshot");
    check(held.error && held.text.includes("The user is using this tab") && Date.now() - waited >= 1_400, "a call on a held tab waits, then fails in words");
    const queued = mcp.call("browser_snapshot");
    await new Promise((r) => setTimeout(r, 300));
    host.release(tab.id, "phone-1");
    check(!(await queued).error, "a queued call runs once the tab is handed back");

    // A login the person types by hand into the agent's tab while holding it: kept out of the agent's logs.
    const HAND = `hand-typed-${Date.now()}`;
    host.take(tab.id, "phone-1");
    try { await host.fill(tab.id, "phone-1", token, api.fill!); check(false, "a person's fill on the agent's tab is refused"); }
    catch (err) { check(err instanceof BrowserError && err.code === "conflict", `a person's fill on the agent's tab is refused (${(err as Error).message})`); }
    await host.input(tab.id, "phone-1", [{ type: "mouse", action: "click", x: 50, y: 175, button: "left", clickCount: 1, modifiers: [] }, { type: "text", text: HAND }, { type: "key", key: "Enter", modifiers: [] }]);
    await until(() => host.get(tab.id)?.title === "Signed in", "the person's login (typed by hand) is sent while the tab is held");
    host.release(tab.id, "phone-1");
    // The list itself (the page's header below it names the page the login led to).
    const listed = (text: string) => text.split("### Page")[0]!;
    const requests = await mcp.call("browser_network_requests", { static: true });
    check(!requests.error && listed(requests.text).includes("/login") && !listed(requests.text).includes("/session"), `the hold's login request is not in the agent's network log (${listed(requests.text).replace(/\s+/g, " ").slice(0, 160)})`);
    const consoleLog = await mcp.call("browser_console_messages", { all: true, level: "debug" });
    check(!consoleLog.text.includes(HAND), "the hold's console messages are not in the agent's console log");
    // A second bridge of the same session (a reconnect) builds its tabs from the page's own records.
    const again = spawn(VENV_GATE_BIN, ["browser", "--", ...bridgeCommand(session, `http://127.0.0.1:${port}`)], { env: gateEnv, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    try {
      const second = mcpClient(again);
      await second.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-2", version: "1" } });
      second.notify("notifications/initialized");
      const reread = await second.call("browser_network_requests", { static: true });
      check(!reread.error && !listed(reread.text).includes("/session") && !reread.text.includes(HAND), `a reconnecting bridge does not see the hold's request either (${listed(reread.text).replace(/\s+/g, " ").slice(0, 160)})`);
      const reconsole = await second.call("browser_console_messages", { all: true, level: "debug" });
      check(!reconsole.text.includes(HAND), "nor its console messages");
    } finally {
      again.stdin.end();
      await new Promise((r) => { again.once("exit", r); setTimeout(r, 5_000); });
    }
    await mcp.call("browser_navigate", { url: siteUrl });

    // A person's Fill Ciphertext, on the person's own tab: into the password field, not into a text field.
    await host.input(mine.id, "mac-1", [{ type: "mouse", action: "click", x: 50, y: 125, button: "left", clickCount: 1, modifiers: [] }]);
    try { await host.fill(mine.id, "mac-1", token, api.fill!); check(false, "a fill into a text field is refused"); }
    catch (err) { check(err instanceof BrowserError && err.code === "invalid" && (err as Error).message === "只能填入密码或验证码输入框。", "a fill into a text field is refused"); }
    await host.input(mine.id, "mac-1", [{ type: "mouse", action: "click", x: 50, y: 75, button: "left", clickCount: 1, modifiers: [] }]);
    try {
      const done = await host.fill(mine.id, "mac-1", token, api.fill!);
      check(done.label === "smoke/pw" && done.host === `127.0.0.1:${sitePort}`, "a person's fill is resolved by secret-gate fill-value for this page");
      await until(() => host.get(mine.id)?.title === `typed:${PLAIN}`, "a person's fill types into the focused password field");
    } catch (err) { check(false, `a person's fill: ${(err as Error).message}`); }
    await host.navigate(mine.id, "mac-1", `${siteUrl}?mine=2`);
    await until(() => host.get(mine.id)?.title === "Portal", "the person's tab reloads");
    try { await host.fill(mine.id, "mac-1", token, api.fill!); check(false, "a fill without a focused field is refused"); }
    catch (err) { check(err instanceof BrowserError && err.code === "invalid", "a fill without a focused field is refused"); }

    // A download (refused by the shared browser): Playwright MCP's attempt to save it must not stop the daemon.
    const linkRef = /link "Download report" \[ref=(e\d+)\]/.exec((await mcp.call("browser_snapshot")).text)?.[1];
    await mcp.call("browser_click", { target: linkRef, element: "Download report" });
    await new Promise((r) => setTimeout(r, 1_000));
    check(!(await mcp.call("browser_snapshot")).error, "a refused download leaves the daemon and the agent's tab working");
    check(process.listeners("unhandledRejection").every((l) => !String(l).includes("_pendingUnhandledRejections")), "Playwright MCP's process-wide rejection listener is taken off");
    const agentsDir = join(bhome, "browser", "agents");
    const leftovers = existsSync(agentsDir) ? readdirSync(agentsDir).flatMap((d) => readdirSync(join(agentsDir, d))) : [];
    check(leftovers.length === 0, `Playwright MCP's files are swept after each call (${leftovers.join(", ") || "none left"})`);

    // An SVG file opened as a page (2026-10-03): Playwright's snapshot looks for a body until the call's 30 s are up,
    // though the page opened. It gets a stand-in body, the answers come at once and say what the page is.
    const svgUrl = `http://127.0.0.1:${sitePort}/ride.svg`;
    const started = Date.now();
    const svg = await mcp.call("browser_navigate", { url: svgUrl }, 45_000);
    check(!svg.error && Date.now() - started < 10_000, `an SVG file opens for the agent without waiting out a timeout (${Date.now() - started} ms; ${svg.text.split("\n")[0]})`);
    check(svg.text.includes("image/svg+xml document, not HTML"), "the answer says the page is an SVG document and how to look at it");
    const svgSnap = await mcp.call("browser_snapshot", {}, 45_000);
    check(!svgSnap.error && svgSnap.text.includes("image/svg+xml document"), "a snapshot of it answers too, saying the same");
    const svgShot = await mcp.call("browser_take_screenshot", {}, 45_000);
    check(!svgShot.error, `a screenshot of it is taken (${svgShot.text.replace(/\s+/g, " ").slice(0, 80)})`);
    const back = await mcp.call("browser_navigate", { url: siteUrl });
    const htmlSnap = await mcp.call("browser_snapshot");
    check(!back.error && !back.text.includes("not HTML") && !htmlSnap.text.includes("not HTML") && /button "Merge pull request"/.test(htmlSnap.text), "an HTML page after it is read as before");
  } catch (err) {
    check(false, `bridge round trip: ${(err as Error).message}\n${gateErr.slice(-2000)}`);
  } finally {
    gate.stdin.end();
    await new Promise((r) => { gate.once("exit", r); setTimeout(r, 5_000); });
    api.agents.revoke(session.id);
    (listener as ReturnType<typeof listenLocal> | null)?.close();
    site.close();
    await api.agents.shutdown();
    await host.shutdown();
  }
}

let own: { server: Server; port: number; hits: string[] };
let redirect: { server: Server; port: number };

main().then(() => bridgeRoundTrip()).catch((err) => { failures.push(String(err)); console.error(err); }).finally(() => {
  own?.server.close();
  redirect?.server.close();
  rmSync(root, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
  process.exit(failures.length ? 1 : 0);
});
