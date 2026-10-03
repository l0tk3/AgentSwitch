/** What a person does in an agent's tab while holding it stays out of the agent's logs (src/browser/heldTraffic.ts;
 *  docs/browser-v0.md §6). Pinned on Playwright MCP's own `Tab` class (playwright-core's bundle, as the daemon loads it)
 *  over a stand-in for the Playwright page: the login POST a person sent while holding the tab is not in the tab's request
 *  list, before or after the hand-back, nor in a tab a reconnecting bridge builds from the page's own records; the hold's
 *  console messages are neither listed, counted nor written to the console log file; page errors go after the grace. */

import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HeldTraffic, type TrafficHost } from "../src/browser/heldTraffic.js";
import type { HostEvent } from "../src/browser/host.js";
import type { TabInfo, TabOwner } from "../src/browser/types.js";

type TabClass = new (context: object, page: object, onPageClose: (tab: unknown) => void) => Record<string, (...args: unknown[]) => Promise<unknown>>;
const { Tab } = (createRequire(import.meta.url)("playwright-core/lib/coreBundle") as { tools: { Tab: TabClass } }).tools;

const CODEX: TabOwner = { kind: "terminal", id: "t1", label: "codex · AgentSwitch" };
const SECRET = "hunter2-typed-by-hand";
const GRACE = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Playwright request as Playwright MCP reads it. */
function request(url: string, startTime: number, body: string | null = null) {
  return { url: () => url, method: () => (body ? "POST" : "GET"), postData: () => body, timing: () => ({ startTime }), existingResponse: () => ({ status: () => 200 }), failure: () => null, isNavigationRequest: () => false, resourceType: () => "fetch" };
}

/** A console message as Playwright hands it on. */
function message(text: string, at: number, type = "log") {
  return { type: () => type, text: () => text, timestamp: () => at, location: () => ({ url: "https://login.example/", lineNumber: 1 }) };
}

/** The Playwright page behind an agent's tab: its own records (`requests()`, `consoleMessages()`, `pageErrors()`) and
 *  the events Playwright MCP's tab listens to. */
class PwPage extends EventEmitter {
  readonly sent: ReturnType<typeof request>[] = [];
  readonly logged: ReturnType<typeof message>[] = [];
  errors: Error[] = [];
  async requests() { return [...this.sent]; }
  async consoleMessages() { return [...this.logged]; }
  async pageErrors() { return [...this.errors]; }
  async clearPageErrors() { this.errors = []; }
  async clearConsoleMessages() { this.logged.length = 0; }
  send(r: ReturnType<typeof request>) { this.sent.push(r); this.emit("request", r); }
  log(m: ReturnType<typeof message>) { this.logged.push(m); this.emit("console", m); }
}

function setup() {
  const clock = { now: 1_000_000 };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-held-traffic-")));
  const page = new PwPage();
  const watchers: ((ev: HostEvent) => void)[] = [];
  const info = { id: "tab1", owner: CODEX } as TabInfo;
  const host: TrafficHost = {
    list: () => [info],
    watch: (l) => { watchers.push(l); return () => undefined; },
    page: () => ({ playwright: () => page }) as unknown as ReturnType<TrafficHost["page"]>,
  };
  const traffic = new HeldTraffic(host, { graceMs: GRACE, now: () => clock.now, log: () => undefined });
  const announce = (ev: HostEvent) => { for (const w of watchers) w(ev); };
  // Playwright MCP's per-connection context, as far as its tab uses it: config, the output folder, redaction.
  const context = (name: string) => ({ config: {}, redactSecrets: (t: string) => t, outputFile: async (t: { prefix: string; ext: string }) => join(dir, `${name}-${t.prefix}.${t.ext}`) });
  const tab = async (name: string) => {
    const t = new Tab(context(name), page, () => undefined);
    expect(traffic.guardTab(t, page)).toBe(true);
    await t.waitForInitialized!();
    return t;
  };
  /** The clock moves on `ms`, then it is read (a request's start, a message's time). */
  const at = (ms: number) => (clock.now += ms);
  return { dir, page, traffic, at, take: () => announce({ type: "held", id: "tab1", heldBy: "phone-1" }), handBack: () => announce({ type: "held", id: "tab1", heldBy: null }), tab };
}

const urls = async (t: Record<string, (...a: unknown[]) => Promise<unknown>>) => ((await t.requests!()) as ReturnType<typeof request>[]).map((r) => r.url());
const texts = async (t: Record<string, (...a: unknown[]) => Promise<unknown>>) => ((await t.consoleMessages!("debug", true)) as { text: string }[]).map((m) => m.text);

describe("a hold's traffic in Playwright MCP's tab", () => {
  it("the person's requests and console messages are not listed, counted or logged; the agent's are", async () => {
    const { dir, page, traffic, at, take, handBack, tab } = setup();
    const live = await tab("live");
    page.send(request("https://login.example/start", at(1)));
    page.log(message("agent was here", at(1)));
    at(10);
    take();
    page.send(request("https://login.example/session", at(5_000), `user=me&password=${SECRET}`));
    page.log(message(`typed ${SECRET}`, at(1)));
    page.errors.push(new Error(`page error with ${SECRET}`));
    at(1_000);
    handBack();
    page.send(request("https://login.example/late", at(GRACE - 10), `password=${SECRET}`));   // reaches Playwright just after
    expect(traffic.everHeld(page)).toBe(true);
    await traffic.settled(page);
    at(GRACE);
    page.send(request("https://login.example/next", at(1)));
    page.log(message("agent again", at(1)));
    expect(await urls(live)).toEqual(["https://login.example/start", "https://login.example/next"]);
    expect(await texts(live)).toEqual(["agent was here", "agent again"]);
    expect(await live.consoleMessageCount!()).toEqual({ total: 2, errors: 0, warnings: 0 });
    expect(page.errors).toEqual([]);   // cleared once the grace passed
    await sleep(20);   // the console log file's writes
    for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file), "utf8")).not.toContain(SECRET);
  });

  it("a tab made after the hold from the page's own records (a reconnecting bridge) leaves them out too", async () => {
    const { page, traffic, at, take, handBack, tab } = setup();
    page.send(request("https://login.example/start", at(1)));
    at(10);
    take();
    const sent = at(3_000);
    page.send(request("https://login.example/session", sent, `password=${SECRET}`));
    page.log(message(`typed ${SECRET}`, at(1)));
    at(500);
    handBack();
    await traffic.settled(page);
    at(GRACE + 1);
    // The same request as a new object (Playwright made it again for the page's list): told by its start time.
    page.sent.push(request("https://login.example/session-again", sent, `password=${SECRET}`));
    const later = await tab("later");
    expect(await urls(later)).toEqual(["https://login.example/start"]);
    expect(await texts(later)).toEqual([]);
  });

  it("while the hold lasts, a tab made then records nothing new", async () => {
    const { page, at, take, tab } = setup();
    take();
    const during = await tab("during");
    page.send(request("https://login.example/session", at(100), `password=${SECRET}`));
    expect(await urls(during)).toEqual([]);
  });

  it("a tab that is not Playwright MCP's as expected is reported, not guarded", () => {
    const { page, traffic } = setup();
    expect(traffic.guardTab({ requests: async () => [] }, page)).toBe(false);
    expect(traffic.guardTab(null, page)).toBe(false);
  });
});
