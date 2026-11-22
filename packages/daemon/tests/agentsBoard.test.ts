/** 设置 › Agents of this node for another node's screen (docs/agents-v0.md §12): the app's board kept as given, the
 *  actions asked of it handed over once, and which side may do which. */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountAgentsBoard } from "../src/api/agentsBoard.js";
import { markRemote } from "../src/core/caller.js";

function made() {
  let at = 1_000_000;
  const app = new Hono();
  mountAgentsBoard(app, () => at);
  const remote = markRemote({}, { deviceId: "d1" } as never);
  const call = (method: string, path: string, body?: unknown, from: object = {}) =>
    app.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }, from);
  return { call, remote, pass: (ms: number) => { at += ms; } };
}

describe("a node's Agents page for another node's screen", () => {
  it("has no board until the app hands one over, then gives it as it was given", async () => {
    const { call, remote, pass } = made();
    expect((await call("GET", "/agents/board", undefined, remote)).status).toBe(404);
    expect((await call("POST", "/agents/actions", { kind: "check" }, remote)).status).toBe(409);
    expect((await call("PUT", "/agents/board", { home: "/Users/x", agents: [] })).status).toBe(200);
    expect(await (await call("GET", "/agents/board", undefined, remote)).json()).toEqual({ board: { home: "/Users/x", agents: [] }, fresh: true });
    pass(20_000);
    expect(await (await call("GET", "/agents/board", undefined, remote)).json()).toMatchObject({ fresh: false });
    // Nobody is there to do it.
    expect((await call("POST", "/agents/actions", { kind: "check" }, remote)).status).toBe(409);
  });

  it("hands the app what was asked, once and in order; what waited too long is forgotten", async () => {
    const { call, remote, pass } = made();
    await call("PUT", "/agents/board", { agents: [] });
    expect((await call("POST", "/agents/actions", { kind: "update", agent: "codex", key: "beta", version: "0.173.0-alpha.4" }, remote)).status).toBe(202);
    expect((await call("POST", "/agents/actions", { kind: "restart" }, remote)).status).toBe(202);
    expect(await (await call("GET", "/agents/actions")).json()).toEqual({ actions: [{ kind: "update", agent: "codex", key: "beta", version: "0.173.0-alpha.4" }, { kind: "restart" }] });
    expect(await (await call("GET", "/agents/actions")).json()).toEqual({ actions: [] });
    await call("POST", "/agents/actions", { kind: "clean", agent: "claude-code" }, remote);
    pass(10_000);
    await call("PUT", "/agents/board", { agents: [] });
    pass(55_000);
    expect(await (await call("GET", "/agents/actions")).json()).toEqual({ actions: [] });
  });

  it("refuses what is not one of the page's buttons, and keeps the app's side to this Mac", async () => {
    const { call, remote } = made();
    await call("PUT", "/agents/board", { agents: [] });
    // The four agents by the names the Mac app sends.
    for (const agent of ["claude-code", "codex", "opencode", "pi"]) expect((await call("POST", "/agents/actions", { kind: "clean", agent }, remote)).status).toBe(202);
    for (const bad of [{ kind: "run", agent: "codex" }, { kind: "install", agent: "bash" }, { kind: "update", agent: "codex", version: "1; rm -rf /" }, { kind: "use", extra: 1 }]) {
      expect((await call("POST", "/agents/actions", bad, remote)).status).toBe(400);
    }
    expect((await call("PUT", "/agents/board", { agents: [] }, remote)).status).toBe(403);
    expect((await call("GET", "/agents/actions", undefined, remote)).status).toBe(403);
    expect((await call("PUT", "/agents/board", [1])).status).toBe(400);
  });
});
