/** Terminals that outlive the service (docs/terminal-v0.md §10): the real holder (native/pty-hold.c, compiled here)
 *  and a fake agent. One host lets go of its terminals as a stopping daemon does; another takes them up as the next
 *  daemon does — the same terminal, its screen, its hook token, its input; output made meanwhile not lost; an end
 *  meanwhile seen; a holder that is gone forgotten. No model is called; no systemd scope is made (`scope: false`). */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attachHeld, HoldError, specBytes, startHeld, type Holding } from "../src/terminals/held.js";
import { endLeftHeld, TerminalHost, type Launcher, type TerminalEvent, type TerminalHostOptions } from "../src/terminals/host.js";
import { HOOK_SCRIPT } from "../src/terminals/launch.js";

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const compiler = spawnSync("sh", ["-c", "command -v ${CC:-cc}"]).status === 0;
// Short paths: a Unix socket's path is at most about a hundred bytes (macOS's temporary folder is long).
const base = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ash-"));
const binary = join(base, "pty-hold");
let holding: Holding;
let dir = "";
const hosts: TerminalHost[] = [];

beforeAll(() => {
  if (!compiler) return;
  execFileSync("sh", [resolve(import.meta.dirname, "..", "native", "build.sh"), binary]);
  holding = { binary, scope: false, ringBytes: 1 << 20 };
});
afterEach(async () => {
  // Whatever a test left running ends — the programs (their process groups) and so their holders — before the host lets
  // go of the rest (a terminal still running would be let go of, held, and left for the next test).
  for (const h of hosts.splice(0)) {
    h.endHeld();
    const end = Date.now() + 3000;
    while (h.list().some((t) => t.status !== "exited") && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    h.closeAll();
  }
});
afterAll(() => { rmSync(base, { recursive: true, force: true }); });

const fakeLauncher: Launcher = (req) => ({
  file: process.execPath,
  args: [FAKE],
  env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:9", AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken },
  hooks: false,
});
const shLauncher = (script: string): Launcher => () => ({ file: "sh", args: ["-c", script], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" }, hooks: false });

function host(launcher: Launcher = fakeLauncher, hold: Partial<NonNullable<TerminalHostOptions["hold"]>> = {}): TerminalHost {
  const h = new TerminalHost({ launcher, killGraceMs: 300, hold: { holding, dir, ...hold } });
  hosts.push(h);
  return h;
}

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
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(!compiler)("terminals held across a restart", () => {
  beforeEach(() => { dir = mkdtempSync(join(base, "t")); });

  it("a stopping daemon lets go; the next takes it up: the same terminal, screen, hook token and input", async () => {
    const a = host();
    const info = await a.spawn({ harness: "claude-code", cwd: tmpdir(), cols: 80, rows: 20, name: "kept" });
    const seen: TerminalEvent[] = [];
    a.subscribe(info.id, null, (e) => seen.push(e));
    await until(() => text(seen).includes("fake agent ready"));
    a.write(info.id, "first\r");
    await until(() => text(seen).includes("first"));
    const meta = join(dir, info.id, "meta.json");
    expect(statSync(meta).mode & 0o777).toBe(0o600);
    const kept = JSON.parse(readFileSync(meta, "utf8")) as { hookToken: string; hold: { socket: string } };
    expect(statSync(kept.hold.socket).mode & 0o777).toBe(0o600);

    a.closeAll();   // the service stops
    expect(a.list()).toEqual([]);
    expect(alive(info.pid!)).toBe(true);

    const b = host();
    expect(await b.restore()).toBe(1);
    const again = b.get(info.id)!;
    expect(again).toMatchObject({ id: info.id, name: "kept", pid: info.pid, harness: "claude-code" });
    // Its agent's hooks are let in with the token it was started with.
    expect(b.profileOf(info.id, kept.hookToken)).toEqual({ harness: "claude-code", profile: null });
    expect(() => b.profileOf(info.id, "wrong")).toThrow(/hook token/);
    const after: TerminalEvent[] = [];
    b.subscribe(info.id, null, (e) => after.push(e));
    await until(() => text(after).includes("fake agent ready") && text(after).includes("first"));
    b.write(info.id, "second\r");
    await until(() => text(after).includes("second"));
    // It ends as any terminal: its exit code, its meta.json and its holder gone.
    b.write(info.id, "exit\r");
    const exit = await until(() => after.find((e) => e.type === "exit"));
    expect(exit).toMatchObject({ code: 3 });
    expect(existsSync(meta)).toBe(false);
    await until(() => !existsSync(kept.hold.socket));
  });

  it("output made while no daemon was there is not lost", async () => {
    const a = host(shLauncher("echo before; sleep 0.6; echo during; read x; echo got:$x"));
    const info = await a.spawn({ harness: "pi", cwd: tmpdir() });
    const seen: TerminalEvent[] = [];
    a.subscribe(info.id, null, (e) => seen.push(e));
    await until(() => text(seen).includes("before"));
    a.closeAll();
    await new Promise((r) => setTimeout(r, 1000));
    const b = host(shLauncher("unused"));
    await b.restore();
    const after: TerminalEvent[] = [];
    b.subscribe(info.id, null, (e) => after.push(e));
    await until(() => text(after).includes("during"));
    b.write(info.id, "yes\r");
    await until(() => text(after).includes("got:yes"));
  });

  it("a program that ended meanwhile is taken up ended, with its code and its last screen", async () => {
    const a = host(shLauncher("echo bye; sleep 0.3; exit 5"));
    const info = await a.spawn({ harness: "pi", cwd: tmpdir() });
    a.closeAll();
    await new Promise((r) => setTimeout(r, 800));
    const b = host(shLauncher("unused"));
    expect(await b.restore()).toBe(1);
    const t = await until(() => (b.get(info.id)?.status === "exited" ? b.get(info.id) : null));
    expect(t.exitCode).toBe(5);
    const after: TerminalEvent[] = [];
    b.subscribe(info.id, null, (e) => after.push(e));
    expect(text(after)).toContain("bye");
    expect(existsSync(join(dir, info.id, "meta.json"))).toBe(false);
  });

  it("a terminal whose holder is gone is forgotten", async () => {
    const a = host();
    const info = await a.spawn({ harness: "claude-code", cwd: tmpdir() });
    const meta = join(dir, info.id, "meta.json");
    const kept = JSON.parse(readFileSync(meta, "utf8")) as { hold: { socket: string } };
    a.closeAll();
    process.kill(-info.pid!, "SIGKILL");
    // The holder sees its program end and stays a day for a daemon: killed here as a holder that died would be.
    // By its exact command line (a pattern would find the shell asking too).
    const holder = spawnSync("ps", ["-eo", "pid=,args="]).stdout.toString().split("\n").map((l) => l.trim()).find((l) => l.endsWith(` ${binary} ${kept.hold.socket}`) || l.split(/\s+/).slice(1).join(" ") === `${binary} ${kept.hold.socket}`);
    if (holder) process.kill(Number(holder.split(/\s+/)[0]), "SIGKILL");
    rmSync(kept.hold.socket, { force: true });
    const b = host();
    expect(await b.restore()).toBe(0);
    expect(b.list()).toEqual([]);
    expect(existsSync(meta)).toBe(false);
  });

  it("deleting a held terminal ends its program and its holder", async () => {
    const a = host();
    const info = await a.spawn({ harness: "claude-code", cwd: tmpdir() });
    const kept = JSON.parse(readFileSync(join(dir, info.id, "meta.json"), "utf8")) as { hold: { socket: string } };
    a.remove(info.id);
    await until(() => !alive(info.pid!));
    await until(() => !existsSync(kept.hold.socket));
    expect(existsSync(join(dir, info.id, "meta.json"))).toBe(false);
  });

  it("a program that cannot start is refused at once, with the reason", async () => {
    const a = host(() => ({ file: "/nonexistent/agent", args: [], env: { PATH: "/usr/bin:/bin" }, hooks: false }));
    await expect(a.spawn({ harness: "pi", cwd: tmpdir() })).rejects.toThrow(/cannot start \/nonexistent\/agent/);
    expect(a.list()).toEqual([]);
  });

  // Review of §10 (2026-10-31): a terminal nobody takes up again is not left running on its own — unseen, its hooks
  // unanswered, nobody to end it.
  it("a terminal the next daemon cannot take up is ended, not left running", async () => {
    const a = host();
    const info = await a.spawn({ harness: "claude-code", cwd: tmpdir() });
    const meta = join(dir, info.id, "meta.json");
    a.closeAll();
    expect(alive(info.pid!)).toBe(true);
    const b = host(fakeLauncher, { restoring: () => { throw new Error("its forwarder's port is taken"); } });
    expect(await b.restore()).toBe(0);
    expect(b.list()).toEqual([]);
    await until(() => !alive(info.pid!));
    expect(existsSync(meta)).toBe(false);
  });

  it("a daemon that holds none ends what the last one left to its holders", async () => {
    const a = host();
    const info = await a.spawn({ harness: "claude-code", cwd: tmpdir() });
    const meta = join(dir, info.id, "meta.json");
    const kept = JSON.parse(readFileSync(meta, "utf8")) as { hold: { socket: string } };
    a.closeAll();
    const said: string[] = [];
    expect(await endLeftHeld(dir, (l) => said.push(l))).toBe(1);
    await until(() => !alive(info.pid!));
    await until(() => !existsSync(kept.hold.socket));
    expect(existsSync(meta)).toBe(false);
    expect(said.join("\n")).toContain(`${info.id} was held`);
    expect(await endLeftHeld(dir)).toBe(0);
  });

  it("a daemon still connected when the next takes its terminal up lets go of it: nothing ended, meta.json kept", async () => {
    const a = host();
    const info = await a.spawn({ harness: "claude-code", cwd: tmpdir() });
    const seen: TerminalEvent[] = [];
    a.subscribe(info.id, null, (e) => seen.push(e));
    await until(() => text(seen).includes("fake agent ready"));
    const meta = join(dir, info.id, "meta.json");
    // The next daemon, with the old one still there (a restart where it was slow to go).
    const b = host();
    expect(await b.restore()).toBe(1);
    await until(() => seen.some((e) => e.type === "exit"));
    // Over there it is let go of: shown ended, not as a failed turn; nothing of it ended.
    expect(a.get(info.id)).toMatchObject({ status: "exited" });
    expect(a.lastTurn(info.id)).toBeNull();
    expect(existsSync(meta)).toBe(true);
    expect(alive(info.pid!)).toBe(true);
    const after: TerminalEvent[] = [];
    b.subscribe(info.id, null, (e) => after.push(e));
    b.write(info.id, "still here\r");
    await until(() => text(after).includes("still here"));
  });

  it("a program a signal ended reports code 0 with the signal, as node-pty does", async () => {
    const a = host(shLauncher("kill -TERM $$"));
    const info = await a.spawn({ harness: "pi", cwd: tmpdir() });
    const seen: TerminalEvent[] = [];
    a.subscribe(info.id, null, (e) => seen.push(e));
    const exit = await until(() => seen.find((e) => e.type === "exit"));
    expect(exit).toMatchObject({ code: 0 });
    expect(a.lastTurn(info.id)).toBeNull();
  });

  it("the hook program refuses a tool call while no service answers, only in a held terminal and only for PreToolUse", () => {
    const run = (env: Record<string, string>, event: string) => spawnSync(process.execPath, [HOOK_SCRIPT], { input: JSON.stringify({ hook_event_name: event, tool_name: "Bash", tool_input: { command: "ls" } }),
      env: { ...process.env, AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:9", AGENTSWITCH_TERMINAL_ID: "t1", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "tok", ...env }, timeout: 15_000 });
    const held = run({ AGENTSWITCH_TERMINAL_HELD: "1" }, "PreToolUse");
    expect(held.status).toBe(0);
    expect(JSON.parse(held.stdout.toString())).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(run({ AGENTSWITCH_TERMINAL_HELD: "1" }, "Stop").stdout.toString()).toBe("");
    expect(run({}, "PreToolUse").stdout.toString()).toBe("");
  });
});

describe.skipIf(!compiler)("the holder's own door", () => {
  it("refuses a wrong token and speaks the version it has", async () => {
    const d = mkdtempSync(join(base, "d"));
    const place = { socket: join(d, "h.sock"), token: "right-token" };
    const held = await startHeld(holding, place, { file: "sh", args: ["-c", "read x; echo got:$x; read y"], cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, cols: 80, rows: 24, ringBytes: 65536 }, "unused");
    expect(held.version).toBe(1);
    let out = "";
    held.onData((d) => { out += d; });
    await expect(attachHeld({ ...place, token: "wrong" })).rejects.toThrow(HoldError);
    await expect(attachHeld({ ...place, token: "wrong" })).rejects.toThrow(/wrong token/);
    // The daemon connected is not cut off by a connection that did not know the token.
    held.write("still\r");
    await until(() => out.includes("got:still"));
    held.kill("SIGKILL");
    await until(() => !existsSync(place.socket));
  });

  it("refuses a spec with a NUL in it and a socket path too long", async () => {
    expect(() => specBytes("t", { file: "a\0b", args: [], cwd: "/", env: {}, cols: 1, rows: 1, ringBytes: 4096 })).toThrow(/NUL/);
    await expect(attachHeld({ socket: `/tmp/${"x".repeat(120)}`, token: "t" })).rejects.toThrow(/too long/);
  });
});
