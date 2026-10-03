/** The shared browser's routes (docs/browser-v0.md §2, app-v0 §2) on a fake Chrome: tabs, refusals in words, input,
 *  navigation, holds and sizes from this Mac and from a paired phone, the audit, the SSE stream's framing, the local
 *  servers, the remote allowlist, and the daemon turning it on. */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mountBrowser, streamOptions } from "../src/api/browser.js";
import type { ApiDeps } from "../src/api/shared.js";
import { sharedBrowser } from "../src/browser/setup.js";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon, defaultConfig, type DaemonConfig } from "../src/daemon.js";
import { defaultProtected } from "../src/executors/protected.js";
import { remoteAllowed } from "../src/remote/routes.js";
import { FakeDriver } from "./fakeBrowser.js";
import { TARGETS_PATH } from "./helpers.js";

let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-browser-api-")));
  mkdirSync(join(root, "user", "site"), { recursive: true });
  writeFileSync(join(root, "user", "site", "index.html"), "<p>hi</p>");
  writeFileSync(join(root, "user", "site", ".env"), "X=1");
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

function setup() {
  const home = mkdtempSync(join(root, "home-"));
  const userHome = join(root, "user");
  const driver = new FakeDriver();
  const lsof = ["p1200", "R1180", "cnode", "n127.0.0.1:5173", "p1201", "R1", "cnode", "n127.0.0.1:4711"].join("\n");
  const api = sharedBrowser({
    home, userHome, driver, ownPorts: () => [4711],
    protected: defaultProtected({ HOME: userHome, AGENTSWITCH_HOME: home, SECRET_GATE_HOME: join(userHome, ".secret-gate") }),
    exec: async (file, args) => (file === "ps" ? " 1200 node /x/node_modules/.bin/vite\n" : args.includes("cwd") ? "p1200\nn/Users/me/site\np1201\nn/Users/me/a\n" : lsof),
  });
  cleanups.push(() => api.host.shutdown());
  const app = new Hono();
  mountBrowser(app, { browser: api, sseHeartbeatMs: 20 } as unknown as ApiDeps);
  const auditLines = (): Record<string, unknown>[] => {
    try { return readFileSync(join(home, "browser", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; }
  };
  const phone = markRemote({}, { deviceId: "dev-phone" });
  const call = (method: string, path: string, body?: unknown, env?: object) =>
    app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }, env);
  return { app, api, driver, call, auditLines, phone, home };
}

describe("tabs", () => {
  it("list, open what is typed, read one, close", async () => {
    const { call, driver, auditLines } = setup();
    expect(await (await call("GET", "/browser/tabs")).json()).toEqual({ running: false, groups: [] });
    const res = await call("POST", "/browser/tabs", { url: "github.com/acme/app?token=abc" });
    expect(res.status).toBe(201);
    const { tab } = await res.json() as { tab: { id: string; url: string; owner: { kind: string } } };
    expect(tab).toMatchObject({ url: "https://github.com/acme/app?token=abc", owner: { kind: "you" } });
    expect(driver.page(0).navigations).toEqual(["https://github.com/acme/app?token=abc"]);
    const list = await (await call("GET", "/browser/tabs")).json() as { running: boolean; groups: { owner: { kind: string }; tabs: { id: string }[] }[] };
    expect(list.running).toBe(true);
    expect(list.groups.map((g) => [g.owner.kind, g.tabs.map((t) => t.id)])).toEqual([["you", [tab.id]]]);
    expect((await (await call("GET", `/browser/tabs/${tab.id}`)).json() as { tab: { id: string } }).tab.id).toBe(tab.id);
    expect((await call("DELETE", `/browser/tabs/${tab.id}`)).status).toBe(200);
    expect((await call("GET", `/browser/tabs/${tab.id}`)).status).toBe(404);
    expect((await call("DELETE", `/browser/tabs/${tab.id}`)).status).toBe(404);
    expect(auditLines().map((l) => [l.action, l.via, l.detail])).toEqual([
      ["open", "local", { kind: "url", target: "https://github.com/acme/app" }],
      ["close", "local", undefined],
    ]);
  });

  it("paths and ports; refusals in words, audited; bad bodies", async () => {
    const { call, auditLines, phone } = setup();
    const ok = await call("POST", "/browser/tabs", { path: "~/site/index.html" }, phone);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { tab: { kind: string; site: string } }).tab).toMatchObject({ kind: "file", site: "~/site/index.html" });
    expect((await call("POST", "/browser/tabs", { port: 5173 })).status).toBe(201);
    const env = await call("POST", "/browser/tabs", { path: "~/site/.env" }, phone);
    expect(env.status).toBe(403);
    expect(((await env.json()) as { error: string }).error).toBe("~/site/.env 属于凭据文件（.env、私钥、证书、令牌配置等），不在浏览器中打开。");
    const own = await call("POST", "/browser/tabs", { port: 4711 });
    expect(own.status).toBe(403);
    expect(((await own.json()) as { error: string }).error).toBe("该端口是 AgentSwitch 自己的服务，不在浏览器中打开。");
    expect((await call("POST", "/browser/tabs", { url: "javascript:alert(1)" })).status).toBe(403);
    expect((await call("POST", "/browser/tabs", { path: "~/site/missing.html" })).status).toBe(404);
    expect((await call("POST", "/browser/tabs", { url: "hello world" })).status).toBe(400);
    expect((await call("POST", "/browser/tabs", { url: "a.com", port: 80 })).status).toBe(400);
    expect((await call("POST", "/browser/tabs", {})).status).toBe(400);
    const lines = auditLines();
    expect(lines[0]).toMatchObject({ action: "open", via: "dev-phone", detail: { kind: "path", target: join(root, "user", "site", "index.html") } });
    expect(lines[1]).toMatchObject({ action: "open", via: "local", detail: { kind: "port", target: 5173 } });
    expect(lines.filter((l) => l.action === "refused").map((l) => [l.via, (l.detail as { kind: string }).kind])).toEqual([["dev-phone", "path"], ["local", "port"], ["local", "url"]]);
  });
});

