/** The default work folder (docs/control-v0.md §2, 2026-09-27): a task that names no folder works in a dated, kept
 *  subfolder of a visible folder set on the Mac, not in a throw-away one in the data directory; an empty one goes. */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { removeIfEmptyTaskFolder } from "../src/files/workdir.js";
import { TARGETS_PATH } from "./helpers.js";

function daemon(taskFolders = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-workdir-")));
  const cfg: DaemonConfig = { home: join(base, "as"), targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "", taskFolders };
  const d = buildDaemon(cfg);
  const call = async (method: string, path: string, body?: unknown, remote = false) => {
    const init = { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await d.app.request(path, init, remote ? markRemote({}, { deviceId: "phone" }) : undefined);
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
  };
  return { d, base, call };
}

describe("the default work folder", () => {
  it("is set on the Mac (created if missing, checked against the folder rules) and read from the phone", async () => {
    const f = daemon();
    const root = join(f.base, "tasks-here");
    const saved = await f.call("PUT", "/settings/workdir", { path: root });
    expect(saved).toMatchObject({ status: 200, body: { path: root, problem: null } });
    expect(existsSync(root)).toBe(true);
    expect((await f.call("GET", "/settings/workdir")).body.path).toBe(root);
    for (const bad of [process.env.HOME!, "relative/dir", join(f.base, "as")]) {
      expect((await f.call("PUT", "/settings/workdir", { path: bad })).status, bad).toBe(400);
    }
    // The Mac shows these as they are: in Chinese, and saying what to do.
    expect((await f.call("PUT", "/settings/workdir", { path: process.env.HOME! })).body.error).toBe("范围过大，无法用作工作目录。请选择其中的子文件夹。");
    expect((await f.call("PUT", "/settings/workdir", { path: "relative/dir" })).body.error).toBe("请使用绝对路径。");
    expect((await f.call("PUT", "/settings/workdir", { path: join(f.base, "as") })).body.error).toMatch(/^该文件夹包含受保护的目录 .+，其中存放凭据或 AgentSwitch 的数据。请选择其他文件夹。$|^该文件夹位于受保护的目录 .+ 中/);
    expect((await f.call("GET", "/settings/workdir")).body.path).toBe(root);
  });

  it("a task naming no folder gets a kept, dated subfolder there; one left empty is removed when it ends", async () => {
    const f = daemon();
    const root = join(f.base, "work-root");
    await f.call("PUT", "/settings/workdir", { path: root });
    const t = (await f.call("POST", "/tasks", { task: "看看空间" }, true)).body;
    expect(dirname(t.cwd)).toBe(root);
    expect(basename(t.cwd)).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(t.ephemeral).toBe(false);
    await f.d.engine.idle();
    expect(existsSync(t.cwd)).toBe(false);
  });

  it("a follow-up in a task folder removed for being empty gets the folder back before it runs", async () => {
    const f = daemon();
    const root = join(f.base, "work-root");
    await f.call("PUT", "/settings/workdir", { path: root });
    const first = (await f.call("POST", "/tasks", { task: "问个问题" }, true)).body;
    await f.d.engine.idle();
    expect(existsSync(first.cwd)).toBe(false);
    const next = (await f.call("POST", "/tasks", { task: '接着 @echo {"delayMs":300}', parent_id: first.id }, true)).body;
    expect(next.cwd).toBe(first.cwd);
    for (let i = 0; i < 200 && f.d.store.getTask(next.id)!.status !== "running"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(f.d.store.getTask(next.id)!.status).toBe("running");
    expect(existsSync(first.cwd)).toBe(true);
    await f.d.engine.idle();
  });

  it("a named folder is used as is; with the feature off, tasks get throw-away folders as before", async () => {
    const on = daemon();
    const named = join(on.base, "repo");
    mkdirSync(named);
    expect((await on.call("POST", "/tasks", { task: "x", cwd: named })).body).toMatchObject({ cwd: named, ephemeral: false });
    await on.d.engine.idle();
    const off = daemon(false);
    const t = (await off.call("POST", "/tasks", { task: "x" })).body;
    expect(t.ephemeral).toBe(true);
    expect(t.cwd.startsWith(join(off.base, "as", "work"))).toBe(true);
    await off.d.engine.idle();
  });

  it("only our own empty task folders are removed", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-workdir-rm-")));
    const ours = join(root, "2026-09-27-0123abcd");
    const full = join(root, "2026-09-27-89abcdef");
    const theirs = join(root, "my-notes");
    for (const d of [ours, full, theirs]) mkdirSync(d);
    writeFileSync(join(full, "result.md"), "kept");
    expect(removeIfEmptyTaskFolder(ours, root)).toBe(true);
    expect(removeIfEmptyTaskFolder(full, root)).toBe(false);
    expect(removeIfEmptyTaskFolder(theirs, root)).toBe(false);
    expect(removeIfEmptyTaskFolder(join(root, "2026-09-27-0123abcd"), join(root, "elsewhere"))).toBe(false);
    expect([existsSync(ours), existsSync(full), existsSync(theirs)]).toEqual([false, true, true]);
  });
});
