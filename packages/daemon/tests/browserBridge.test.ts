/** The agent bridge end to end over real HTTP on a random port (docs/browser-v0.md §2 给 agent): the bridge script on
 *  stdio ↔ the local listener (guard, local token check, the session's own token) ↔ an MCP engine. The session token is
 *  the only way in, for its own session, until it is revoked; the local token is not one. */

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { mountBrowser } from "../src/api/browser.js";
import { AGENT_SESSION_HEADER } from "../src/api/browserAgents.js";
import { LocalAuth } from "../src/api/localAuth.js";
import type { ApiDeps } from "../src/api/shared.js";
import type { EngineConnection, EngineOptions, JsonRpcMessage } from "../src/browser/agents.js";
import { bridgeArgs, runBridge } from "../src/browser/bridgeClient.js";
import { sharedBrowser } from "../src/browser/setup.js";
import { listenLocal } from "../src/daemon.js";
import { FakeDriver } from "./fakeBrowser.js";

const CODEX = { kind: "terminal" as const, id: "t1", label: "codex · AgentSwitch" };
const LOCAL_TOKEN = "local-token-of-the-daemon-0123456789abcdefghij";

class EchoEngine implements EngineConnection {
  closed = false;
  constructor(private readonly opts: EngineOptions) {}
  receive(m: JsonRpcMessage): void {
    if (m.id === undefined) return;
    const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } }
      : m.method === "tools/list" ? { tools: [{ name: "browser_snapshot", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: `ran ${(m.params as { name: string }).name}` }] };
    this.opts.send({ jsonrpc: "2.0", id: m.id, result });
  }
  currentTab(): string | null { return null; }
  tabAt(): string | null { return null; }
  async box() { return null; }
  async close(): Promise<void> { this.closed = true; }
}

const closers: (() => Promise<void> | void)[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

async function start(onPort = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-bridge-")));
  const engines: EchoEngine[] = [];
  const api = sharedBrowser({ home: root, userHome: root, driver: new FakeDriver(), ownPorts: () => [], protected: { roots: [], exempt: [] },
    engine: async (opts) => { const e = new EchoEngine(opts); engines.push(e); return e; } });
  const app = new Hono();
  mountBrowser(app, { browser: api, sseHeartbeatMs: 50 } as unknown as ApiDeps);
  const port = await new Promise<number>((resolve) => {
    const server = listenLocal({ app }, onPort, (info: AddressInfo) => resolve(info.port), new LocalAuth(LOCAL_TOKEN));
    let closed = false;
    const close = async () => { if (closed) return; closed = true; await api.agents.shutdown(); (server as { closeAllConnections?: () => void }).closeAllConnections?.(); server.close(); await api.host.shutdown(); };
    closers.push(close);
    stops.push(close);
  });
  return { root, api, engines, url: `http://127.0.0.1:${port}`, port, stop: stops.at(-1)! };
}

async function until(get: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!get()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
}

/** The bridge on in-memory stdio: write lines in, read lines out. */
function bridge(opts: { url: string; session: string; token: string }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  let buffer = "";
  const waiting: ((line: string) => void)[] = [];
  output.on("data", (d: Buffer) => {
    buffer += d.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const w = waiting.shift();
      if (w) w(line); else lines.push(line);
    }
  });
  const errors: string[] = [];
  const done = runBridge(opts, input, output, (l) => errors.push(l));
  const next = (): Promise<JsonRpcMessage> => new Promise((resolve) => {
    const line = lines.shift();
    if (line !== undefined) resolve(JSON.parse(line) as JsonRpcMessage); else waiting.push((l) => resolve(JSON.parse(l) as JsonRpcMessage));
  });
  const send = (m: object) => input.write(`${JSON.stringify(m)}\n`);
  return { input, done, next, send, errors };
}

