/** A terminal's tabs, for the simple view's side pane (docs/simple-view-v0.md §5.2 右侧栏, user #600): which browser its
 *  agent uses (the shared one, or its profile's own) and its tabs there, the one it is busy in or acted on last first;
 *  `usedAt` is when the agent last did something on a tab. Local only. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { mountTerminalBrowser, terminalTabs } from "../src/api/browser.js";
import type { ApiDeps } from "../src/api/shared.js";
import { terminalOwner } from "../src/browser/agents.js";
import { BrowserHost } from "../src/browser/host.js";
import { YOU, type TabInfo } from "../src/browser/types.js";
import { markRemote } from "../src/core/caller.js";
import { FakeDriver } from "./fakeBrowser.js";

const hosts: BrowserHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.shutdown(); });

function host(clock: { t: number }): BrowserHost {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-term-tabs-"));
  const h = new BrowserHost({ driver: new FakeDriver(), profileDir: join(root, "profile"), files: { protected: { roots: [], exempt: [] }, home: root }, ownPorts: () => [4711], log: () => undefined, mac: true, now: () => clock.t });
  hosts.push(h);
  return h;
}

describe("a terminal's tabs", () => {
  it("usedAt: opened, then moved on by the agent's busy, waiting and actions — not by going idle", async () => {
    const clock = { t: 1_000 };
    const h = host(clock);
    const tab = await h.open(terminalOwner("t1", "claude-code", "/x/AgentSwitch"), "https://example.com/");
    expect(tab.usedAt).toBe(1_000);
    clock.t = 2_000; h.setStatus(tab.id, "busy");
    expect(h.get(tab.id)!.usedAt).toBe(2_000);
    clock.t = 3_000; h.setStatus(tab.id, "idle");
    expect(h.get(tab.id)!.usedAt).toBe(2_000);
    clock.t = 4_000; h.setAction(tab.id, { tool: "browser_click", description: 'click "Merge"' });
    expect(h.get(tab.id)!.usedAt).toBe(4_000);
    clock.t = 5_000; h.setAction(tab.id, null);
    expect(h.get(tab.id)!.usedAt).toBe(4_000);
    clock.t = 6_000; h.setStatus(tab.id, "waiting");
    expect(h.get(tab.id)!.usedAt).toBe(6_000);
  });

  it("are its own only, busy ones first, then the latest used", () => {
    const tab = (id: string, owner: TabInfo["owner"], status: TabInfo["status"], usedAt: number) => ({ id, owner, status, usedAt }) as TabInfo;
    const mine = terminalOwner("t1", "codex", "/x/a"), other = terminalOwner("t2", "codex", "/x/b");
    const all = [tab("a", mine, "idle", 10), tab("b", mine, "idle", 30), tab("c", other, "busy", 50), tab("d", YOU, "idle", 60), tab("e", mine, "busy", 5), tab("f", { kind: "task", id: "t1", label: "x" }, "idle", 70)];
    expect(terminalTabs(all, "t1").map((t) => t.id)).toEqual(["e", "b", "a"]);
    expect(terminalTabs(all, "nobody")).toEqual([]);
  });

  it("GET /terminals/:id/browser: in the shared browser or the profile's own, 404 for no such terminal, not for a phone", async () => {
    const clock = { t: 1_000 };
    const shared = host(clock), own = host(clock);
    const keys: Record<string, string | null> = { t1: null, t2: "claude-code.abc123def0" };
    const deps = {
      browser: { host: shared },
      profileBrowsers: { get: (key: string) => (key === "claude-code.abc123def0" ? { host: own } : null) },
      terminals: { host: { browserKeyOf: (id: string) => (id in keys ? keys[id] : undefined) } },
    } as unknown as ApiDeps;
    const app = new Hono();
    mountTerminalBrowser(app, deps);
    await shared.open(YOU, "https://you.example/");
    const first = await shared.open(terminalOwner("t1", "codex", "/x/a"), "https://a.example/");
    clock.t = 2_000;
    const second = await shared.open(terminalOwner("t1", "codex", "/x/a"), "https://b.example/");
    clock.t = 3_000;
    await own.open(terminalOwner("t2", "claude-code", "/x/b"), "https://claude.ai/");
    const read = async (id: string) => (await app.request(`/terminals/${id}/browser`)).json() as Promise<{ browser: string | null; tabs: TabInfo[] }>;
    expect(await read("t1")).toMatchObject({ browser: null, tabs: [{ id: second.id, url: "https://b.example/" }, { id: first.id }] });
    clock.t = 4_000; shared.setStatus(first.id, "busy"); shared.setStatus(first.id, "idle");
    expect((await read("t1")).tabs.map((t) => t.id)).toEqual([first.id, second.id]);
    const theirs = await read("t2");
    expect([theirs.browser, theirs.tabs.map((t) => t.url)]).toEqual(["claude-code.abc123def0", ["https://claude.ai/"]]);
    expect((await app.request("/terminals/gone/browser")).status).toBe(404);
    expect((await app.request("/terminals/t1/browser", {}, markRemote({}, { deviceId: "phone" }))).status).toBe(403);
    // A terminal whose profile's browser is not made yet: no tabs.
    keys.t3 = "claude-code.nope000000";
    expect(await read("t3")).toEqual({ browser: "claude-code.nope000000", tabs: [] });
  });
});
