/** The keeper of a node without the Mac app (docs/mesh-v0.md §4.2): what it starts with what, how it waits between
 *  starts, how it tells the gate from another listener, the systemd unit and the terminal QR code. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backoff, BACKOFF_MAX_MS, Child, startTime } from "../src/keeper/child.js";
import { DEFAULT_PORTS, mergedPath, plan, portsOf, readSettings, writeSettings, type Layout } from "../src/keeper/plan.js";
import { qrLines, qrModules } from "../src/keeper/qr.js";
import { probeGate } from "../src/keeper/run.js";
import { keeperCommand, unitText } from "../src/keeper/systemd.js";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const LAYOUT: Layout = { daemon: ["/rt/node/bin/node", "--no-warnings=ExperimentalWarning", "/rt/daemon/dist/cli.js"], gate: "/rt/python/bin/secret-gate", nodeBin: "/rt/node/bin", runtime: "/rt" };

describe("what the keeper starts, with what", () => {
  it("gives the daemon the Mac app's table and nothing it was not meant to have", () => {
    const env = { HOME: "/home/u", USER: "u", LANG: "zh_CN.UTF-8", HTTPS_PROXY: "http://p:1", ANTHROPIC_API_KEY: "sk-x", XDG_RUNTIME_DIR: "/run/user/1000" };
    const { gateEnv, daemonEnv } = plan({ env, home: "/home/u/.agentswitch", gateHome: "/home/u/.secret-gate", settings: { name: " dell ", lan: "wg0" }, ports: { ...DEFAULT_PORTS }, layout: LAYOUT, path: "/usr/bin:/bin" });
    expect(daemonEnv).toMatchObject({
      HOME: "/home/u", USER: "u", LANG: "zh_CN.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/usr/bin:/bin",
      AGENTSWITCH_HOME: "/home/u/.agentswitch", AGENTSWITCH_PORT: "4711", AGENTSWITCH_OPENCODE_PORT: "4712",
      AGENTSWITCH_REMOTE: "1", AGENTSWITCH_REMOTE_PORT: "4713", AGENTSWITCH_REMOTE_NAME: "dell", AGENTSWITCH_LAN: "wg0",
      AGENTSWITCH_EXECUTORS: "real", SECRET_GATE_HOME: "/home/u/.secret-gate", SECRET_GATE_BIN: "/rt/python/bin/secret-gate",
      SECRET_GATE_PROXY: "http://127.0.0.1:8080",
      // Terminals outlive a restart (docs/terminal-v0.md §10), their hooks reached through the runtime's `current`.
      AGENTSWITCH_HOLD_TERMINALS: "1", AGENTSWITCH_RUNTIME_LINK: "/current",
    });
    // No proxy and no key from the keeper's own environment: the node's traffic goes the machine's way.
    expect(daemonEnv).not.toHaveProperty("HTTPS_PROXY");
    expect(daemonEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(daemonEnv).not.toHaveProperty("AGENTSWITCH_ROUTER");
    expect(gateEnv).toEqual({ HOME: "/home/u", USER: "u", LANG: "zh_CN.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/rt/python/bin:/usr/bin:/bin", SECRET_GATE_HOME: "/home/u/.secret-gate", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" });
  });

  it("turns remote access off, echo on, and a missing LANG into C.UTF-8 when told", () => {
    const { daemonEnv } = plan({ env: { HOME: "/h" }, home: "/h/.a", gateHome: "/h/.s", settings: { remote: false, executors: "echo", router: "echo", name: "x" }, ports: { ...DEFAULT_PORTS }, layout: LAYOUT, path: "/bin" });
    expect(daemonEnv).toMatchObject({ AGENTSWITCH_REMOTE: "0", AGENTSWITCH_EXECUTORS: "echo", AGENTSWITCH_ROUTER: "echo", LANG: "C.UTF-8" });
    expect(plan({ env: { HOME: "/h" }, home: "/h/.a", gateHome: "/h/.s", settings: { holdTerminals: false }, ports: { ...DEFAULT_PORTS }, layout: { ...LAYOUT, runtime: null }, path: "/bin" }).daemonEnv)
      .toMatchObject({ AGENTSWITCH_HOLD_TERMINALS: "0" });
    expect(daemonEnv).not.toHaveProperty("AGENTSWITCH_REMOTE_PORT");
    expect(daemonEnv).not.toHaveProperty("AGENTSWITCH_REMOTE_NAME");
  });

  it("finds the agents on the PATH it gives", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-keeper-bin-"));
    for (const n of ["claude", "codex"]) writeFileSync(join(dir, n), "#!/bin/sh\n", { mode: 0o755 });
    const { daemonEnv } = plan({ env: { HOME: "/h" }, home: "/h/.a", gateHome: "/h/.s", settings: {}, ports: { ...DEFAULT_PORTS }, layout: LAYOUT, path: dir });
    expect(daemonEnv).toMatchObject({ CLAUDE_BIN: join(dir, "claude"), CODEX_BIN: join(dir, "codex") });
    expect(daemonEnv).not.toHaveProperty("OPENCODE_BIN");
  });

  it("puts the login shell's PATH first, then the usual folders, then the runtime's node; once each, absolute only", () => {
    expect(mergedPath("/home/u/.nvm/bin:/usr/bin:relative:/home/u/.local/bin", "/home/u", "/rt/node/bin").split(":"))
      .toEqual(["/home/u/.nvm/bin", "/usr/bin", "/home/u/.local/bin", "/home/u/.opencode/bin", "/home/u/.npm-global/bin", "/home/u/.bun/bin", "/usr/local/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin", "/rt/node/bin"]);
    expect(mergedPath(null, "/h", "/n").split(":")[0]).toBe("/h/.local/bin");
  });

  it("keeps node.json, and refuses ports that collide or are out of range", () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-keeper-home-"));
    expect(readSettings(home)).toEqual({});
    writeSettings(home, { name: "dell", ports: { gate: 18080 } });
    expect(readSettings(home)).toEqual({ name: "dell", ports: { gate: 18080 } });
    expect(portsOf(readSettings(home))).toEqual({ ...DEFAULT_PORTS, gate: 18080 });
    expect(() => portsOf({ ports: { gate: 4711 } })).toThrow(/differ/);
    expect(() => portsOf({ ports: { remote: 80 } })).toThrow(/1024/);
    writeFileSync(join(home, "node.json"), "[]");
    expect(() => readSettings(home)).toThrow(/object/);
  });
});

describe("keeping a process running", () => {
  it("waits 1 s, then twice as long each time, never over a minute", () => {
    expect([1, 2, 3, 4, 7, 20].map(backoff)).toEqual([1000, 2000, 4000, 8000, 60000, BACKOFF_MAX_MS]);
  });

  it("starts it again when it exits, and stops it for good with its own signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-keeper-child-"));
    const lines: string[] = [];
    const child = new Child({ name: "t", command: ["/bin/sh", "-c", "echo up; exec sleep 30"], env: { PATH: "/usr/bin:/bin" }, cwd: dir, pidFile: join(dir, "t.pid"), stopSignal: "SIGTERM", stopTimeoutMs: 2000 }, (l) => lines.push(l));
    child.start();
    const first = child.pid!;
    await new Promise((r) => setTimeout(r, 300));
    expect(lines).toContain("[t] up");
    // The start time comes from /proc: Linux only, where the keeper runs; elsewhere there is none to read.
    if (process.platform === "linux") expect(startTime(first)).not.toBeNull();
    process.kill(first, "SIGKILL");
    for (let i = 0; i < 40 && (!child.running || child.pid === first); i++) await new Promise((r) => setTimeout(r, 100));
    expect(child.pid).not.toBe(first);
    expect(lines.some((l) => /exited \(SIGKILL\); starting again in 1 s/.test(l))).toBe(true);
    await child.stop();
    expect(child.running).toBe(false);
  });
});

describe("telling the gate from another listener", () => {
  const listen = (answer: string) => new Promise<number>((ok) => {
    const s = createServer((sock) => { sock.once("data", () => sock.end(answer)); });
    servers.push(s);
    s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port));
  });

  it("is the gate only with 403 and X-Secret-Gate: denied", async () => {
    expect(await probeGate(await listen("HTTP/1.1 403 Forbidden\r\nX-Secret-Gate: denied\r\nContent-Length: 0\r\n\r\n"))).toBe(true);
    expect(await probeGate(await listen("HTTP/1.1 502 Bad Gateway\r\nServer: mitmproxy\r\n\r\n"))).toBe(false);
    expect(await probeGate(await listen("HTTP/1.1 403 Forbidden\r\n\r\n"))).toBe(false);
    expect(await probeGate(await listen("SSH-2.0-OpenSSH\r\n"), 500)).toBe(false);
    const closed = await listen("");
    servers.pop()!.close();
    expect(await probeGate(closed)).toBe(false);
  });
});

describe("the systemd unit", () => {
  it("runs the keeper alone, stops it alone, outlives one process the OOM killer takes, and quotes what needs it", () => {
    const text = unitText(keeperCommand(LAYOUT), { AGENTSWITCH_HOME: "/home/u/my home/.as" });
    expect(text).toContain("ExecStart=/rt/node/bin/node --no-warnings=ExperimentalWarning /rt/daemon/dist/cli.js node run\n");
    expect(text).toContain('Environment="AGENTSWITCH_HOME=/home/u/my home/.as"\n');
    expect(text).toContain("KillMode=mixed\n");
    expect(text).toContain("OOMPolicy=continue\n");
    expect(text).toContain("ExecReload=/bin/kill -HUP $MAINPID\n");
    expect(text).toContain("WantedBy=default.target\n");
  });

  it("from a checkout, runs the keeper the way this process was started", () => {
    expect(keeperCommand({ ...LAYOUT, runtime: null, daemon: ["/n/node", "--import", "tsx", "/r/src/cli.ts"] })).toEqual(["/n/node", "--import", "tsx", "/r/src/cli.ts", "node", "run"]);
  });
});

describe("the pairing link as a QR code", () => {
  it("is square with a quiet zone, two module rows a line, black on white", () => {
    const link = `agentswitch://pair?p=${"A".repeat(600)}`;
    const m = qrModules(link);
    expect(m.length).toBe(m[0]!.length);
    expect(m[0]!.every((dark) => !dark) && m[1]!.every((dark) => !dark)).toBe(true);
    expect(m[2]!.slice(2, 9).every(Boolean)).toBe(true);   // the top of a finder pattern
    const plain = qrLines(link, false);
    expect(plain).toHaveLength(Math.ceil(m.length / 2));
    expect(plain.every((l) => [...l].length === m.length && /^[ ▀▄█]+$/.test(l))).toBe(true);
    expect(qrLines(link)[0]).toMatch(/^\x1b\[30;47m.*\x1b\[0m$/);
  });
});