describe("driving a tab", () => {
  it("input: one event or a batch; bad events are refused before anything is sent", async () => {
    const { call, driver } = setup();
    const { tab } = await (await call("POST", "/browser/tabs", { url: "https://a.example/" })).json() as { tab: { id: string } };
    expect((await call("POST", `/browser/tabs/${tab.id}/input`, { type: "text", text: "hi", screen: "mac-1" })).status).toBe(200);
    expect((await call("POST", `/browser/tabs/${tab.id}/input`, { events: [{ type: "key", key: "Enter" }, { type: "mouse", action: "click", x: 10, y: 20 }, { type: "wheel", x: 1, y: 1, deltaY: 30 }] })).status).toBe(200);
    const sent = driver.page(0).inputs.map((c) => c.method === "Input.insertText" ? "text" : c.params.type);
    expect(sent).toEqual(["text", "keyDown", "keyUp", "mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]);
    for (const bad of [{ type: "key", key: "F13" }, { type: "mouse", action: "click", x: "1", y: 2 }, { events: [] }, { type: "text", text: "" }, { type: "scroll" }, { type: "text", text: "x", screen: "a b" }]) {
      expect((await call("POST", `/browser/tabs/${tab.id}/input`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(driver.page(0).inputs).toHaveLength(7);
    expect((await call("POST", "/browser/tabs/nope/input", { type: "text", text: "x" })).status).toBe(404);
  });

  it("navigate: URL, path, history; a file refused; one of them only", async () => {
    const { call, driver, auditLines } = setup();
    const { tab } = await (await call("POST", "/browser/tabs", { url: "https://a.example/" })).json() as { tab: { id: string } };
    expect((await call("POST", `/browser/tabs/${tab.id}/navigate`, { url: "localhost:3000" })).status).toBe(200);
    expect((await call("POST", `/browser/tabs/${tab.id}/navigate`, { action: "reload" })).status).toBe(200);
    expect((await call("POST", `/browser/tabs/${tab.id}/navigate`, { path: "~/site/.env" })).status).toBe(403);
    expect((await call("POST", `/browser/tabs/${tab.id}/navigate`, { url: "a.com", action: "back" })).status).toBe(400);
    expect((await call("POST", "/browser/tabs/nope/navigate", { action: "back" })).status).toBe(404);
    expect(driver.page(0).navigations).toEqual(["https://a.example/", "http://localhost:3000/"]);
    expect(driver.page(0).histories).toEqual(["reload"]);
    expect(auditLines().map((l) => l.action)).toEqual(["open", "navigate", "refused"]);
  });

  it("take, size and hand back: from the phone as its device, from the Mac as its screen; audited", async () => {
    const { call, api, phone, auditLines } = setup();
    const { tab } = await (await call("POST", "/browser/tabs", { url: "https://a.example/" })).json() as { tab: { id: string } };
    expect((await call("POST", `/browser/tabs/${tab.id}/viewport`, { width: 390, height: 844, scale: 3, mobile: true }, phone)).status).toBe(409);
    const took = await (await call("POST", `/browser/tabs/${tab.id}/take`, {}, phone)).json() as { tab: { heldBy: string } };
    expect(took.tab.heldBy).toBe("dev-phone");
    const sized = await call("POST", `/browser/tabs/${tab.id}/viewport`, { width: 390, height: 844, scale: 3, mobile: true }, phone);
    expect(((await sized.json()) as { tab: { viewport: unknown } }).tab.viewport).toEqual({ width: 390, height: 844, scale: 3, mobile: true, by: "dev-phone" });
    expect((await call("POST", `/browser/tabs/${tab.id}/viewport`, { width: 100, height: 844 }, phone)).status).toBe(400);
    expect((await call("POST", `/browser/tabs/${tab.id}/input`, { type: "text", text: "x", screen: "mac-1" })).status).toBe(409);
    expect((await call("POST", `/browser/tabs/${tab.id}/release`, { screen: "mac-1" })).status).toBe(409);
    expect((await call("POST", `/browser/tabs/${tab.id}/take`, { screen: "mac-1" })).status).toBe(200);
    expect((await call("POST", `/browser/tabs/${tab.id}/release`, { screen: "mac-1" })).status).toBe(200);
    expect((await call("POST", `/browser/tabs/${tab.id}/release`, { screen: "mac-1" })).status).toBe(200);   // held by nobody
    expect(api.host.get(tab.id)!.heldBy).toBeNull();
    expect(auditLines().slice(1).map((l) => [l.action, l.via, l.detail])).toEqual([
      ["take", "dev-phone", { screen: "dev-phone", from: null, owner: "you" }],
      ["take", "local", { screen: "mac-1", from: "dev-phone", owner: "you" }],
      ["release", "local", { screen: "mac-1", reason: "hand-back" }],
    ]);
    expect((await call("POST", "/browser/tabs/nope/take", {})).status).toBe(404);
  });
});

/** The SSE events of a stream so far, read until `until` is satisfied. */
async function readEvents(res: Response, until: (events: { event: string; data: Record<string, unknown>; id?: string }[]) => boolean) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const events: { event: string; data: Record<string, unknown>; id?: string }[] = [];
  const end = Date.now() + 5_000;
  while (!until(events) && Date.now() < end) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const blocks = text.split("\n\n");
    text = blocks.pop()!;
    for (const block of blocks) {
      if (block.startsWith(":")) { events.push({ event: "comment", data: {} }); continue; }
      const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
      const id = field("id");
      events.push({ event: field("event")!, data: JSON.parse(field("data")!) as Record<string, unknown>, ...(id ? { id } : {}) });
    }
  }
  return { events, reader };
}

describe("the stream", () => {
  it("the tab, frames as JPEG with their geometry, changes, a heartbeat, and `closed` at the end", async () => {
    const { call, driver } = setup();
    const { tab } = await (await call("POST", "/browser/tabs", { url: "https://a.example/" })).json() as { tab: { id: string } };
    const res = await call("GET", `/browser/tabs/${tab.id}/stream?quality=40&fps=5&maxWidth=800`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const page = driver.page(0);
    setTimeout(() => {
      page.frame(800, 500, 1280, 800, 3);
      page.change("https://a.example/next", "Next");
    }, 30);
    setTimeout(() => { void call("DELETE", `/browser/tabs/${tab.id}`); }, 120);
    const { events } = await readEvents(res, (evs) => evs.some((e) => e.event === "closed"));
    const named = events.filter((e) => e.event !== "comment");
    expect(named[0]).toMatchObject({ event: "tab", data: { type: "tab", tab: { id: tab.id } } });
    const frame = named.find((e) => e.event === "frame")!;
    expect(frame.id).toBe("1");
    expect(frame.data).toMatchObject({ type: "frame", seq: 1, format: "jpeg", width: 800, height: 500, scale: 0.625, viewport: { width: 1280, height: 800 } });
    expect(Buffer.from(frame.data.data as string, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(named.map((e) => e.event)).toEqual(["tab", "frame", "url", "title", "closed"]);
    expect(events.some((e) => e.event === "comment")).toBe(true);
    expect(page.screencasts[0]).toEqual({ quality: 40, maxWidth: 800 });
    expect(page.acks).toEqual([3]);
  });

  it("a stream that goes away stops the screencast; an unknown tab is 404", async () => {
    const { call, driver } = setup();
    const { tab } = await (await call("POST", "/browser/tabs", { url: "https://a.example/" })).json() as { tab: { id: string } };
    const res = await call("GET", `/browser/tabs/${tab.id}/stream`);
    const { reader } = await readEvents(res, (evs) => evs.length > 0);
    await reader.cancel();
    const page = driver.page(0);
    for (let i = 0; i < 100 && page.stops === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(page.screencasts).toEqual([{ quality: 70 }]);
    expect(page.stops).toBe(1);
    expect((await call("GET", "/browser/tabs/nope/stream")).status).toBe(404);
  });

  it("stream options: defaults, bounds, garbage", () => {
    const q = (o: Record<string, string>) => streamOptions((n) => o[n]);
    expect(q({})).toEqual({ quality: 70, fps: 15 });
    expect(q({ quality: "500", fps: "0", maxWidth: "50", maxHeight: "9000" })).toEqual({ quality: 100, fps: 1, maxWidth: 100, maxHeight: 8192 });
    expect(q({ quality: "x", fps: "-3" })).toEqual({ quality: 70, fps: 15 });
  });
});

describe("local servers", () => {
  it("the user's, without AgentSwitch's own port", async () => {
    const { call } = setup();
    expect(await (await call("GET", "/browser/servers")).json()).toEqual({ servers: [{ port: 5173, bind: "loopback", pid: 1200, name: "vite", cwd: "/Users/me/site", url: "http://localhost:5173/" }] });
  });

  it("a failing lsof is a 503 in words", async () => {
    const app = new Hono();
    const api = sharedBrowser({ home: mkdtempSync(join(root, "home-")), userHome: join(root, "user"), driver: new FakeDriver(), ownPorts: () => [], protected: { roots: [], exempt: [] }, exec: async () => { throw new Error("lsof: not found"); } });
    mountBrowser(app, { browser: api } as unknown as ApiDeps);
    const res = await app.request("/browser/servers");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "无法读取本地服务列表。" });
  });
});

describe("wiring", () => {
  it("every people's route is on the remote allowlist, fill too; the agent bridge's never", () => {
    for (const [m, p] of [["GET", "/browser/tabs"], ["POST", "/browser/tabs"], ["GET", "/browser/tabs/ab12cd34"], ["DELETE", "/browser/tabs/ab12cd34"], ["GET", "/browser/tabs/ab12cd34/stream"],
      ["POST", "/browser/tabs/ab12cd34/input"], ["POST", "/browser/tabs/ab12cd34/navigate"], ["POST", "/browser/tabs/ab12cd34/take"], ["POST", "/browser/tabs/ab12cd34/release"],
      ["POST", "/browser/tabs/ab12cd34/viewport"], ["POST", "/browser/tabs/ab12cd34/fill"], ["GET", "/browser/servers"]] as const) expect(remoteAllowed(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of [["GET", "/browser/agent/mcp"], ["POST", "/browser/agent/mcp/ab12cd34"], ["PUT", "/browser/tabs/ab12cd34"], ["GET", "/browser/tabs/a/b/stream"], ["POST", "/browser/servers"]] as const) expect(remoteAllowed(m, p), `${m} ${p}`).toBe(false);
  });

  it("the daemon has the browser unless AGENTSWITCH_BROWSER_HOST=0; tests turn it on with a fake", async () => {
    expect(defaultConfig({ HOME: root }).browserHost).toBe(true);
    expect(defaultConfig({ HOME: root, AGENTSWITCH_BROWSER_HOST: "0" }).browserHost).toBe(false);
    const cfg = (): DaemonConfig => ({ home: mkdtempSync(join(root, "daemon-")), targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" });
    const off = buildDaemon(cfg());
    expect(off.browser).toBeNull();
    expect((await off.api.request("/browser/tabs")).status).toBe(404);
    off.close();
    const driver = new FakeDriver();
    const on = buildDaemon(cfg(), { browserDriver: driver });
    expect(on.browser).not.toBeNull();
    expect(await (await on.api.request("/browser/tabs")).json()).toEqual({ running: false, groups: [] });
    const opened = await on.api.request("/browser/tabs", { method: "POST", body: JSON.stringify({ url: "https://a.example/" }), headers: { "content-type": "application/json" } });
    expect(opened.status).toBe(201);
    expect(driver.launches[0]!.profileDir).toMatch(/browser-profiles\/main$/);
    await on.stopBrowser();
    expect(driver.browser.closed).toBe(true);
    on.close();
  });
});
