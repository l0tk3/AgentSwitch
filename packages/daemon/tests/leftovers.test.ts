/** What a terminal leaves running after it ended (docs/terminal-v0.md §11, terminals/leftovers.ts): found by the tags
 *  every process under a terminal inherits, ended after the grace — one terminal's at a time, and all of them now and
 *  then. The process table is a fake here; nothing on this machine is signalled. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon } from "../src/daemon.js";
import { TerminalHost, type Launcher } from "../src/terminals/host.js";
import { HOOK_SCRIPT } from "../src/terminals/launch.js";
import { LEFTOVER_GRACE_MS, Leftovers, parsePsEnv, withProcEnviron, type Leftover } from "../src/terminals/leftovers.js";
import { TARGETS_PATH } from "./helpers.js";

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const fakeLauncher: Launcher = (req) => ({
  file: process.execPath, args: [FAKE],
  env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:9", AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken },
  hooks: false,
});

const OURS = "http://127.0.0.1:4721";
const proc = (pid: number, terminal: string, url = OURS, command = "node server.js"): Leftover =>
  ({ pid, ppid: 1, pgid: pid, terminal, url, elapsed: "01:02:03", cpu: 1.5, rssKb: 20480, command });

describe("the tags a process carries", () => {
  it("reads macOS's ps -E lines: the command apart from the environment after it, the terminal and the service", () => {
    const lines = [
      " 4242     1  4242    02-03:04:05   0.5  51200 node /x/server.js --port=3000 PATH=/usr/bin:/bin AGENTSWITCH_TERMINAL_ID=c701ed9e AGENTSWITCH_TERMINAL_URL=http://127.0.0.1:4721 HOME=/Users/u",
      " 4243  4242  4242       00:10   0.0   1024 sleep 30 AGENTSWITCH_TERMINAL_URL=http://127.0.0.1:4721 AGENTSWITCH_TERMINAL_ID=c701ed9e",
      "  999     1   999       05:00   0.0   2048 /usr/sbin/cron PATH=/usr/bin",                      // not a terminal's
      " 1000     1  1000       05:00   0.0   2048 node a.js AGENTSWITCH_TERMINAL_ID=../x AGENTSWITCH_TERMINAL_URL=http://127.0.0.1:4721",   // not an id
      "garbage",
    ].join("\n");
    expect(parsePsEnv(lines)).toEqual([
      { pid: 4242, ppid: 1, pgid: 4242, elapsed: "02-03:04:05", cpu: 0.5, rssKb: 51200, terminal: "c701ed9e", url: OURS, command: "node /x/server.js --port=3000" },
      { pid: 4243, ppid: 4242, pgid: 4242, elapsed: "00:10", cpu: 0, rssKb: 1024, terminal: "c701ed9e", url: OURS, command: "sleep 30" },
    ]);
  });

  it("reads Linux's table with each process's environ, skipping what cannot be read (not ours)", () => {
    const table = "  77  1  77  01:00 0.0 4096 python3 serve.py\n  78  1  78  01:00 0.0 4096 other\n";
    const environ = (pid: number) => (pid === 77 ? "HOME=/h\0AGENTSWITCH_TERMINAL_ID=ab12cd34\0AGENTSWITCH_TERMINAL_URL=http://127.0.0.1:4711\0" : null);
    expect(withProcEnviron(table, environ)).toEqual([{ pid: 77, ppid: 1, pgid: 77, elapsed: "01:00", cpu: 0, rssKb: 4096, terminal: "ab12cd34", url: "http://127.0.0.1:4711", command: "python3 serve.py" }]);
  });
});

describe("what a terminal left", () => {
  function world(table: Leftover[], live: string[] = []) {
    const signals: [number, string][] = [];
    const gone = new Set<number>();
    const lines: string[] = [];
    const leftovers = new Leftovers({
      url: () => OURS, live: () => new Set(live), source: async () => table.filter((p) => !gone.has(p.pid)),
      kill: (pid, signal) => { signals.push([pid, signal]); if (signal === "SIGKILL" || pid % 2 === 0) gone.add(pid); },
      alive: (pid) => !gone.has(pid), graceMs: 40, hardAfterMs: 10, sweepMs: 30, log: (l) => lines.push(l),
    });
    return { leftovers, signals, gone, lines };
  }

  it("lists this service's, of terminals not running: not a running terminal's, not another service's, not itself", async () => {
    const table = [proc(10, "t1"), proc(11, "t2"), proc(12, "t1", "http://127.0.0.1:4799"), proc(process.pid, "t1"), proc(1, "t1")];
    const { leftovers } = world(table, ["t2"]);
    expect((await leftovers.list()).map((p) => p.pid)).toEqual([10]);
  });

  it("ends one terminal's after the grace — SIGTERM, then SIGKILL for what stayed — and leaves the others alone", async () => {
    const table = [proc(10, "t1"), proc(11, "t1", OURS, "sleep 999"), proc(20, "t3")];
    const { leftovers, signals, lines } = world(table);
    leftovers.ended("t1");
    leftovers.ended("t1");   // told twice, ended once
    await vi.waitFor(() => expect(signals.length).toBe(3), { timeout: 2000 });
    // 10 went on SIGTERM; 11 (odd) stayed and got SIGKILL; 20 belongs to a terminal still to be told about.
    expect(signals).toEqual([[10, "SIGTERM"], [11, "SIGTERM"], [11, "SIGKILL"]]);
    expect(lines.join("\n")).toMatch(/2 left behind by t1 ended \(1 by SIGKILL\): 10 node, 11 sleep/);
    expect((await leftovers.list()).map((p) => p.pid)).toEqual([20]);
  });

  it("sweeps everything now and then once started, and nothing after stop", async () => {
    const table = [proc(10, "t1"), proc(20, "t3")];
    const { leftovers, signals } = world(table);
    leftovers.start();
    await vi.waitFor(() => expect(signals.map(([pid]) => pid).sort()).toEqual([10, 20]), { timeout: 2000 });
    leftovers.stop();
    const n = signals.length;
    table.push(proc(30, "t4"));
    await new Promise((r) => setTimeout(r, 80));
    expect(signals.length).toBe(n);
    leftovers.ended("t4");
    await new Promise((r) => setTimeout(r, 80));
    expect(signals.length).toBe(n);
  });

  it("ends the pids named, and only those among the leftovers", async () => {
    const table = [proc(10, "t1"), proc(12, "t1"), proc(14, "t2")];
    const { leftovers, signals } = world(table, ["t2"]);
    expect((await leftovers.sweep([12, 14, 99])).map((p) => p.pid)).toEqual([12]);
    expect(signals).toEqual([[12, "SIGTERM"]]);
  });

  it("gives a terminal thirty seconds by default", () => {
    expect(LEFTOVER_GRACE_MS).toBe(30_000);
  });
});

describe("the host tells when a terminal's program is gone", () => {
  it("on its exit and on deletion, not for a program that goes on elsewhere", async () => {
    const left: string[] = [];
    const host = new TerminalHost({ launcher: fakeLauncher, killGraceMs: 200, onLeft: (id) => left.push(id) });
    try {
      const a = await host.spawn({ harness: "codex", cwd: tmpdir() });
      host.write(a.id, "exit\r");
      await vi.waitFor(() => expect(left).toEqual([a.id]), { timeout: 5000 });
      const b = await host.spawn({ harness: "codex", cwd: tmpdir() });
      host.remove(b.id);
      await vi.waitFor(() => expect(left).toEqual([a.id, b.id]), { timeout: 5000 });
    } finally { host.closeAll(); }
  });
});

describe("the routes (docs/terminal-v0.md §11)", () => {
  const cfg = () => ({ home: mkdtempSync(join(tmpdir(), "agentswitch-leftovers-")), targetsPath: TARGETS_PATH, port: 0, opencodeBinary: "" });

  it("list and end what this service's terminals left, on this machine only; a service not cleaning says so", async () => {
    // Cleaning on: the real process table is read, for a service address nothing on this machine carries (port 0).
    const d = buildDaemon({ ...cfg(), leftovers: true }, { terminalLauncher: fakeLauncher });
    try {
      expect(await (await d.app.request("/terminals/leftovers")).json()).toEqual({ on: true, graceMs: 30_000, leftovers: [] });
      expect((await d.app.request("/terminals/leftovers", {}, markRemote({}, { deviceId: "phone-1" }))).status).toBe(403);
      const post = (body: unknown, env?: object) => d.app.request("/terminals/leftovers/end", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
      expect((await post({}, markRemote({}, { deviceId: "phone-1" }))).status).toBe(403);
      expect((await post({ pids: ["x"] })).status).toBe(400);
      expect(await (await post({ terminal: "c701ed9e" })).json()).toEqual({ ended: [] });
      expect(await (await post({})).json()).toEqual({ ended: [] });
    } finally { d.close(); }
    const off = buildDaemon(cfg(), { terminalLauncher: fakeLauncher });
    try {
      expect(await (await off.app.request("/terminals/leftovers")).json()).toEqual({ on: false, leftovers: [] });
      expect(off.leftovers).toBeNull();
    } finally { off.close(); }
  });
});
