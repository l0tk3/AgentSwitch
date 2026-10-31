/** Tool terminals (docs/yazi-v0.md): yazi beside an agent's terminal — a fake yazi and a fake agent in real
 *  pseudo-terminals. Opened in the agent's folder, one per agent terminal, gone when it quits and when its agent
 *  terminal is closed; and to paired devices it does not exist unless this node lets paired nodes have it (§3). */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveSnapshot } from "../src/api/live.js";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { registerDevice } from "../src/remote/devices.js";
import { remoteAllowed } from "../src/remote/routes.js";
import { TerminalHost, type Launcher, type TerminalEvent, type TerminalHostOptions } from "../src/terminals/host.js";
import { toolLauncher } from "../src/terminals/launch.js";
import { TARGETS_PATH } from "./helpers.js";

const AGENT = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const YAZI = resolve(import.meta.dirname, "fixtures", "fakeYazi.mjs");
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

const agent: Launcher = (req) => ({ file: process.execPath, args: [AGENT], env: { ...(process.env as Record<string, string>), AGENTSWITCH_TERMINAL_ID: req.id }, hooks: false });
const yazi: NonNullable<TerminalHostOptions["toolLauncher"]> = ({ cwd }) => ({ file: process.execPath, args: [YAZI, cwd], env: { ...(process.env as Record<string, string>) }, hooks: false });

