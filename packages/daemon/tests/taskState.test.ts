/** Task state the phone shows (docs/control-v0.md §4, 2026-09-27): read or unread, what a restart left unconfirmed,
 *  and finding an old task by what it said. */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { INTERRUPTED_MESSAGE } from "../src/engine/engine.js";
import { snippet } from "../src/engine/search.js";
import { Store } from "../src/engine/store.js";
import { TARGETS_PATH } from "./helpers.js";

function config(home: string): DaemonConfig {
  return { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
}

function daemon(home = join(realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-state-"))), "as")) {
  const d = buildDaemon(config(home));
  const call = async (method: string, path: string, body?: unknown) => {
    const init = { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await d.app.request(path, init, markRemote({}, { deviceId: "phone" }));
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { d, home, call };
}

describe("task state for the phone", () => {
  it("opening an ended task marks it read without making it look updated", async () => {
    const f = daemon();
    const t = (await f.call("POST", "/tasks", { task: "hello" })).body;
    await f.d.engine.idle();
    const ended = (await f.call("GET", `/tasks/${t.id}`)).body;
    expect(ended.acknowledgedAt).toBeNull();
    const ack = await f.call("POST", `/tasks/${t.id}/ack`);
    expect(ack.status).toBe(200);
    const read = (await f.call("GET", `/tasks/${t.id}`)).body;
    expect(read.acknowledgedAt).toBeGreaterThan(0);
    expect(read.updatedAt).toBe(ended.updatedAt);
    expect((await f.call("POST", "/tasks/nope/ack")).status).toBe(404);
  });

  it("finds tasks by what was asked or said, long queries by index and short ones by substring; deleted ones go", async () => {
    const f = daemon();
    const a = (await f.call("POST", "/tasks", { task: "登录财务平台，汇总首页的待办" })).body;
    const b = (await f.call("POST", "/tasks", { task: "整理下载目录 Duplicate Files" })).body;
    await f.d.engine.idle();
    expect((await f.call("GET", "/search?q=财务平台")).body.results.map((r: any) => r.taskId)).toEqual([a.id]);
    expect((await f.call("GET", "/search?q=duplicate")).body.results.map((r: any) => r.taskId)).toEqual([b.id]);
    expect((await f.call("GET", "/search?q=登录")).body.results[0]).toMatchObject({ taskId: a.id, snippet: expect.stringContaining("⟦登录⟧") });
    expect((await f.call("GET", "/search?q=")).body.results).toEqual([]);
    await f.call("DELETE", `/tasks/${a.id}`);
    expect((await f.call("GET", "/search?q=财务平台")).body.results).toEqual([]);
  });

  it("a task left running when the daemon stopped is blocked as unconfirmed at the next start; its cards expire", async () => {
    const home = join(realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-state-"))), "as");
    const store = new Store({ dbPath: join(home, "agentswitch.db"), threadsDir: join(home, "threads") });
    const t = store.createTask({ task: "long job", cwd: "/tmp/x" });
    store.updateTask(t.id, { status: "running" });
    const card = store.createApproval(t.id, "Bash: rm x", "", "approval");
    const done = store.createTask({ task: "finished", cwd: "/tmp/y" });
    store.updateTask(done.id, { status: "done", result: "ok" });
    const f = daemon(home);
    const after = (await f.call("GET", `/tasks/${t.id}`)).body;
    expect(after).toMatchObject({ status: "blocked", blockCause: "interrupted", error: INTERRUPTED_MESSAGE });
    expect(f.d.store.getApproval(card.id)!.status).toBe("expired");
    expect(f.d.store.eventsSince(t.id).at(-1)).toMatchObject({ type: "blocked", payload: { cause: "interrupted" } });
    expect((await f.call("GET", `/tasks/${done.id}`)).body.status).toBe("done");
  });

  it("a snippet shows the hit with a little text on either side", () => {
    expect(snippet("前面很长的一段文字然后是登录财务平台，汇总首页的待办", "财务")).toBe("前面很长的一段文字然后是登录⟦财务⟧平台，汇总首页的待办");
    expect(snippet("a".repeat(60) + "needle" + "b".repeat(60), "NEEDLE")).toBe(`…${"a".repeat(24)}⟦needle⟧${"b".repeat(24)}…`);
  });
});
