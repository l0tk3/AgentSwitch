/** The agent bridge in the daemon (docs/browser-v0.md §2 给 agent, §5 step 3) on a fake Chrome and a fake MCP engine:
 *  session tokens (minted, checked, revoked), the private folder (workspace root, swept after every call), one call at
 *  a time, a held tab's calls waiting and timing out, the tab's status and the overlay's action and box, the tabs at
 *  the CSS size for a call that points at the page or takes its picture, the bridge's own refusals, `browser_close`,
 *  and what the overlay never shows (the typed text). */

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserAgents, bridgeCommand, describeCall, FILES_REFUSED, HELD_LOGS_REFUSED, RESIZE_REFUSED, terminalOwner, USER_HOLDS_TAB, type AgentConnection, type EngineConnection, type EngineOptions, type JsonRpcMessage, directTools, withoutFileLinks } from "../src/browser/agents.js";
import { BrowserAudit } from "../src/browser/audit.js";
import { BrowserHost } from "../src/browser/host.js";
import { YOU, type TabOwner } from "../src/browser/types.js";
import { FakeDriver } from "./fakeBrowser.js";

const CODEX: TabOwner = { kind: "terminal", id: "t1", label: "codex · AgentSwitch" };
const CLAUDE: TabOwner = { kind: "terminal", id: "t2", label: "claude · site" };
/** One of the gate's own checks as it sends them (a field's state; the templates are in browserProbes.test.ts). */
const GATE_PROBE = "async (page) => { const locate = (t) => page.locator(/^(?:f\\d+)?e\\d+$/.test(t) ? 'aria-ref=' + t : t); const field = locate(\"e12\"); "
  + "try { if (await field.count() !== 1) return 'unknown'; const value = await field.inputValue({ timeout: 2000 }); return value.length ? 'nonempty' : 'empty'; } catch { return 'unknown'; } }";

/** Playwright MCP as far as the bridge can tell: answers, a current tab it opens through the host on first use, files
 *  written into its output folder, and a call the test can hold open. */
class FakeConnection implements EngineConnection {
  readonly received: JsonRpcMessage[] = [];
  readonly tabs: string[] = [];
  current: string | null = null;
  closed = false;
  /** While set, calls wait for it before answering. */
  gate: Promise<void> | null = null;
  private readonly answers = new Map<string | number, (m: JsonRpcMessage) => void>();

  constructor(readonly opts: EngineOptions, private readonly host: BrowserHost) {}

  receive(m: JsonRpcMessage): void {
    this.received.push(m);
    if (m.method === "initialize") { this.opts.send({ jsonrpc: "2.0", id: m.id!, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }); return; }
    if (m.method === "tools/list") { this.opts.send({ jsonrpc: "2.0", id: m.id!, result: { tools: [] } }); return; }
    if (m.method === "tools/call") { void this.call(m); return; }
    if (m.method === undefined && m.id !== undefined) this.answers.get(m.id)?.(m);
  }

  private async call(m: JsonRpcMessage): Promise<void> {
    const { name } = m.params as { name: string };
    if (!this.current) {
      const tab = await this.host.open(this.opts.owner, "about:blank");
      this.current = tab.id;
      this.tabs.push(tab.id);
    }
    writeFileSync(join(this.opts.outputDir, `page-${this.received.length}.yml`), "- button \"Merge\" [ref=e12]");
    if (this.gate) await this.gate;
    this.opts.send({ jsonrpc: "2.0", id: m.id!, result: { content: [{ type: "text", text: `did ${name}` }] } });
  }

  /** Playwright MCP asks the client for its roots. */
  roots(): Promise<JsonRpcMessage> {
    return new Promise((resolve) => { this.answers.set("roots-1", resolve); this.opts.send({ jsonrpc: "2.0", id: "roots-1", method: "roots/list" }); });
  }