async function until<T>(get: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const text = (events: TerminalEvent[]): string => events.map((e) => (e.type === "snapshot" || e.type === "output" ? e.data : "")).join("");
const folder = (): string => realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-tool-cwd-")));

describe("tool terminals: the host", () => {
  it("opens yazi in its agent terminal's folder, once, and lets it go when it quits", async () => {
    const host = new TerminalHost({ launcher: agent, toolLauncher: yazi });
    closers.push(() => host.closeAll());
    const cwd = folder();
    const parent = await host.spawn({ harness: "claude-code", cwd, cols: 90, rows: 30 });
    const tool = await host.spawnTool(parent.id, "yazi");
    expect(tool).toMatchObject({ harness: "yazi", parent: parent.id, cwd, cols: 90, rows: 30, hooks: false, agentSessionId: null, profile: null });
    expect(parent.parent).toBeNull();
    const events: TerminalEvent[] = [];
    host.subscribe(tool.id, null, (e) => events.push(e));
    await until(() => text(events).includes(`fake yazi in ${cwd}`));
    // It draws as it is used, and is never at work.
    host.write(tool.id, "j");
    await until(() => text(events).includes("yazi got"));
    expect(host.get(tool.id)?.status).toBe("idle");
    // Asked again: the one already open.
    expect((await host.spawnTool(parent.id, "yazi")).id).toBe(tool.id);
    expect(host.list().filter((t) => t.parent === parent.id)).toHaveLength(1);
    host.write(tool.id, "q");
    await until(() => events.some((e) => e.type === "removed"));
    expect(host.get(tool.id)).toBeNull();
    expect(host.get(parent.id)?.status).not.toBe("exited");
    // Opened again after it quit: a new one.
    const again = await host.spawnTool(parent.id, "yazi");
    expect(again.id).not.toBe(tool.id);
  });

  it("closes a tool terminal with its agent terminal", async () => {
    const host = new TerminalHost({ launcher: agent, toolLauncher: yazi });
    closers.push(() => host.closeAll());
    const parent = await host.spawn({ harness: "codex", cwd: folder() });
    const tool = await host.spawnTool(parent.id, "yazi");
    host.remove(parent.id);
    expect(host.get(tool.id)).toBeNull();
    expect(host.list()).toEqual([]);
  });

  it("refuses a tool beside a tool, an unknown terminal, and where no tool can start", async () => {
    const host = new TerminalHost({ launcher: agent, toolLauncher: yazi });
    closers.push(() => host.closeAll());
    const parent = await host.spawn({ harness: "pi", cwd: folder() });
    const tool = await host.spawnTool(parent.id, "yazi");
    await expect(host.spawnTool(tool.id, "yazi")).rejects.toMatchObject({ code: "invalid" });
    await expect(host.spawnTool("nope", "yazi")).rejects.toMatchObject({ code: "not_found" });

    const without = new TerminalHost({ launcher: agent });
    closers.push(() => without.closeAll());
    const other = await without.spawn({ harness: "pi", cwd: folder() });
    await expect(without.spawnTool(other.id, "yazi")).rejects.toMatchObject({ code: "unavailable" });

    const missing = new TerminalHost({ launcher: agent, toolLauncher: toolLauncher({ binaries: {} }) });
    closers.push(() => missing.closeAll());
    const third = await missing.spawn({ harness: "pi", cwd: folder() });
    await expect(missing.spawnTool(third.id, "yazi")).rejects.toThrow("yazi is not installed on this node");
  });

  it("starts the tool on the folder, with the terminal's id and none of an agent's hooks", () => {
    const plan = toolLauncher({ binaries: { yazi: "/usr/bin/yazi" }, env: { PATH: "/usr/bin", HOME: "/home/me", CLAUDECODE: "1" } })({ id: "t1", tool: "yazi", cwd: "/work/app" });
    expect(plan).toMatchObject({ file: "/usr/bin/yazi", args: ["/work/app"], hooks: false });
    expect(plan.env).toMatchObject({ PATH: "/usr/bin", TERM: "xterm-256color", AGENTSWITCH_TERMINAL_ID: "t1" });
    expect(plan.env.CLAUDECODE).toBeUndefined();
    expect(plan.env.AGENTSWITCH_TERMINAL_HOOK_TOKEN).toBeUndefined();
  });

  it("is no agent's work on the Live Activity", async () => {
    const host = new TerminalHost({ launcher: agent, toolLauncher: yazi });
    closers.push(() => host.closeAll());
    const parent = await host.spawn({ harness: "claude-code", cwd: folder() });
    await host.spawnTool(parent.id, "yazi");
    const daemon = buildDaemon(config(), { terminalLauncher: agent });
    closers.push(() => daemon.close());
    expect(liveSnapshot(daemon.store, host, Date.now()).open).toBe(1);
  });
});

function config(): DaemonConfig {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-tool-"));
  return { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
}

describe("tool terminals: who has them (docs/yazi-v0.md §3)", () => {
  it("are this node's own, and a paired node's only while this node lets it; never a phone's", async () => {
    const daemon = buildDaemon(config(), { terminalLauncher: agent, toolLauncher: yazi });
    closers.push(() => daemon.close());
    const node = markRemote({}, { deviceId: registerDevice(daemon.store, { name: "MateBook14", platform: "macos" }).device.id });
    const phone = markRemote({}, { deviceId: registerDevice(daemon.store, { name: "iPhone", platform: "ios" }).device.id });
    const call = (method: string, path: string, body?: unknown, env?: object) =>
      daemon.api.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    const listed = async (env?: object) => ((await (await call("GET", "/terminals", undefined, env)).json()) as { terminals: { id: string }[] }).terminals.map((t) => t.id);

    const parent = ((await (await call("POST", "/terminals", { harness: "claude-code", cwd: folder() })).json()) as { terminal: { id: string } }).terminal.id;
    expect(remoteAllowed("POST", `/terminals/${parent}/tool`)).toBe(true);

    // Off (the default): neither a node nor a phone may open one, or see the one this node opened.
    for (const env of [node, phone]) expect((await call("POST", `/terminals/${parent}/tool`, { tool: "yazi" }, env)).status).toBe(403);
    const opened = await call("POST", `/terminals/${parent}/tool`, { tool: "yazi" });
    expect(opened.status).toBe(200);
    const tool = ((await opened.json()) as { terminal: { id: string; harness: string; parent: string } }).terminal;
    expect(tool).toMatchObject({ harness: "yazi", parent });
    expect(await listed()).toEqual(expect.arrayContaining([parent, tool.id]));
    for (const env of [node, phone]) {
      expect(await listed(env)).toEqual([parent]);
      expect((await call("GET", `/terminals/${tool.id}`, undefined, env)).status).toBe(404);
      expect((await call("GET", `/terminals/${tool.id}/stream`, undefined, env)).status).toBe(404);
      expect((await call("POST", `/terminals/${tool.id}/keys`, { keys: ["enter"] }, env)).status).toBe(404);
      expect((await call("POST", `/terminals/${tool.id}/write`, { data: "!rm -rf ~\r" }, env)).status).toBe(404);
      expect((await call("DELETE", `/terminals/${tool.id}`, undefined, env)).status).toBe(404);
    }
    const node0 = ((await (await daemon.app.request("/node")).json()) as { has: string[] }).has;
    expect(node0).not.toContain("tools");

    // Turned on, on the node itself (the remote list does not name the route).
    expect(remoteAllowed("PUT", "/settings/mesh")).toBe(false);
    const set = await daemon.app.request("/settings/mesh", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyboard: true, tools: true }) });
    expect(await set.json()).toEqual({ keyboard: true, files: true, changes: true, tools: true });
    expect(((await (await daemon.app.request("/node")).json()) as { has: string[] }).has).toContain("tools");
    expect(await listed(node)).toEqual(expect.arrayContaining([parent, tool.id]));
    const fromNode = await call("POST", `/terminals/${parent}/tool`, { tool: "yazi" }, node);
    expect(fromNode.status).toBe(200);
    expect(((await fromNode.json()) as { terminal: { id: string } }).terminal.id).toBe(tool.id);
    expect((await call("GET", `/terminals/${tool.id}`, undefined, node)).status).toBe(200);
    // A phone still has none.
    expect(await listed(phone)).toEqual([parent]);
    expect((await call("POST", `/terminals/${parent}/tool`, { tool: "yazi" }, phone)).status).toBe(403);
    expect((await call("GET", `/terminals/${tool.id}`, undefined, phone)).status).toBe(404);

    // A screen that knows only the keyboard switch (an older Mac) leaves this one as it was.
    const older = await daemon.app.request("/settings/mesh", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyboard: false }) });
    expect(await older.json()).toEqual({ keyboard: false, files: true, changes: true, tools: true });
  });

  it("refuses an unknown tool", async () => {
    const daemon = buildDaemon(config(), { terminalLauncher: agent, toolLauncher: yazi });
    closers.push(() => daemon.close());
    const parent = ((await (await daemon.api.request("/terminals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness: "codex", cwd: folder() }) })).json()) as { terminal: { id: string } }).terminal.id;
    const res = await daemon.api.request(`/terminals/${parent}/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "bash" }) });
    expect(res.status).toBe(400);
  });
});
