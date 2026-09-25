/** Project folders a phone task may run in (assistant-v0 §5, 2026-09-25): registered on the Mac only, each checked
 *  against the cwd rules when saved and again when a task goes there; a phone task names one instead of a path. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

describe("project folders for phone tasks", () => {
  it("are set on the Mac, read from anywhere; a phone may not change them", async () => {
    const f = daemon();
    const saved = await f.call("PUT", "/projects", { projects: [{ name: "AgentSwitch", path: f.repo }] });
    expect(saved).toMatchObject({ status: 200, body: { projects: [{ name: "AgentSwitch", path: f.repo }] } });
    expect((await f.call("GET", "/projects", undefined, true)).body.projects).toEqual([{ name: "AgentSwitch", path: f.repo }]);
    expect((await f.call("PUT", "/projects", { projects: [] }, true)).status).toBe(403);
    expect((await f.call("GET", "/projects")).body.projects).toHaveLength(1);
  });

  it("refuses folders the cwd rules refuse, missing ones and duplicate names", async () => {
    const f = daemon();
    for (const path of [process.env.HOME!, "/", join(f.home, "work"), join(f.repo, "missing"), join(process.env.HOME!, ".ssh")]) {
      expect((await f.call("PUT", "/projects", { projects: [{ name: "x", path }] })).status, path).toBe(400);
    }
    expect((await f.call("PUT", "/projects", { projects: [{ name: "a", path: f.repo }, { name: "A", path: f.repo }] })).status).toBe(400);
  });

  it("a task names a project and runs in its folder, not a throw-away one; also from the phone", async () => {
    const f = daemon();
    await f.call("PUT", "/projects", { projects: [{ name: "AgentSwitch", path: f.repo }] });
    const local = await f.call("POST", "/tasks", { task: "跑一下测试", project: "agentswitch" });
    expect(local.body).toMatchObject({ cwd: f.repo, ephemeral: false });
    const phone = await f.call("POST", "/tasks", { task: "跑一下测试", project: "AgentSwitch" }, true);
    expect(phone.body).toMatchObject({ cwd: f.repo, ephemeral: false });
    expect((await f.call("POST", "/tasks", { task: "x", project: "nope" })).status).toBe(400);
    expect((await f.call("POST", "/tasks", { task: "x", project: "AgentSwitch", cwd: f.repo })).status).toBe(400);
    await f.d.engine.idle();
  });

  it("a project folder that went away is refused at use, not run somewhere else", async () => {
    const f = daemon();
    await f.call("PUT", "/projects", { projects: [{ name: "AgentSwitch", path: f.repo }] });
    rmSync(f.repo, { recursive: true });
    const r = await f.call("POST", "/tasks", { task: "x", project: "AgentSwitch" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not an existing directory/);
    expect((await f.call("GET", "/projects")).body.projects[0].problem).toMatch(/not an existing directory/);
  });

  it("the assistant sees the projects and sends a task into the one the user means; an unknown name gets a scratch folder", async () => {
    const calls: string[] = [];
    const replies = [
      JSON.stringify({ action: "create_task", text: "好的。", project: "AgentSwitch" }),
      JSON.stringify({ action: "create_task", text: "好的。", project: "Unregistered" }),
    ];
    const f = daemon({ name: "assistant-test", async route(input) { calls.push(input.task); return { text: replies.shift() ?? "", elapsedMs: 1 }; } });
    await f.call("PUT", "/projects", { projects: [{ name: "AgentSwitch", path: f.repo }] });
    const say = (text: string) => f.call("POST", "/assistant", { text, client_id: `c-${Math.random().toString(36).slice(2, 12)}` }, true);
    const inRepo = await say("修一下 AgentSwitch 的 bug");
    expect(calls[0]).toContain(`- "AgentSwitch": ${f.repo}`);
    expect(inRepo.body.task).toMatchObject({ cwd: f.repo, ephemeral: false });
    const scratch = await say("随便建个目录试试");
    expect(scratch.body.task.cwd).not.toBe(f.repo);
    expect(scratch.body.task.ephemeral).toBe(true);
    await f.d.engine.idle();
  });
});