describe("the bridge's routes", () => {
  it("need the session's own token: not the local token, not another session's, not after revoking", async () => {
    const { api, url } = await start();
    const a = api.agents.mint(CODEX);
    const b = api.agents.mint({ kind: "terminal", id: "t2", label: "claude · x" });
    const get = (headers: Record<string, string>) => fetch(`${url}/browser/agent/mcp`, { headers });
    expect((await get({})).status).toBe(401);
    expect((await get({ authorization: `Bearer ${LOCAL_TOKEN}` })).status).toBe(401);
    expect((await get({ authorization: `Bearer ${LOCAL_TOKEN}`, [AGENT_SESSION_HEADER]: a.id })).status).toBe(401);
    expect((await get({ authorization: `Bearer ${b.token}`, [AGENT_SESSION_HEADER]: a.id })).status).toBe(401);
    const ok = await get({ authorization: `Bearer ${a.token}`, [AGENT_SESSION_HEADER]: a.id });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/event-stream");
    await ok.body!.cancel();
    const post = (conn: string, token: string, session: string) => fetch(`${url}/browser/agent/mcp/${conn}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, [AGENT_SESSION_HEADER]: session }, body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) });
    expect((await post("deadbeef", a.token, a.id)).status).toBe(404);
    expect((await post("deadbeef", b.token, a.id)).status).toBe(401);
    api.agents.revoke(a.id);
    expect((await get({ authorization: `Bearer ${a.token}`, [AGENT_SESSION_HEADER]: a.id })).status).toBe(401);
    // The other routes still need the local token.
    expect((await fetch(`${url}/browser/tabs`, { headers: { authorization: `Bearer ${a.token}`, [AGENT_SESSION_HEADER]: a.id } })).status).toBe(401);
    expect((await fetch(`${url}/browser/tabs`, { headers: { authorization: `Bearer ${LOCAL_TOKEN}` } })).status).toBe(200);
  });
});

describe("the bridge script", () => {
  it("carries MCP both ways in order, and exits 0 when the agent closes it (the connection closes too)", async () => {
    const { api, url, engines } = await start();
    const s = api.agents.mint(CODEX);
    const b = bridge({ url, session: s.id, token: s.token });
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gate", version: "1" } } });
    expect((await b.next()).result).toMatchObject({ serverInfo: { name: "echo" } });
    b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    b.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } });
    expect(await b.next()).toMatchObject({ id: 2, result: { tools: [{ name: "browser_snapshot" }] } });
    expect(await b.next()).toMatchObject({ id: 3, result: { content: [{ text: "ran browser_snapshot" }] } });
    b.input.end();
    expect(await b.done).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(engines[0]!.closed).toBe(true);
  });

  it("exits 1 when the session is revoked (the agent's program ended), and refuses to start with a dead token", async () => {
    const { api, url } = await start();
    const s = api.agents.mint(CODEX);
    const b = bridge({ url, session: s.id, token: s.token });
    b.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await b.next();
    api.agents.revoke(s.id);
    expect(await b.done).toBe(1);
    const again = bridge({ url, session: s.id, token: s.token });
    expect(await again.done).toBe(1);
    expect(again.errors.join("\n")).toContain("401");
  });

  it("connects again when the service restarts, greets the new connection as the agent did, and goes on (terminal-v0 §10)", async () => {
    const first = await start();
    const s = first.api.agents.mint(CODEX);
    const b = bridge({ url: first.url, session: s.id, token: s.token });
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } } });
    expect((await b.next()).id).toBe(1);
    b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // The service stops; a call the agent makes meanwhile is answered at once, with why.
    await first.stop();
    await new Promise((r) => setTimeout(r, 100));
    b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await b.next())).toMatchObject({ id: 2, error: { message: expect.stringMatching(/restarting|did not answer/) } });
    // The next service, on the same port, takes the terminal's session up again with its token.
    const next = await start(first.port);
    next.api.agents.adopt(s.id, s.token, CODEX);
    await until(() => b.errors.some((e) => e.includes("connected to the daemon again")), 8000);
    await until(() => next.engines.length > 0, 4000);
    b.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } });
    // The answer to the bridge's own greeting never reaches the agent: the next line is the call's.
    expect(await b.next()).toMatchObject({ id: 3, result: { content: [{ text: "ran browser_snapshot" }] } });
    b.input.end();
    expect(await b.done).toBe(0);
  });

  it("reads its token from the file, takes the gate's --output-dir and uses nothing of it, and talks only to this Mac", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-bridge-args-")));
    const file = join(dir, "s.token");
    writeFileSync(file, "tok-123\n", { mode: 0o600 });
    expect(bridgeArgs(["--url", "http://127.0.0.1:4711/", "--session", "ab12", "--token-file", file, "--output-dir=/gate/out"], {}))
      .toEqual({ url: "http://127.0.0.1:4711", session: "ab12", token: "tok-123" });
    expect(bridgeArgs(["--url=http://localhost:9", "--output-dir", "/gate/out", "--session=ab12"], { AGENTSWITCH_BROWSER_TOKEN: "env-tok" }).token).toBe("env-tok");
    expect(() => bridgeArgs(["--url", "https://evil.example", "--session", "ab12", "--token-file", file], {})).toThrow("local address");
    expect(() => bridgeArgs(["--url", "http://127.0.0.1:1", "--session", "ab12"], {})).toThrow("no token");
    expect(() => bridgeArgs(["--url", "http://127.0.0.1:1", "--token-file", file], {})).toThrow("--session");
    expect(() => bridgeArgs(["--url", "http://127.0.0.1:1", "--session", "ab", "--token-file", join(dir, "missing")], {})).toThrow("token file");
  });
});