  calls(): string[] { return this.received.filter((m) => m.method === "tools/call").map((m) => (m.params as { name: string }).name); }
  currentTab(): string | null { return this.current; }
  tabAt(index: number): string | null { return this.tabs[index] ?? null; }
  /** While set, finding an element's box waits for it (a screen may take the tab meanwhile). */
  boxGate: Promise<void> | null = null;
  async box(target: string) {
    if (this.boxGate) await this.boxGate;
    return target === "e12" ? { x: 10, y: 20, width: 100, height: 30 } : null;
  }
  /** What `settle` answers: the tabs whose logs could not be kept clear of a hold. */
  exposed: string[] = [];
  settles = 0;
  async settle(): Promise<readonly string[]> { this.settles += 1; return this.exposed; }
  /** The content type of the current tab's document when it has no body of its own (an SVG file). */
  plain: string | null = null;
  async bodiless(): Promise<string | null> { return this.plain; }
  async close(): Promise<void> { this.closed = true; }
}

const hosts: BrowserHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.shutdown(); });

function setup(holdWaitMs = 5_000, agentQuietMs = 2_000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-agents-")));
  const driver = new FakeDriver();
  const host = new BrowserHost({ driver, profileDir: join(root, "profile"), files: { protected: { roots: [], exempt: [] }, home: root }, ownPorts: () => [4711], log: () => undefined, mac: true, agentQuietMs });
  hosts.push(host);
  const audit = new BrowserAudit(join(root, "browser", "audit.jsonl"));
  const engines: FakeConnection[] = [];
  const agents = new BrowserAgents({ host, audit, dir: join(root, "browser"), holdWaitMs, log: () => undefined,
    engine: async (opts) => { const c = new FakeConnection(opts, host); engines.push(c); return c; } });
  const auditLines = (): Record<string, unknown>[] => {
    try { return readFileSync(join(root, "browser", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; }
  };
  return { root, driver, host, agents, engines, auditLines };
}

/** A connection with what it sent the agent, and a way to ask and wait for the answer. */
async function connect(agents: BrowserAgents, session: { id: string; token: string }) {
  const out: JsonRpcMessage[] = [];
  let ended = 0;
  const waiting = new Map<string | number, (m: JsonRpcMessage) => void>();
  const conn: AgentConnection = await agents.connect(session.id, session.token, (m) => {
    out.push(m);
    if (m.id !== undefined && m.method === undefined) waiting.get(m.id)?.(m);
  }, () => { ended += 1; });
  let next = 0;
  const ask = (method: string, params: unknown = {}): Promise<JsonRpcMessage> => {
    const id = ++next;
    return new Promise((resolve) => { waiting.set(id, resolve); conn.receive({ jsonrpc: "2.0", id, method, params }); });
  };
  const call = (name: string, args: Record<string, unknown> = {}) => ask("tools/call", { name, arguments: args });
  return { conn, out, ask, call, ended: () => ended };
}

const text = (m: JsonRpcMessage): string => ((m.result as { content: { text: string }[] }).content.map((c) => c.text).join("\n"));
const isError = (m: JsonRpcMessage): boolean => (m.result as { isError?: boolean }).isError === true;
const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitUntil(ok: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("sessions", () => {
  it("a token is minted per session into a private file, checked against its own session only, and revoked with it", async () => {
    const { agents, root } = setup();
    const a = agents.mint(CODEX);
    const b = agents.mint(CLAUDE);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenFile).toBe(join(root, "browser", "sessions", `${a.id}.token`));
    expect(readFileSync(a.tokenFile, "utf8").trim()).toBe(a.token);
    expect(statSync(a.tokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "browser", "sessions")).mode & 0o777).toBe(0o700);
    expect(agents.verify(a.id, a.token)).toBe(true);
    expect(agents.verify(a.id, b.token)).toBe(false);
    expect(agents.verify(b.id, a.token)).toBe(false);
    expect(agents.verify(a.id, "")).toBe(false);
    expect(agents.verify("nope", a.token)).toBe(false);
    expect(agents.ownerOf(a.id)).toEqual(CODEX);
    await expect(agents.connect(a.id, b.token, () => undefined)).rejects.toMatchObject({ code: "forbidden" });
    agents.revoke(a.id);
    expect(agents.verify(a.id, a.token)).toBe(false);
    expect(existsSync(a.tokenFile)).toBe(false);
    await expect(agents.connect(a.id, a.token, () => undefined)).rejects.toMatchObject({ code: "forbidden" });
    expect(agents.verify(b.id, b.token)).toBe(true);
  });

  it("revoking a session ends its live connections, closes their engines and removes their folders", async () => {
    const { agents, engines } = setup();
    const s = agents.mint(CODEX);
    const c = await connect(agents, s);
    const dir = engines[0]!.opts.outputDir;
    expect(existsSync(dir)).toBe(true);
    expect(agents.connection(s.id, s.token, c.conn.id)).not.toBeNull();
    agents.revoke(s.id);
    await tick();
    expect(c.ended()).toBe(1);
    expect(engines[0]!.closed).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(agents.connection(s.id, s.token, c.conn.id)).toBeNull();
  });

  it("an earlier run's tokens and files are gone when the daemon starts", () => {
    const { root, agents } = setup();
    const s = agents.mint(CODEX);
    const again = new BrowserAgents({ host: hosts[0]!, dir: join(root, "browser"), engine: async () => { throw new Error("unused"); } });
    expect(existsSync(s.tokenFile)).toBe(false);
    expect(again.verify(s.id, s.token)).toBe(false);
  });

  it("an agent's end revokes only its own sessions; its tabs go idle, or close when its terminal is deleted", async () => {
    const { agents, host } = setup();
    const a = agents.mint(CODEX);
    const b = agents.mint(CLAUDE);
    const tab = await host.open(CODEX, "https://a.example/");
    const other = await host.open(CLAUDE, "https://b.example/");
    host.setStatus(tab.id, "busy");
    agents.end({ kind: "terminal", id: "t1" });
    expect(agents.verify(a.id, a.token)).toBe(false);
    expect(agents.verify(b.id, b.token)).toBe(true);
    expect(host.get(tab.id)!.status).toBe("idle");
    agents.end({ kind: "terminal", id: "t1" }, true);
    await tick();
    expect(host.get(tab.id)).toBeNull();
    expect(host.get(other.id)).not.toBeNull();
  });

  it("names a terminal's tabs as the screens list them and runs the bridge with the token's file, never the token", () => {
    expect(terminalOwner("t9", "codex", "/Users/me/Projects/AgentSwitch")).toEqual({ kind: "terminal", id: "t9", label: "codex · AgentSwitch" });
    expect(terminalOwner("t9", "claude-code", "/x/site").label).toBe("claude · site");
    const { agents } = setup();
    const s = agents.mint(CODEX);
    const argv = bridgeCommand(s, "http://127.0.0.1:4711", "/n/node", "/b/bridge.js");
    expect(argv).toEqual(["/n/node", "/b/bridge.js", "--url", "http://127.0.0.1:4711", "--session", s.id, "--token-file", s.tokenFile]);
    expect(argv.join(" ")).not.toContain(s.token);
  });
});

describe("the MCP connection", () => {
  it("declares the roots capability and answers roots/list with its private folder, swept after every call", async () => {
    const { agents, engines, root } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    await c.ask("initialize", { protocolVersion: "2025-06-18", capabilities: { sampling: {} }, clientInfo: { name: "secret-gate-browser", version: "1" } });
    const engine = engines[0]!;
    expect((engine.received[0]!.params as { capabilities: object }).capabilities).toEqual({ sampling: {}, roots: {} });
    const dir = engine.opts.outputDir;
    expect(dir.startsWith(join(root, "browser", "agents"))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const roots = await engine.roots();
    expect(roots.result).toEqual({ roots: [{ uri: pathToFileURL(dir).href, name: "agentswitch-browser" }] });
    expect(c.out.some((m) => m.method === "roots/list")).toBe(false);   // never reaches the agent
    await c.call("browser_snapshot");
    expect(readdirSync(dir)).toEqual([]);
    await c.conn.close();
    expect(existsSync(dir)).toBe(false);
    expect(engine.closed).toBe(true);
  });

  it("the first page opens as the agent's own tab; the answer says where; the navigation is audited without its query", async () => {
    const { agents, host, auditLines } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    const answer = await c.call("browser_navigate", { url: "https://github.com/acme/app/pull/128?token=abc" });
    expect(text(answer)).toContain("did browser_navigate");
    expect(text(answer)).toContain('Opened in tab "codex · AgentSwitch" of AgentSwitch\'s shared browser');
    const [group] = host.groups();
    expect(group!.owner).toEqual(CODEX);
    const tab = group!.tabs[0]!;
    expect(tab.action).toMatchObject({ tool: "browser_navigate", description: "open github.com" });
    expect(tab.status).toBe("idle");
    expect(text(await c.call("browser_snapshot"))).not.toContain("Opened in tab");
    expect(auditLines().map((l) => [l.action, l.via, l.detail])).toEqual([
      ["open", "agent", { owner: "terminal:t1" }],
      ["navigate", "agent", { owner: "terminal:t1", target: "https://github.com/acme/app/pull/128" }],
    ]);
  });

  it("a page that is not HTML (an SVG file) is said to be one where the answer is its snapshot (2026-10-03)", async () => {
    const { agents, engines } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    expect(text(await c.call("browser_navigate", { url: "https://example.com/" }))).not.toContain("not HTML");
    engines[0]!.plain = "image/svg+xml";
    const opened = text(await c.call("browser_navigate", { url: "http://127.0.0.1:5173/ride.svg" }));
    expect(opened).toContain("did browser_navigate");
    expect(opened).toContain("This page is a image/svg+xml document, not HTML: there is nothing to snapshot.");
    expect(opened).toContain("browser_take_screenshot");
    expect(text(await c.call("browser_snapshot"))).toContain("not HTML");
    expect(text(await c.call("browser_take_screenshot"))).not.toContain("not HTML");
    expect(text(await c.call("browser_click", { target: "e12", element: "Merge" }))).not.toContain("not HTML");
  });

  it("a call runs with the tab busy and the overlay showing what and where; idle after", async () => {
    const { agents, host, engines } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    await c.call("browser_navigate", { url: "https://github.com/" });
    const tab = engines[0]!.current!;
    let release: () => void = () => undefined;
    engines[0]!.gate = new Promise((r) => { release = r; });
    const clicking = c.call("browser_click", { target: "e12", element: "Merge pull request" });
    await tick(); await tick();
    expect(host.get(tab)!.status).toBe("busy");
    expect(host.get(tab)!.action).toMatchObject({ tool: "browser_click", description: 'click "Merge pull request"', box: { x: 10, y: 20, width: 100, height: 30 } });
    release();
    await clicking;
    expect(host.get(tab)!.status).toBe("idle");
    // A gate probe leaves the overlay as it was.
    engines[0]!.gate = null;
    await c.call("browser_evaluate", { function: "() => location.href" });
    expect(host.get(tab)!.action!.tool).toBe("browser_click");
  });

  it("a call that may point at the page runs on the CSS size of a tab a screen shows at 2, drawn at 2 again a moment after; reading it does not redraw", async () => {
    const { agents, host, engines, driver } = setup(5_000, 40);
    const c = await connect(agents, agents.mint(CODEX));
    await c.call("browser_navigate", { url: "https://github.com/" });
    const tab = engines[0]!.current!;
    const page = driver.page(0);
    host.subscribe(tab, { quality: 80, fps: 15, scale: 2 }, () => undefined);
    await waitUntil(() => page.renders.at(-1) === 2);
    let release: () => void = () => undefined;
    engines[0]!.gate = new Promise((r) => { release = r; });
    const clicking = c.call("browser_click", { target: "e12", element: "Merge pull request" });
    await waitUntil(() => engines[0]!.calls().includes("browser_click"));
    expect(page.renders.at(-1)).toBe(1);   // Playwright's click lands where it aims
    release();
    await clicking;
    expect(page.renders.at(-1)).toBe(1);
    await waitUntil(() => page.renders.at(-1) === 2);
    engines[0]!.gate = null;
    const asks = page.renders.length;
    await c.call("browser_snapshot");
    await c.call("browser_evaluate", { function: "() => location.href" });
    await c.call("browser_wait_for", { time: 0 });
    await c.call("browser_tabs", { action: "list" });
    await new Promise((r) => setTimeout(r, 60));
    expect(page.renders).toHaveLength(asks);
  });

  // Review, 2026-10-03, Chrome 154: Playwright's screenshot of a tab whose view was drawn at 2 laid the page out at
  // the view's 2560×1600 (a resize for the page, and what is anchored to its far edges not in the picture), and left
  // it so, the screens showing it at half size. Through the gate a screenshot is its masked one, which comes as
  // `browser_run_code_unsafe`.
  it("a picture of the page is taken on the CSS size too: Playwright's screenshot, and the gate's own code, its masked screenshot among it", async () => {
    const { agents, host, engines, driver } = setup(5_000, 40);
    const c = await connect(agents, agents.mint(CODEX, { gate: true }));
    await c.call("browser_navigate", { url: "https://github.com/" });
    const page = driver.page(0);
    host.subscribe(engines[0]!.current!, { quality: 80, fps: 15, scale: 2 }, () => undefined);
    for (const [tool, args] of [["browser_take_screenshot", {}], ["browser_run_code_unsafe", { code: GATE_PROBE }]] as const) {
      await waitUntil(() => page.renders.at(-1) === 2);
      let release: () => void = () => undefined;
      engines[0]!.gate = new Promise((r) => { release = r; });
      const calling = c.call(tool, args);
      await waitUntil(() => engines[0]!.calls().includes(tool));
      expect(page.renders.at(-1), tool).toBe(1);
      release();
      expect(isError(await calling), tool).toBe(false);
    }
    await waitUntil(() => page.renders.at(-1) === 2);
  });

  // The same review: Chrome sets the view of a tab that comes to the front of its window to the window's size, and a
  // still page sends no frame to say so (host.ts `strayed`). Playwright MCP's `browser_tabs` select brings a tab to
  // the front.
  it("a tab the agent selects is drawn again where a screen watches it", async () => {
    const { agents, host, engines, driver } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    await c.call("browser_navigate", { url: "https://github.com/" });
    const page = driver.page(0);
    const unwatched = page.renders.length;
    await c.call("browser_tabs", { action: "select", index: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(page.renders).toHaveLength(unwatched);   // nobody watches: its first frame will say
    host.subscribe(engines[0]!.current!, { quality: 80, fps: 15, scale: 2 }, () => undefined);
    await waitUntil(() => page.renders.at(-1) === 2);
    const drawn = page.renders.length;
    await c.call("browser_tabs", { action: "select", index: 0 });
    await waitUntil(() => page.renders.length === drawn + 1);
    expect(page.renders.at(-1)).toBe(2);
    await c.call("browser_tabs", { action: "list" });
    await new Promise((r) => setTimeout(r, 30));
    expect(page.renders).toHaveLength(drawn + 1);
  });

  it("calls of one session run one at a time, in the order they came", async () => {
    const { agents, engines } = setup();
    const s = agents.mint(CODEX);
    const a = await connect(agents, s);
    const b = await connect(agents, s);
    await a.call("browser_navigate", { url: "https://a.example/" });
    let release: () => void = () => undefined;
    engines[0]!.gate = new Promise((r) => { release = r; });
    const first = a.call("browser_snapshot");
    const second = b.call("browser_click", { target: "e1" });
    await tick(); await tick();
    expect(engines[1]!.calls()).toEqual([]);   // waits for the first, though on another connection
    release();
    await first;
    await second;
    expect(engines[1]!.calls()).toEqual(["browser_click"]);
  });
});

describe("a tab a person holds", () => {
  it("waits for the hand-back, then runs the queued calls in order", async () => {
    const { agents, host, engines } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    await c.call("browser_navigate", { url: "https://github.com/" });
    const tab = engines[0]!.current!;
    host.take(tab, "phone-1");
    const click = c.call("browser_click", { target: "e12", element: "Merge" });
    const snap = c.call("browser_snapshot");
    await new Promise((r) => setTimeout(r, 30));
    expect(engines[0]!.calls()).toEqual(["browser_navigate"]);
    expect(host.get(tab)!.status).toBe("idle");
    host.take(tab, "mac-1");   // another screen takes it: still held
    await tick();
    expect(engines[0]!.calls()).toEqual(["browser_navigate"]);
    host.release(tab, "mac-1");
    expect(isError(await click)).toBe(false);
    expect(isError(await snap)).toBe(false);
    expect(engines[0]!.calls()).toEqual(["browser_navigate", "browser_click", "browser_snapshot"]);
  });

  it("fails the call with words for the model after the wait, without running it", async () => {
    const { agents, host, engines } = setup(40);
    const c = await connect(agents, agents.mint(CODEX));
    await c.call("browser_navigate", { url: "https://github.com/" });
    host.take(engines[0]!.current!, "phone-1");
    const answer = await c.call("browser_click", { target: "e12" });
    expect(isError(answer)).toBe(true);
    expect(text(answer)).toContain(USER_HOLDS_TAB);
    expect(engines[0]!.calls()).toEqual(["browser_navigate"]);
  });

  it("a call the agent cancels while it waits is dropped, unanswered; a closed tab ends the wait", async () => {
    const { agents, host, engines } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    await c.call("browser_navigate", { url: "https://github.com/" });
    const tab = engines[0]!.current!;
    host.take(tab, "phone-1");
    void c.call("browser_click", { target: "e12" });
    await tick();
    c.conn.receive({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    await tick(); await tick();
    expect(c.out.filter((m) => m.id === 2)).toEqual([]);
    expect(engines[0]!.calls()).toEqual(["browser_navigate"]);
    const snap = c.call("browser_snapshot");
    await tick();
    await host.close(tab);
    expect(isError(await snap)).toBe(false);   // the engine answers for a tab that is gone, as Playwright MCP would
  });

  it("people's tabs and other agents' are never a call's target", async () => {
    const { agents, host, engines } = setup();
    const mine = await host.open(YOU, "https://mine.example/");
    const theirs = await host.open(CLAUDE, "https://theirs.example/");
    host.take(mine.id, "phone-1");
    host.take(theirs.id, "phone-1");
    const c = await connect(agents, agents.mint(CODEX));
    expect(isError(await c.call("browser_navigate", { url: "https://a.example/" }))).toBe(false);
    expect(engines[0]!.current).not.toBe(mine.id);
    expect(host.get(engines[0]!.current!)!.owner).toEqual(CODEX);
  });
});

describe("holds the bridge used to miss (review, 2026-10-02)", () => {
  it("a new connection, before Playwright MCP has a current tab, still waits for the agent's held tab", async () => {
    const { agents, host, engines } = setup();
    const s = agents.mint(CODEX);
    const first = await connect(agents, s);
    await first.call("browser_navigate", { url: "https://github.com/" });
    const tab = engines[0]!.current!;
    host.take(tab, "phone-1");
    const second = await connect(agents, s);   // its engine knows no current tab yet
    expect(engines[1]!.currentTab()).toBeNull();
    const snap = second.call("browser_network_requests");
    await new Promise((r) => setTimeout(r, 30));
    expect(engines[1]!.calls()).toEqual([]);
    host.release(tab, "phone-1");
    expect(isError(await snap)).toBe(false);
    expect(engines[1]!.calls()).toEqual(["browser_network_requests"]);
  });

  it("browser_close waits for a held tab, and closes nothing it was not handed", async () => {
    const { agents, host, engines } = setup(40);
    const c = await connect(agents, agents.mint(CODEX));
    await c.call("browser_navigate", { url: "https://a.example/" });
    const tab = engines[0]!.current!;
    host.take(tab, "phone-1");
    const answer = await c.call("browser_close");
    expect(isError(answer)).toBe(true);
    expect(text(answer)).toContain(USER_HOLDS_TAB);
    expect(host.get(tab)).not.toBeNull();
    const again = c.call("browser_close");
    await tick();
    host.release(tab, "phone-1");
    expect(text(await again)).toContain("Closed 1 tab(s)");
    expect(host.get(tab)).toBeNull();
  });

  it("a take while the element's box is found sends the call back to waiting", async () => {
    const { agents, host, engines } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    await c.call("browser_navigate", { url: "https://github.com/" });
    const tab = engines[0]!.current!;
    let found: () => void = () => undefined;
    engines[0]!.boxGate = new Promise((r) => { found = r; });
    const click = c.call("browser_click", { target: "e12", element: "Merge" });
    await tick(); await tick();
    host.take(tab, "phone-1");
    found();
    await new Promise((r) => setTimeout(r, 30));
    expect(engines[0]!.calls()).toEqual(["browser_navigate"]);
    expect(host.get(tab)!.status).toBe("idle");
    engines[0]!.boxGate = null;
    host.release(tab, "phone-1");
    expect(isError(await click)).toBe(false);
    expect(engines[0]!.calls()).toEqual(["browser_navigate", "browser_click"]);
  });

  it("a tab's logs are refused when what a hold left in them could not be kept out; other calls go on", async () => {
    const { agents, engines } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    await c.call("browser_navigate", { url: "https://github.com/" });
    engines[0]!.exposed = [engines[0]!.current!];
    for (const tool of ["browser_network_requests", "browser_network_request", "browser_console_messages"]) {
      const answer = await c.call(tool, tool === "browser_network_request" ? { index: 1 } : {});
      expect(isError(answer), tool).toBe(true);
      expect(text(answer)).toContain(HELD_LOGS_REFUSED);
    }
    expect(isError(await c.call("browser_snapshot"))).toBe(false);
    expect(engines[0]!.calls()).toEqual(["browser_navigate", "browser_snapshot"]);
    expect(engines[0]!.settles).toBeGreaterThanOrEqual(4);
  });
});

describe("the bridge's own refusals", () => {
  it("files, resizing, and anything but http(s) and about:blank never reach Playwright MCP", async () => {
    const { agents, engines } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    const refused: [string, Record<string, unknown>, string][] = [
      ["browser_take_screenshot", { filename: "/tmp/x.png" }, FILES_REFUSED],
      ["browser_snapshot", { filename: "snap.yml" }, FILES_REFUSED],
      ["browser_file_upload", { paths: ["/Users/me/.ssh/id_ed25519"] }, FILES_REFUSED],
      ["browser_drop", { target: "e1", paths: ["/etc/hosts"] }, FILES_REFUSED],
      ["browser_run_code_unsafe", { filename: "code.js" }, FILES_REFUSED],
      ["browser_resize", { width: 300, height: 300 }, RESIZE_REFUSED],
      ["browser_navigate", { url: "file:///etc/passwd" }, "Not opened"],
      ["browser_navigate", { url: "data:text/html,<p>x</p>" }, "Not opened"],
      ["browser_navigate", { url: "javascript:alert(1)" }, "Not opened"],
      ["browser_navigate", { url: "http://localhost:4711/ui" }, "Not opened"],
      ["browser_tabs", { action: "new", url: "file:///etc/passwd" }, "Not opened"],
      ["browser_navigate", { url: 7 }, "Not opened"],
    ];
    for (const [tool, args, why] of refused) {
      const answer = await c.call(tool, args);
      expect(isError(answer), tool).toBe(true);
      expect(text(answer), tool).toContain(why);
    }
    expect(engines[0]!.calls()).toEqual([]);
    // A bare host is completed as Playwright MCP does: https, allowed.
    expect(isError(await c.call("browser_navigate", { url: "example.com" }))).toBe(false);
    expect(isError(await c.call("browser_tabs", { action: "new", url: "about:blank" }))).toBe(false);
  });

  it("browser_close closes this agent's tabs only", async () => {
    const { agents, host } = setup();
    const mine = await host.open(YOU, "https://mine.example/");
    const theirs = await host.open(CLAUDE, "https://theirs.example/");
    const c = await connect(agents, agents.mint(CODEX));
    await c.call("browser_navigate", { url: "https://a.example/" });
    await host.open(CODEX, "https://b.example/");
    const answer = await c.call("browser_close");
    expect(text(answer)).toContain("Closed 2 tab(s)");
    expect(host.list().map((t) => t.id).sort()).toEqual([mine.id, theirs.id].sort());
  });
});

describe("the overlay", () => {
  it("says what the agent does, never what it types", () => {
    expect(describeCall("browser_click", { element: "Merge pull request", target: "e42" })).toBe('click "Merge pull request"');
    expect(describeCall("browser_click", { element: "Row", doubleClick: true })).toBe('double-click "Row"');
    expect(describeCall("browser_type", { element: "Password", target: "e3", text: "hunter2-plaintext" })).toBe('type into "Password"');
    expect(describeCall("browser_type", { target: "e3", text: "hunter2-plaintext" })).toBe("type into a field");
    expect(describeCall("browser_fill_form", { fields: [{ name: "Email", target: "e1", type: "textbox", value: "me@x.example" }] })).toBe('fill "Email"');
    expect(describeCall("browser_fill_form", { fields: [{ name: "a", value: "1" }, { name: "b", value: "2" }] })).toBe("fill 2 fields");
    expect(describeCall("browser_select_option", { element: "Country", values: ["secret"] })).toBe('select in "Country"');
    expect(describeCall("browser_navigate", { url: "https://www.github.com/acme?token=abc" })).toBe("open github.com");
    expect(describeCall("browser_type", { element: "enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA field" })).toBe('type into "[ciphertext] field"');
    expect(describeCall("browser_click", { element: "x".repeat(200) })!.length).toBeLessThan(80);
    expect(describeCall("browser_evaluate", { function: "() => location.href" })).toBeNull();
    expect(describeCall("browser_run_code_unsafe", { code: "async (page) => 1" })).toBeNull();
    for (const tool of ["browser_type", "browser_fill_form", "browser_select_option"]) {
      expect(describeCall(tool, { text: "hunter2-plaintext", fields: [{ value: "hunter2-plaintext" }], values: ["hunter2-plaintext"] }), tool).not.toContain("hunter2");
    }
  });
});

describe("a session with no gate in front (a terminal's agent, 2026-10-08)", () => {
  it("lists Playwright MCP's tools without the ones refused here and without parameters that name files", () => {
    const listed = directTools({ jsonrpc: "2.0", id: 1, result: { tools: [
      { name: "browser_navigate", inputSchema: { type: "object", properties: { url: {} }, required: ["url"] } },
      { name: "browser_take_screenshot", inputSchema: { type: "object", properties: { type: {}, filename: {}, scale: {} }, required: ["scale"] } },
      { name: "browser_file_upload", description: "Upload one or multiple files", inputSchema: { type: "object", properties: { paths: {} } } },
      { name: "browser_resize" }, { name: "browser_evaluate" }, { name: "browser_run_code_unsafe" },
    ] } });
    const tools = (listed.result as { tools: { name: string; description?: string; inputSchema?: { properties?: object; required?: string[] } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["browser_navigate", "browser_take_screenshot", "browser_file_upload"]);
    expect(Object.keys(tools[1]!.inputSchema!.properties!)).toEqual(["type", "scale"]);
    expect(tools[1]!.inputSchema!.required).toEqual(["scale"]);
    expect(tools[2]!.description).toContain("Dismiss the file chooser");
    expect(Object.keys(tools[2]!.inputSchema!.properties!)).toEqual([]);
  });

  it("takes the links to Playwright MCP's own files out of an answer (as the real program writes them)", () => {
    const answer = (text: string) => ({ jsonrpc: "2.0" as const, id: 1, result: { content: [{ type: "text", text }, { type: "image", data: "x" }] } });
    const text = (m: unknown) => ((m as { result: { content: { text?: string }[] } }).result.content[0]!.text ?? "");
    expect(text(withoutFileLinks(answer("### Result\n- [Screenshot of viewport](./page-2026-10-08T06-17-16-991Z.png)\n### Ran Playwright code\nx"), "/as/agents/c1")))
      .toBe("### Result\n### Ran Playwright code\nx");
    expect(text(withoutFileLinks(answer("### Page\n- Page URL: http://a/\n### Snapshot\n- [Snapshot](./page-1.yml)"), "/as/agents/c1")))
      .toBe("### Page\n- Page URL: http://a/\n### Snapshot\nCall browser_snapshot to read the page.");
    expect(text(withoutFileLinks(answer("saved to /as/agents/c1/log.txt"), "/as/agents/c1"))).toBe("saved to (not kept)/log.txt");
    const same = answer("- [a link on the page](https://example.com/x)\n- button \"Go\" [ref=e2]");
    expect(withoutFileLinks(same, "/as/agents/c1")).toBe(same);
  });

  it("runs no code and no page script for it, not even the gate's own checks", async () => {
    const { agents } = setup();
    const c = await connect(agents, agents.mint(CODEX));
    const run = await c.call("browser_run_code_unsafe", { code: "async (page) => 1" });
    expect(run.result).toMatchObject({ isError: true });
    expect(JSON.stringify(run.result)).toContain("runs no code");
    const evaluated = await c.call("browser_evaluate", { function: "() => location.href" });
    expect(JSON.stringify(evaluated.result)).toContain("no page scripts");
  });
});
