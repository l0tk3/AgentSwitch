/** The 127.0.0.1 listener's token (2026-09-25): every local caller shows it, the web console gets a session through a
 *  one-time link, and executors cannot read the file that holds it. Over real HTTP on a random port. */

import { mkdtempSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLocalToken, LOCAL_TOKEN_FILE, LocalAuth, readLocalToken } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { decideTool } from "../src/executors/claude.js";
import { defaultProtected } from "../src/executors/protected.js";
import { TARGETS_PATH } from "./helpers.js";

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

async function start(now?: () => number) {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-localauth-"));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  const daemon = buildDaemon(cfg);
  const token = ensureLocalToken(home);
  const port = await new Promise<number>((resolve) => {
    const server = listenLocal(daemon, 0, (info: AddressInfo) => resolve(info.port), new LocalAuth(token, now));
    closers.push(() => { server.close(); daemon.close(); });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init });
  return { home, token, call };
}

describe("local API token", () => {
  it("the token file is made once, private, and read back the same", () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-localauth-"));
    const token = ensureLocalToken(home);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(statSync(join(home, LOCAL_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    expect(ensureLocalToken(home)).toBe(token);
    expect(readLocalToken(home)).toBe(token);
  });

  it("without it the API is closed; the liveness probe and the console's pages are not", async () => {
    const f = await start();
    for (const path of ["/tasks", "/approvals/policy", "/devices", "/settings/models"]) expect((await f.call(path)).status, path).toBe(401);
    expect((await f.call("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "x" }) })).status).toBe(401);
    expect((await f.call("/tasks", { headers: { authorization: "Bearer wrong-token-of-some-length-1234567890" } })).status).toBe(401);
    expect((await f.call("/healthz")).status).toBe(200);
    expect((await f.call("/ui")).status).toBe(200);
  });

  it("with it the API answers", async () => {
    const f = await start();
    const res = await f.call("/tasks", { headers: { authorization: `Bearer ${f.token}` } });
    expect(res.status).toBe(200);
  });

  it("the web console: a one-time link from the token holder becomes a session cookie; the link works once", async () => {
    const f = await start();
    expect((await f.call("/local/console-link", { method: "POST" })).status).toBe(401);
    const link = await (await f.call("/local/console-link", { method: "POST", headers: { authorization: `Bearer ${f.token}` } })).json() as { path: string };
    expect(link.path).toMatch(/^\/ui\/login\?code=[A-Za-z0-9_-]+$/);
    expect(link.path).not.toContain(f.token);
    const login = await f.call(link.path);
    expect(login.status).toBe(302);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const session = cookie.split(";")[0]!;
    expect((await f.call("/tasks", { headers: { cookie: session } })).status).toBe(200);
    expect((await f.call(link.path)).status).toBe(403);
    expect((await f.call("/tasks", { headers: { cookie: "agentswitch_console=made-up" } })).status).toBe(401);
  });

  it("a console link can land on another console page (the Mac app's terminal window), never off the console", async () => {
    const f = await start();
    const link = async (next: string) => (await (await f.call(`/local/console-link?next=${encodeURIComponent(next)}`, { method: "POST", headers: { authorization: `Bearer ${f.token}` } })).json() as { path: string }).path;
    const terminal = await link("/ui/terminal.html");
    expect(terminal).toMatch(/^\/ui\/login\?code=[A-Za-z0-9_-]+&next=%2Fui%2Fterminal\.html$/);
    expect((await f.call(terminal)).headers.get("location")).toBe("/ui/terminal.html");
    // One task or terminal to open there (the Live Activity card), nothing else in the query.
    expect((await f.call(await link("/ui/terminal.html?id=ab12cd"))).headers.get("location")).toBe("/ui/terminal.html?id=ab12cd");
    expect((await f.call(await link("/ui?task=0f9e8d7c-1234"))).headers.get("location")).toBe("/ui?task=0f9e8d7c-1234");
    for (const bad of ["https://evil.example/ui", "//evil.example", "/ui/../tasks", "/tasks", "/ui?task=a&next=//evil.example", "/ui?other=1", "/ui?task=a/b"]) {
      const path = await link(bad);
      expect(path).not.toContain("next=");
      expect((await f.call(`${path}&next=${encodeURIComponent(bad)}`)).headers.get("location")).toBe("/ui");
    }
  });

  it("a console link runs out after a minute", async () => {
    let now = 1_000_000;
    const f = await start(() => now);
    const link = await (await f.call("/local/console-link", { method: "POST", headers: { authorization: `Bearer ${f.token}` } })).json() as { path: string };
    now += 61_000;
    expect((await f.call(link.path)).status).toBe(403);
  });

  it("executors may not read the token file", () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-localauth-"));
    const prot = defaultProtected({ HOME: tmpdir(), AGENTSWITCH_HOME: home, SECRET_GATE_HOME: join(home, "gate") });
    expect(decideTool("Read", { file_path: join(home, LOCAL_TOKEN_FILE) }, tmpdir(), new Set(), prot)).toMatchObject({ kind: "deny" });
  });
});
