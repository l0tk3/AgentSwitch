/** A staged AgentSwitch.app and the user's go-ahead (assistant-v0 §5, 2026-09-25): the daemon sees a newer build next
 *  to its own bundle, records a confirmation from the Mac or the phone for the Mac app to act on, and tells the
 *  conversation once how the switch went. It never touches the bundles itself. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AssistantLog } from "../src/assistant/log.js";
import { Reporter, updateLine } from "../src/assistant/reports.js";
import { Bus } from "../src/engine/bus.js";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { UPDATE_REQUEST_FILE, UPDATE_RESULT_FILE, updateState } from "../src/files/appUpdate.js";
import { TARGETS_PATH } from "./helpers.js";
import { localTime } from "../src/util/localTime.js";

function bundle(path: string, built: string): string {
  mkdirSync(join(path, "Contents", "Resources", "runtime"), { recursive: true });
  writeFileSync(join(path, "Contents", "Resources", "runtime", "VERSIONS"), `node=24\nbuilt=${built}\n`);
  return path;
}

function daemon(appBundle?: string, home = mkdtempSync(join(tmpdir(), "agentswitch-update-"))) {
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "", ...(appBundle ? { appBundle } : {}) };
  const d = buildDaemon(cfg);
  const call = async (method: string, path: string, remote = false) => {
    const res = await d.app.request(path, { method }, remote ? markRemote({}, { deviceId: "phone-1" }) : undefined);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const conversation = async () => (await (await d.app.request("/assistant?last=10")).json() as { messages: Record<string, any>[] }).messages;
  return { d, home, call, conversation };
}

describe("app updates", () => {
  it("outside the app there is nothing to install", async () => {
    const f = daemon();
    expect((await f.call("GET", "/update")).body).toEqual({ running: null, staged: null, last: null });
    expect((await f.call("POST", "/update/install")).status).toBe(409);
  });

  it("a newer build next to the running bundle can be confirmed from the phone; an older one is not offered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-bundles-"));
    const app = bundle(join(dir, "AgentSwitch.app"), "2026-09-25T01:00:00Z");
    const f = daemon(app);
    expect((await f.call("GET", "/update")).body).toMatchObject({ running: "2026-09-25T01:00:00Z", staged: null });
    expect((await f.call("POST", "/update/install", true)).status).toBe(409);
    bundle(join(dir, "next", "AgentSwitch.app"), "2026-09-25T03:00:00Z");
    expect((await f.call("GET", "/update", true)).body).toMatchObject({ staged: "2026-09-25T03:00:00Z" });
    const r = await f.call("POST", "/update/install", true);
    expect(r).toMatchObject({ status: 202, body: { requested: true, staged: "2026-09-25T03:00:00Z" } });
    expect(JSON.parse(readFileSync(join(f.home, UPDATE_REQUEST_FILE), "utf8"))).toMatchObject({ by: "device phone-1" });
    bundle(join(dir, "next", "AgentSwitch.app"), "2026-09-24T00:00:00Z");
    expect(updateState(app)?.staged).toBeNull();
  });

  it("the daemon that starts after a switch tells the conversation how it went, once", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-update-"));
    writeFileSync(join(home, UPDATE_RESULT_FILE), JSON.stringify({ ok: true, reverted: false, from: "A", to: "2026-09-25T03:00:00Z", at: 1, reason: "" }));
    const first = daemon(undefined, home);
    expect((await first.conversation()).map((m) => [m.kind, m.text])).toEqual([["notice", `新版本已安装（构建于 ${localTime("2026-09-25T03:00:00Z")}），服务运行正常。`]]);
    expect(existsSync(join(home, UPDATE_RESULT_FILE))).toBe(false);
    expect((await first.call("GET", "/update")).body.last).toMatchObject({ ok: true });   // still readable, marked told
    first.d.close();
    const again = daemon(undefined, home);
    expect(await again.conversation()).toHaveLength(1);
  });

  it("an install that never started (a Mac permission missing) is told on the reporter's next tick", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-update-"));
    const f = daemon(undefined, home);
    writeFileSync(join(home, UPDATE_RESULT_FILE), JSON.stringify({ ok: false, reverted: false, from: "A", to: "B", at: 1, reason: "macOS 在等你在 Mac 上允许" }));
    const reporter = new Reporter({ log: new AssistantLog(join(home, "assistant.db")), store: f.d.store, bus: new Bus(), home });
    reporter.tick();
    expect((await f.conversation()).map((m) => m.text)).toEqual(["新版本安装失败。原因：macOS 在等你在 Mac 上允许"]);
  });

  it("a switch that fell back says so, with the reason", () => {
    expect(updateLine({ ok: false, reverted: true, from: "2026-09-25T01:00:00Z", to: "B", at: 1, reason: "the new version did not answer on port 4721 within 120s" }))
      .toBe(`新版本未能启动，已恢复为上一版本（构建于 ${localTime("2026-09-25T01:00:00Z")}）。原因：the new version did not answer on port 4721 within 120s`);
  });
});
