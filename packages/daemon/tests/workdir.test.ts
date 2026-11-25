/** The default work folder (docs/control-v0.md §2, 2026-09-27): a visible folder set on the Mac. */

import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { TARGETS_PATH } from "./helpers.js";

function daemon() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-workdir-")));
  const cfg: DaemonConfig = { home: join(base, "as"), targetsPath: TARGETS_PATH, port: 0, opencodeBinary: "" };
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
});
