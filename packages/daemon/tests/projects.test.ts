/** Folders a phone task runs in (assistant-v0 §5). The registered project list is gone (2026-09-25, user decision):
 *  a task names a folder by its path, and the assistant offers the folders earlier tasks worked in. */

import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import type { Router } from "../src/core/modelCall.js";
import { TARGETS_PATH } from "./helpers.js";

function daemon(assistant?: Router) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-projects-")));
  const repo = join(home, "..", `repo-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(repo, { recursive: true });
  const cfg: DaemonConfig = { home: join(home, "as"), targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  const d = buildDaemon(cfg, assistant ? { assistant } : {});
  const call = async (method: string, path: string, body?: unknown, remote = false) => {
    const init = { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await d.app.request(path, init, remote ? markRemote({}, { deviceId: "phone" }) : undefined);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { d, repo: realpathSync(repo), home: cfg.home, call };
}

describe("folders for phone tasks", () => {
  it("there is no project list any more: the routes are gone and a task names a folder by its path (2026-09-25)", async () => {
    const f = daemon();
    expect((await f.d.app.request("/projects")).status).toBe(404);
    expect((await f.d.app.request("/projects", {}, markRemote({}, { deviceId: "phone" }))).status).toBe(404);
    const phone = await f.call("POST", "/tasks", { task: "跑一下测试", cwd: f.repo }, true);
    expect(phone.body).toMatchObject({ cwd: f.repo, ephemeral: false });
    await f.d.engine.idle();
  });

  it("the assistant sends a task into a folder the user names (2026-09-25); one the cwd rules refuse is said, not run", async () => {
    const replies: string[] = [];
    const f = daemon({ name: "assistant-test", async route() { return { text: replies.shift() ?? "", elapsedMs: 1 }; } });
    replies.push(JSON.stringify({ action: "create_task", text: "已建任务。", cwd: f.repo }), JSON.stringify({ action: "create_task", text: "已建任务。", cwd: "~" }));
    const say = (text: string) => f.call("POST", "/assistant", { text, client_id: `c-${Math.random().toString(36).slice(2, 12)}` }, true);
    const named = await say(`在 ${f.repo} 里跑一下测试`);
    expect(named.body.task).toMatchObject({ cwd: f.repo, ephemeral: false });
    const home = await say("在我的主目录里整理一下");
    expect(home.body.task).toBeUndefined();
    expect(home.body.assistant.text).toMatch(/任务未创建.*too broad/);
    await f.d.engine.idle();
  });

  it("the assistant sees the folders earlier tasks worked in, not the scratch ones, and goes back to one the user means", async () => {
    const calls: string[] = [];
    const replies: string[] = [];
    const f = daemon({ name: "assistant-test", async route(input) { calls.push(input.task); return { text: replies.shift() ?? "", elapsedMs: 1 }; } });
    await f.call("POST", "/tasks", { task: "修一下登录页", cwd: f.repo });
    await f.call("POST", "/tasks", { task: "随便试试" });
    await f.d.engine.idle();
    replies.push(JSON.stringify({ action: "create_task", text: "已建任务。", cwd: f.repo }));
    const again = await f.call("POST", "/assistant", { text: "还是那个仓库，再跑一遍测试", client_id: "c-again-0001" }, true);
    const folders = calls[0]!.split("Folders earlier tasks worked in (newest first):\n")[1]!.split("\n\n")[0]!;
    expect(folders).toMatch(new RegExp(`^- ${f.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — .*修一下登录页$`));
    expect(again.body.task).toMatchObject({ cwd: f.repo, ephemeral: false });
    await f.d.engine.idle();
  });
});
