/** A staged AgentSwitch.app and the user's go-ahead (assistant-v0 §5, 2026-09-25): the daemon sees a newer build next
 *  to its own bundle, records a confirmation from the Mac or the phone for the Mac app to act on, and says how the
 *  last switch went. It never touches the bundles itself. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { UPDATE_REQUEST_FILE, UPDATE_RESULT_FILE, updateState } from "../src/files/appUpdate.js";
import { TARGETS_PATH } from "./helpers.js";

function bundle(path: string, built: string): string {
  mkdirSync(join(path, "Contents", "Resources", "runtime"), { recursive: true });
  writeFileSync(join(path, "Contents", "Resources", "runtime", "VERSIONS"), `node=24\nbuilt=${built}\n`);
  return path;
}

function daemon(appBundle?: string, home = mkdtempSync(join(tmpdir(), "agentswitch-update-"))) {
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, opencodeBinary: "", ...(appBundle ? { appBundle } : {}) };
  const d = buildDaemon(cfg);
  const call = async (method: string, path: string, remote = false) => {
    const res = await d.app.request(path, { method }, remote ? markRemote({}, { deviceId: "phone-1" }) : undefined);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { d, home, call };
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

  it("how the last install went stays readable, across restarts too", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-update-"));
    writeFileSync(join(home, UPDATE_RESULT_FILE), JSON.stringify({ ok: false, reverted: true, from: "A", to: "2026-09-25T03:00:00Z", at: 1, reason: "the new version did not answer" }));
    const first = daemon(undefined, home);
    expect((await first.call("GET", "/update")).body.last).toMatchObject({ ok: false, reverted: true, reason: "the new version did not answer" });
    first.d.close();
    expect((await daemon(undefined, home).call("GET", "/update")).body.last).toMatchObject({ ok: false, reverted: true });
    // One the old Dispatch's conversation had told (it renamed the file) is still the last one.
    const old = mkdtempSync(join(tmpdir(), "agentswitch-update-"));
    writeFileSync(join(old, `${UPDATE_RESULT_FILE}.announced`), JSON.stringify({ ok: true, reverted: false, from: "A", to: "B", at: 1 }));
    expect((await daemon(undefined, old).call("GET", "/update")).body.last).toMatchObject({ ok: true, to: "B" });
  });
});
