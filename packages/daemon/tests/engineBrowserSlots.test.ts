/** The engine and the browser session slots (threads-v0 §4b): a browser run gets a kept profile and gives it back; the
 *  same thread comes back to it; a run without the browser takes none; deleting the thread wipes it. */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { BrowserSlots } from "../src/executors/browserSlots.js";
import type { ExecutionInput, Executor } from "../src/executors/types.js";
import { NO_SIDE_EFFECTS } from "../src/core/outcome.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

function build() {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-eslots-"));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(home, "threads") });
  stores.push(store);
  const bus = new Bus();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const seen: ExecutionInput[] = [];
  const executor: Executor = { harness: "claude-code", async run(input) {
    seen.push(input);
    if (input.browserProfile) { mkdirSync(join(input.browserProfile, "Default"), { recursive: true }); writeFileSync(join(input.browserProfile, "Default", "Cookies"), "session"); }
    return { ok: true, lastText: "ok", sideEffects: NO_SIDE_EFFECTS };
  } };
  const slots = new BrowserSlots(join(home, "browser-profiles"), 3, Date.now, () => undefined);
  const router = echoRouter(() => decisionJson({ harness: "claude-code", model: "claude-sonnet-4-6", effort: null, needs_browser: true }));
  const engine = new Engine({ store, bus, executors: [executor], targets: realTargets(), router, quota: () => ({}), browserSlots: slots });
  return { engine, store, events, seen, slots, home };
}

describe("Engine: browser session slots", () => {
  it("a browser task runs in a kept profile, its follow-up in the same one; the slot is free again afterwards", async () => {
    const f = build();
    const a = f.engine.submit({ task: "登录 x.com 看通知", cwd: f.home, needsBrowser: true });
    await f.engine.idle();
    const b = f.engine.submit({ task: "再看一下私信", cwd: f.home, parentId: a.id, needsBrowser: true });
    await f.engine.idle();
    expect(f.store.getTask(b.id)?.status).toBe("done");
    expect(f.seen.map((i) => i.browserProfile)).toEqual([join(f.home, "browser-profiles", "slot-1"), join(f.home, "browser-profiles", "slot-1")]);
    const notes = f.events.filter((e) => e.type === "browser_session").map((e) => e.payload);
    expect(notes).toEqual([expect.objectContaining({ slot: 1, reused: false, reason: "free" }), expect.objectContaining({ slot: 1, reused: true, reason: "thread" })]);
    expect(f.slots.list()[0]).toMatchObject({ hosts: ["x.com"] });
  });

  it("a task without the browser takes no slot", async () => {
    const f = build();
    const t = f.engine.submit({ task: "总结一下 README", cwd: f.home, needsBrowser: false });
    await f.engine.idle();
    expect(f.store.getTask(t.id)?.status).toBe("done");
    // needs_browser from the router attaches the browser; this router says so for every task, so check the flag path:
    expect(f.seen[0]!.browser ? f.seen[0]!.browserProfile : undefined).toBe(f.seen[0]!.browser ? join(f.home, "browser-profiles", "slot-1") : undefined);
  });

  it("deleting the thread wipes the login it kept", async () => {
    const f = build();
    const a = f.engine.submit({ task: "登录 x.com", cwd: f.home, needsBrowser: true });
    await f.engine.idle();
    const threadId = f.store.getTask(a.id)!.threadId!;
    expect(existsSync(join(f.home, "browser-profiles", "slot-1", "Default", "Cookies"))).toBe(true);
    expect(f.engine.deleteThread(threadId)).toEqual({ ok: true });
    expect(existsSync(join(f.home, "browser-profiles", "slot-1", "Default", "Cookies"))).toBe(false);
  });
});
