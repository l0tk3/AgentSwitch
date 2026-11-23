/** The old dispatch is off while the new one (on Chat Rooms) is tested (2026-11-24, core/oldDispatch.ts): nothing new
 *  is submitted, continued or answered; old tasks and threads can still be read. */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemon } from "../src/daemon.js";
import { OLD_DISPATCH_OFF, OLD_DISPATCH_OFF_CODE, OLD_DISPATCH_OFF_ERROR } from "../src/core/oldDispatch.js";
import { TARGETS_PATH } from "./helpers.js";

function daemon(oldDispatchOff?: boolean) {
  const home = join(realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-off-"))), "as");
  const d = buildDaemon({ home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" },
    oldDispatchOff === undefined ? {} : { oldDispatchOff });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await d.app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
  };
  return { d, call };
}

describe("the old dispatch, off", () => {
  it("is off by default", () => expect(OLD_DISPATCH_OFF).toBe(true));

  it("refuses new tasks, assistant messages, handoffs, answers and allowing; reading stays", async () => {
    // An old task, made while it was on, in the same home.
    const on = daemon(false);
    const t = (await on.call("POST", "/tasks", { task: "hello" })).body!;
    await on.d.engine.idle();
    const off = daemon();
    const refused = { error: OLD_DISPATCH_OFF_ERROR, code: OLD_DISPATCH_OFF_CODE };
    for (const [path, body] of [
      ["/tasks", { task: "hello" }],
      ["/assistant", { text: "hello", client_id: "client-0001" }],
      [`/tasks/${t.id as string}/handoff`, {}],
      [`/tasks/${t.id as string}/answer`, { approval_id: "x", text: "yes" }],
      [`/tasks/${t.id as string}/approve`, { approval_id: "x", decision: "allow" }],
    ] as const) {
      const r = await off.call("POST", path, body);
      expect(r.status, path).toBe(410);
      expect(r.body, path).toEqual(refused);
    }
    // Denying lets an old task end: not refused for being off (there is no such approval here).
    expect((await off.call("POST", `/tasks/${t.id as string}/approve`, { approval_id: "x", decision: "deny" })).status).toBe(404);
    expect((await off.call("GET", "/tasks")).status).toBe(200);
    expect((await off.call("GET", "/threads")).status).toBe(200);
    expect((await off.call("GET", "/assistant")).status).toBe(200);
    on.d.close();
    off.d.close();
  });
});
