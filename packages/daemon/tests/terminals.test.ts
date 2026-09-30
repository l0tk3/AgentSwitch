/** AgentSwitch's terminals (docs/terminal-v0.md): a fake agent in a real pseudo-terminal, the host's screen and replay,
 *  and the whole path over real HTTP — start, stream, reply, a permission request through the real hook command
 *  answered from the API, audit, delete. No model is called. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { remoteAllowed } from "../src/remote/routes.js";
import { markRemote } from "../src/core/caller.js";
import { cleanTitle, meaningfulTitle, piTool, safeCut, TerminalHost, terminalName, type Launcher, type TerminalEvent } from "../src/terminals/host.js";
import { DEFAULT_STYLE, parseItermFont, styleFromItermProfile } from "../src/terminals/style.js";
import { keySequence, replyBytes } from "../src/terminals/keys.js";
import type { Sealer } from "../src/secrets/sealer.js";
import { agentLauncher, claudeHookSettings, CODEX_ATTENTION, HOOK_SCRIPT, withoutParentSession } from "../src/terminals/launch.js";
import { deleteTranscript } from "../src/terminals/transcripts.js";
import { elsewhereCheck, type ElsewhereCheck, type Proc } from "../src/terminals/elsewhere.js";
import { TARGETS_PATH } from "./helpers.js";

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

const fakeLauncher = (url: () => string, hooks: boolean): Launcher => (req) => ({
  file: process.execPath,
  args: [FAKE],
  env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: url(), AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken },
  hooks,
});

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

describe("terminal host", () => {
  it("follows the program's screen and mouse modes for the wheel", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", false) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir(), cols: 80, rows: 20 });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    await until(() => text(events).includes("fake agent ready"));
    expect(host.keyContext(info.id)).toMatchObject({ mouse: "none", sgrMouse: false, alternate: false });
    host.write(info.id, "fullscreen\r");
    await until(() => text(events).includes("fullscreen on"));
    expect(host.keyContext(info.id)).toMatchObject({ mouse: "any", sgrMouse: true, alternate: true, cols: 80, rows: 20 });
    expect(keySequence("wheel-up", host.keyContext(info.id))).toBe("\x1b[<64;41;11M");
    // A screen attaching now (the desktop window opening, or switching to this terminal) is put in the same modes,
    // the mouse's SGR reporting included (the serializer alone drops it).
    const late: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => late.push(e));
    expect(late[0]?.type).toBe("snapshot");
    expect(text(late)).toContain("\x1b[?1003h");
    expect(text(late)).toContain("\x1b[?1006h");
    host.write(info.id, "normal\r");
    await until(() => text(events).includes("normal again"));
    expect(host.keyContext(info.id)).toMatchObject({ mouse: "none", sgrMouse: false, alternate: false });
    const after: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => after.push(e));
    expect(text(after)).not.toContain("\x1b[?1006h");
  });

  it("follows the kitty keyboard protocol for Shift+Enter: CSI 13;2u while it is on, a line feed otherwise", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", false) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir(), cols: 80, rows: 20 });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    await until(() => text(events).includes("fake agent ready"));
    expect(keySequence("shift-enter", host.keyContext(info.id))).toBe("\n");
    host.write(info.id, "kitty\r");
    await until(() => text(events).includes("kitty on"));
    expect(host.keyContext(info.id).kittyKeys).toBe(true);
    expect(keySequence("shift-enter", host.keyContext(info.id))).toBe("\x1b[13;2u");
    // A screen attaching now learns it from the snapshot (the Mac's native screen encodes its keys by it).
    const late: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => late.push(e));
    expect(text(late)).toContain("\x1b[>7u");
    host.write(info.id, "nokitty\r");
    await until(() => text(events).includes("kitty off"));
    expect(keySequence("shift-enter", host.keyContext(info.id))).toBe("\n");
  });

  it("runs a program in a pseudo-terminal: output, title, replies, status by activity, replay, snapshot, exit", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", false), idleAfterMs: 150 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir(), cols: 80, rows: 20 });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    await until(() => text(events).includes("fake agent ready"));
    await until(() => host.get(info.id)!.title === "fake agent");
    expect(host.get(info.id)!.name).toBe("fake agent");
    expect(events).toContainEqual({ type: "name", name: "fake agent" });
    expect(host.rename(info.id, "  my   work ").name).toBe("my work");
    expect(host.rename(info.id, "")).toMatchObject({ name: "fake agent", customName: false });

    // A reply answered at once (an echo, a redraw for what was sent) is not work; output going on is.
    await until(() => host.get(info.id)!.status === "idle");   // its start-up output was its own
    const sent = events.length;
    host.write(info.id, replyBytes("hello there", host.bracketedPaste(info.id), true));
    await until(() => text(events).includes("got: hello there"));
    expect(events.slice(sent).some((e) => e.type === "status" && e.status === "working")).toBe(false);
    host.write(info.id, "\x1b[<35;10;5M\r");   // a mouse move over a screen that tracks it (the fake reads lines)
    host.resize(info.id, 81, 20);
    await new Promise((r) => setTimeout(r, 200));
    expect(host.get(info.id)!.status).toBe("idle");
    host.write(info.id, "work\r");
    await until(() => host.get(info.id)!.status === "working");
    await until(() => text(events).includes("work done"));
    await until(() => host.get(info.id)!.status === "idle");

    // A screen that saw everything up to `seq` gets only what came after; a new one gets a snapshot first.
    const seq = host.get(info.id)!.seq;
    host.write(info.id, "again\r");
    await until(() => host.get(info.id)!.seq > seq && text(events).includes("got: again"));
    const replay: TerminalEvent[] = [];
    host.subscribe(info.id, seq, (e) => replay.push(e))();
    expect(replay[0]?.type).toBe("output");
    expect(text(replay)).toContain("got: again");
    expect(text(replay)).not.toContain("hello there");
    await new Promise((r) => setTimeout(r, 50));   // the headless terminal parses asynchronously
    const late: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => late.push(e))();
    expect(late[0]?.type).toBe("snapshot");
    expect(text(late)).toContain("got: hello there");

    host.resize(info.id, 100, 30);
    expect(host.get(info.id)).toMatchObject({ cols: 100, rows: 30 });

    host.write(info.id, "exit\r");
    await until(() => events.find((e) => e.type === "exit"));
    expect(host.get(info.id)).toMatchObject({ status: "exited", exitCode: 3 });
    expect(() => host.write(info.id, "x")).toThrow(/ended/);

    host.remove(info.id);
    expect(events.at(-1)).toEqual({ type: "removed" });
    expect(host.get(info.id)).toBeNull();
  });

  it("waits while Codex says something on its screen waits for you (its notification: an app's form is no hook)", async () => {
    for (const hooks of [false, true]) {
      let token = "";
      const launcher: Launcher = (req) => { token = req.hookToken; return fakeLauncher(() => "http://127.0.0.1:9", hooks)(req); };
      const host = new TerminalHost({ launcher, idleAfterMs: 150 });
      closers.push(() => host.closeAll());
      const info = await host.spawn({ harness: "codex", cwd: tmpdir() });
      await until(() => host.get(info.id)!.title === "fake agent");
      host.write(info.id, "form\r");
      await until(() => host.get(info.id)!.status === "waiting");
      await new Promise((r) => setTimeout(r, 400));   // it redraws and blinks while it waits, the idle time runs out: still waiting
      expect(host.get(info.id)).toMatchObject({ status: "waiting", title: "查看进程 | Codex" });   // the marker is not in the name
      if (hooks) await host.hook(info.id, token, { event: "PostToolUse", payload: { tool_name: "mcp__computer_use__open", tool_input: {} } });
      else host.write(info.id, "answered\r");
      await until(() => host.get(info.id)!.status === "working");
      if (!hooks) await until(() => host.get(info.id)!.status === "idle");
      else host.write(info.id, "answered\r");
    }
  });

  it("a permission request whose hook goes away (answered in the terminal) leaves the screens", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    const gone = new AbortController();
    const answer = host.hook(info.id, token, { event: "PermissionRequest", payload: { tool_name: "Write", tool_input: { file_path: "/tmp/x" } } }, gone.signal);
    expect(host.get(info.id)).toMatchObject({ status: "waiting", permissions: [{ tool: "Write", summary: "Write: /tmp/x" }] });
    gone.abort();
    expect(await answer).toBeNull();
    expect(host.get(info.id)).toMatchObject({ status: "working", permissions: [] });
    expect(events.some((e) => e.type === "permission_resolved" && e.decision === null)).toBe(true);
  });

  it("a screen that (re)connects gets every request waiting, whole: one answered while it was away is gone", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const ask = (file: string) => host.hook(info.id, token, { event: "PermissionRequest", payload: { tool_name: "Write", tool_input: { file_path: file } } });
    void ask("/tmp/a");
    void ask("/tmp/b");
    const [first, second] = host.get(info.id)!.permissions;
    // The phone saw both, went to the background; the Mac answered the first.
    expect(host.decide(info.id, first!.id, "allow")).toBe(true);
    const back: TerminalEvent[] = [];
    host.subscribe(info.id, host.get(info.id)!.seq, (e) => back.push(e))();
    const whole = back.find((e) => e.type === "permissions");
    expect(whole).toEqual({ type: "permissions", requests: [second] });
    expect(host.decide(info.id, first!.id, "deny")).toBe(false);   // what the phone's stale card would get: 404
  });

  it("the size belongs to the screen that set it last; a claim at the same size changes only the owner", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    const resizes = () => events.filter((e) => e.type === "resize");
    expect(resizes().at(-1)).toMatchObject({ by: null });   // each connection says who has it
    host.resize(info.id, 120, 40, "mac-1");
    host.resize(info.id, 120, 40, "mac-1");                 // nothing new
    host.resize(info.id, 120, 40, "phone-1");               // the phone takes it at the same size
    host.resize(info.id, 50, 30, "phone-1");
    expect(resizes().slice(1)).toEqual([
      { type: "resize", cols: 120, rows: 40, by: "mac-1" },
      { type: "resize", cols: 120, rows: 40, by: "phone-1" },
      { type: "resize", cols: 50, rows: 30, by: "phone-1" },
    ]);
    const late: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => late.push(e))();
    expect(late.find((e) => e.type === "resize")).toEqual({ type: "resize", cols: 50, rows: 30, by: "phone-1" });
  });

  it("the size goes back when its owner stops following (the phone went to the background)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), sizeReleaseMs: 0 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const mac: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => mac.push(e), "mac-1");
    const phoneA = host.subscribe(info.id, null, () => undefined, "phone-1");
    const phoneB = host.subscribe(info.id, null, () => undefined, "phone-1");   // a reconnect overlapping the old stream
    host.resize(info.id, 50, 30, "phone-1");
    phoneA();
    expect(host.get(info.id)).toMatchObject({ cols: 50, rows: 30 });
    expect(mac.filter((e) => e.type === "resize").at(-1)).toMatchObject({ by: "phone-1" });
    phoneB();
    expect(mac.filter((e) => e.type === "resize").at(-1)).toEqual({ type: "resize", cols: 50, rows: 30, by: null });
    // A screen that never owned it leaves quietly.
    const count = mac.length;
    host.subscribe(info.id, null, () => undefined, "web-1")();
    expect(mac.length).toBe(count);
  });

  it("a screen that comes back within the grace keeps the size (a reconnect is not leaving)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), sizeReleaseMs: 60 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const mac: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => mac.push(e), "mac-1");
    host.subscribe(info.id, null, () => undefined, "phone-1")();
    host.resize(info.id, 50, 30, "phone-1");
    host.subscribe(info.id, null, () => undefined, "phone-1")();   // dropped at once
    const back = host.subscribe(info.id, null, () => undefined, "phone-1");
    await new Promise((r) => setTimeout(r, 120));
    expect(mac.filter((e) => e.type === "resize").at(-1)).toMatchObject({ by: "phone-1" });
    back();
    await new Promise((r) => setTimeout(r, 120));
    expect(mac.filter((e) => e.type === "resize").at(-1)).toMatchObject({ by: null });
  });

  it("remembers how the last turn ended: Stop is done, StopFailure is not, a start-up idle or a repeated Stop is no turn", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const hook = (event: string, payload: Record<string, unknown> = {}) => host.hook(info.id, token, { event, payload });
    await hook("SessionStart");
    await hook("Stop");
    expect(host.lastTurn(info.id)).toBeNull();
    await hook("UserPromptSubmit");
    await hook("Stop", { last_assistant_message: "改好了，\n测试都通过。" });
    expect(host.lastTurn(info.id)).toMatchObject({ ok: true, line: "改好了， 测试都通过。" });
    await hook("UserPromptSubmit");
    await hook("StopFailure", { error: "rate_limit", error_details: "You have hit your limit" });
    expect(host.lastTurn(info.id)).toMatchObject({ ok: false, line: "rate_limit: You have hit your limit" });
    await hook("Stop");   // after the failure: no turn was running
    expect(host.lastTurn(info.id)).toMatchObject({ ok: false });
    expect(host.get(info.id)!.status).toBe("idle");
  });

  it("a program that ends on an error by itself is a failed turn; one the service ended is not", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), killGraceMs: 200 });
    closers.push(() => host.closeAll());
    const crashed = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    host.write(crashed.id, "exit\r");   // the fake agent exits with code 3
    await until(() => host.get(crashed.id)!.status === "exited");
    expect(host.lastTurn(crashed.id)).toMatchObject({ ok: false, line: "进程退出（代码 3）" });
    const closed = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    await host.stopped(closed.id);
    expect(host.get(closed.id)!.status).toBe("exited");
    expect(host.lastTurn(closed.id)).toBeNull();
  });

  it("a permission request answered in the terminal leaves the screens once the tool runs or the turn ends", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const ask = (file: string) => host.hook(info.id, token, { event: "PermissionRequest", payload: { tool_name: "Write", tool_input: { file_path: file } } });
    const first = ask("/tmp/a");
    const second = ask("/tmp/b");
    expect(host.get(info.id)!.permissions).toHaveLength(2);
    await host.hook(info.id, token, { event: "PostToolUse", payload: { tool_name: "Write", tool_input: { file_path: "/tmp/b" }, tool_response: {} } });
    expect(await second).toBeNull();
    expect(host.get(info.id)!.permissions.map((p) => p.summary)).toEqual(["Write: /tmp/a"]);
    await host.hook(info.id, token, { event: "Stop", payload: {} });
    expect(await first).toBeNull();
    expect(host.get(info.id)).toMatchObject({ status: "idle", permissions: [] });
  });

  it("remembers the tool it is using and since when it works, for the Live Activity; idle forgets the tool", async () => {
    let now = 1_000;
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), now: () => now });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    now = 5_000;
    await host.hook(info.id, token, { event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "npm   test" } } });
    expect(host.get(info.id)).toMatchObject({ status: "working", statusSince: 5_000, activity: { tool: "Bash", target: "npm test" } });
    now = 6_000;
    await host.hook(info.id, token, { event: "PreToolUse", payload: { tool_name: "Edit", tool_input: { file_path: "/w/a.ts", old_string: "x" } } });
    expect(host.get(info.id)).toMatchObject({ statusSince: 5_000, activity: { tool: "Edit", target: "/w/a.ts" } });
    now = 9_000;
    await host.hook(info.id, token, { event: "Stop", payload: {} });
    expect(host.get(info.id)).toMatchObject({ status: "idle", statusSince: 9_000, activity: null });
  });

  it("keeps the protected paths closed in every permission mode (PreToolUse)", async () => {
    const floor = (tool: string, input: Record<string, unknown>) => (tool === "Bash" && String(input.command).includes("local-token") ? "denied by AgentSwitch" : null);
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), floor });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir(), mode: "bypass" });
    expect(host.get(info.id)!.mode).toBe("bypass");
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    expect(await host.hook(info.id, token, { event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "cat ~/x/local-token" } } }))
      .toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "denied by AgentSwitch" } });
    expect(await host.hook(info.id, token, { event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "ls" } } })).toBeNull();
    expect(host.get(info.id)!.status).toBe("working");
  });

  it("owns only the session it started: a fork's new one, never the original or one `/resume`d inside it", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const tokenOf = (id: string) => (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(id)!.hookToken;
    const report = (id: string, session: string) => host.hook(id, tokenOf(id), { event: "SessionStart", payload: { session_id: session } });
    const fresh = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    await report(fresh.id, "new-1");
    await report(fresh.id, "someone-elses");   // `/resume someone-elses` typed inside it
    expect(host.get(fresh.id)!.agentSessionId).toBe("someone-elses");
    expect(host.ownSession(fresh.id)).toBe("new-1");
    const fork = await host.spawn({ harness: "claude-code", cwd: tmpdir(), resume: "orig", fork: true });
    await report(fork.id, "orig");
    expect(host.ownSession(fork.id)).toBeNull();
    await report(fork.id, "fork-1");
    expect(host.ownSession(fork.id)).toBe("fork-1");
    const same = await host.spawn({ harness: "claude-code", cwd: tmpdir(), resume: "orig" });
    await report(same.id, "orig");
    expect(host.ownSession(same.id)).toBeNull();
  });

  it("refuses a hook call with the wrong token, and a launcher that cannot start the agent", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    await expect(host.hook(info.id, "not-the-token", { event: "Stop", payload: {} })).rejects.toThrow(/hook token/);
    const broken = new TerminalHost({ launcher: () => { throw new Error("codex is not installed on this Mac"); } });
    await expect(broken.spawn({ harness: "codex", cwd: tmpdir() })).rejects.toThrow(/not installed/);
  });
});

describe("terminals over HTTP", () => {
  async function start(elsewhere?: ElsewhereCheck) {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-terminals-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-terminal-cwd-"));
    let base = "";
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const daemon = buildDaemon(cfg, { terminalLauncher: fakeLauncher(() => base, true), ...(elsewhere ? { terminalElsewhere: elsewhere } : {}) });
    const token = ensureLocalToken(home);
    const port = await new Promise<number>((done) => {
      const server = listenLocal(daemon, 0, (info: AddressInfo) => done(info.port), new LocalAuth(token));
      closers.push(() => { server.close(); daemon.close(); });
    });
    daemon.setLocalPort(port);
    base = `http://127.0.0.1:${port}`;
    const call = async (method: string, path: string, body?: unknown, auth = true) => {
      const res = await fetch(base + path, { method, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    return { home, cwd, base, token, call, daemon };
  }

  /** The SSE stream read into `events` until `stop()`. */
  function follow(base: string, token: string, id: string) {
    const events: { event: string; data: any }[] = [];
    const ctl = new AbortController();
    void (async () => {
      const res = await fetch(`${base}/terminals/${id}/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    })().catch(() => undefined);
    closers.push(() => ctl.abort());
    return events;
  }

  it("start, stream, reply, a permission request through the hook answered from the API, audit, delete", async () => {
    const { home, cwd, base, token, call } = await start();
    expect((await call("GET", "/terminals", undefined, false)).status).toBe(401);
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd: "relative/dir" })).status).toBe(400);

    const listed0 = await call("GET", "/terminals");
    expect(listed0.json).toMatchObject({ terminals: [], agents: ["claude-code", "codex", "opencode", "pi"] });
    // Each agent's models for the new terminal's menu, as people say them; pi has no catalog.
    expect(Object.keys(listed0.json.models)).toEqual(["claude-code", "codex", "opencode", "pi"]);
    expect(listed0.json.models.pi).toEqual([]);
    for (const m of Object.values(listed0.json.models).flat() as { id: string; name: string }[]) expect(m.name.length).toBeGreaterThan(0);
    // A model id goes to the agent as `--model <id>`: nothing that reads as a flag.
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd, model: "--dangerously-skip-permissions" })).status).toBe(400);
    expect((await call("GET", "/terminals/style")).json).toHaveProperty("theme.background");
    const created = await call("POST", "/terminals", { harness: "claude-code", cwd, cols: 90, rows: 24 });
    expect(created.status).toBe(201);
    const id = created.json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    await until(() => screen().includes("fake agent ready"));

    // `/` on the phone: this agent's commands in the terminal's folder (a command file of the project's among them).
    mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "commands", "ship.md"), "---\ndescription: Ship it\n---\nbody");
    const commands = (await call("GET", `/terminals/${id}/commands`)).json.commands as { name: string; source: string }[];
    expect(commands).toContainEqual(expect.objectContaining({ name: "ship", source: "project" }));
    expect(commands.some((c) => c.name === "compact" && c.source === "builtin")).toBe(true);
    expect((await call("GET", "/terminals/nope/commands")).status).toBe(404);

    expect((await call("POST", `/terminals/${id}/input`, { text: "hi from the phone" })).status).toBe(200);
    await until(() => screen().includes("got: hi from the phone"));
    // An empty line (⌃C here would really interrupt the agent: the terminal sends it SIGINT).
    expect((await call("POST", `/terminals/${id}/keys`, { keys: ["enter"] })).status).toBe(200);
    expect((await call("POST", `/terminals/${id}/keys`, { keys: ["rm -rf"] })).status).toBe(400);

    // The hook route takes the terminal's own hook token, never the local one, and not someone else's.
    const forged = await fetch(`${base}/terminals/hook`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id }, body: JSON.stringify({ event: "Stop", payload: {} }) });
    expect(forged.status).toBe(403);

    // "perm": the fake agent runs the real hook command with a PermissionRequest; it waits for a screen's answer.
    await call("POST", `/terminals/${id}/input`, { text: "perm" });
    const asked = await until(() => events.find((e) => e.event === "permission"));
    expect(asked.data.request).toMatchObject({ tool: "Bash", summary: "Bash: rm -rf build" });
    const listed = await call("GET", `/terminals/${id}`);
    expect(listed.json.terminal).toMatchObject({ status: "waiting", agentSessionId: "11111111-2222-3333-4444-555555555555" });
    const pid = asked.data.request.id as string;
    expect((await call("POST", `/terminals/${id}/permissions/${pid}`, { decision: "allow" })).status).toBe(200);
    await until(() => screen().includes("answer: "));
    expect(screen()).toContain('"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}');
    expect((await call("POST", `/terminals/${id}/permissions/${pid}`, { decision: "deny" })).status).toBe(404);
    expect((await call("PATCH", `/terminals/${id}`, { name: "发布前检查" })).json.terminal.name).toBe("发布前检查");

    const audit = readFileSync(join(home, "terminals", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.map((a) => a.action)).toEqual(["create", "input", "keys", "input", "permission", "rename"]);
    expect(audit[1]).toMatchObject({ via: "local", detail: { length: 17, sealed: 0 } });
    expect(JSON.stringify(audit)).not.toContain("hi from the phone");

    expect((await call("DELETE", `/terminals/${id}`)).status).toBe(200);
    await until(() => events.find((e) => e.event === "removed"));
    expect((await call("GET", `/terminals/${id}`)).status).toBe(404);
  });

  it("attaches a file: staged, moved out of the project, its path pasted into the prompt without sending; gone with the terminal", async () => {
    const { base, token, call } = await start();
    const created = await call("POST", "/terminals", { harness: "claude-code", cwd: tmpdir() });
    const id = created.json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    await until(() => screen().includes("fake agent ready"));
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "my shot.png");
    const staged = await (await fetch(`${base}/uploads`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form })).json() as { files: { id: string }[] };
    expect((await call("POST", `/terminals/${id}/attach`, { uploads: ["nope-nope-nop"] })).status).toBe(400);
    const attached = await call("POST", `/terminals/${id}/attach`, { uploads: [staged.files[0]!.id] });
    expect(attached.status).toBe(200);
    const file = attached.json.files[0] as { name: string; path: string };
    expect(file.name).toBe("my-shot.png");
    expect(file.path).toBe(join(tmpdir(), "agentswitch-attach", id, "my-shot.png"));
    expect(existsSync(file.path)).toBe(true);
    await until(() => screen().includes("my-shot.png"));
    expect(screen()).not.toContain("got: ");   // pasted, not sent
    expect((await call("DELETE", `/terminals/${id}`)).status).toBe(200);
    expect(existsSync(join(tmpdir(), "agentswitch-attach", id))).toBe(false);
  });

  it("a terminal opens in any folder, the home folder too, and reads the local token; tasks keep their rules (2026-09-30)", async () => {
    const { home, call, daemon } = await start();
    const created = await call("POST", "/terminals", { harness: "claude-code", cwd: "~" });
    expect(created.status).toBe(201);
    expect(created.json.terminal.cwd).toBe(homedir());
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd: join(home, "no-such-folder") })).status).toBe(400);
    const host = daemon.terminals!;
    const id = created.json.terminal.id as string;
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(id)!.hookToken;
    const pre = (tool: string, input: Record<string, unknown>) => host.hook(id, token, { event: "PreToolUse", payload: { tool_name: tool, tool_input: input } });
    expect(await pre("Bash", { command: `cat "${join(home, "local-token")}"` })).toBeNull();
    expect(await pre("Edit", { file_path: join(home, "CONTEXT.md") })).toBeNull();
    expect(await pre("Read", { file_path: join(home, "browser-profiles", "slot-1", "Cookies") })).toBeNull();
    const gate = process.env.SECRET_GATE_HOME ?? join(homedir(), ".secret-gate");
    expect(await pre("Read", { file_path: join(gate, "keys", "default.key") })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("bypass can be chosen from a paired device too (the phone asks first); every terminal may switch to it later", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-terminals-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-terminal-cwd-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const daemon = buildDaemon(cfg, { terminalLauncher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => daemon.close());
    const post = (body: unknown, env?: object) => daemon.api.request("/terminals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
    const fromPhone = await post({ harness: "claude-code", cwd, mode: "bypass" }, markRemote({}, { deviceId: "phone" }));
    expect(fromPhone.status).toBe(201);
    expect(((await fromPhone.json()) as { terminal: { mode: string } }).terminal.mode).toBe("bypass");
    const fromMac = await post({ harness: "claude-code", cwd, mode: "bypass" });
    expect(((await fromMac.json()) as { terminal: { mode: string } }).terminal.mode).toBe("bypass");
  });

  it("a reply is sealed unless sent directly, as typed", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-terminals-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-terminal-cwd-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const TOKEN = "enc:v1:" + "S".repeat(40);
    const sealer: Sealer = async (text) => ({ ok: true, text: text.split("hunter2").join(TOKEN), sealed: text.includes("hunter2") ? [{ label: "x/pw", field: "password", kind: "secret", hosts: ["x.com"], uses: ["http"], token: TOKEN }] : [], ms: 1 });
    const daemon = buildDaemon(cfg, { terminalLauncher: fakeLauncher(() => "http://127.0.0.1:9", false), sealer });
    closers.push(() => daemon.close());
    const req = (path: string, body: unknown) => daemon.api.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, markRemote({}, { deviceId: "phone" }));
    const created = (await (await req("/terminals", { harness: "codex", cwd })).json()) as { terminal: { id: string } };
    const id = created.terminal.id;
    const events: TerminalEvent[] = [];
    daemon.terminals!.subscribe(id, null, (e) => events.push(e));
    await until(() => text(events).includes("fake agent ready"));
    expect(await (await req(`/terminals/${id}/input`, { text: "pw hunter2" })).json()).toEqual({ ok: true, sealed: 1 });
    await until(() => text(events).includes(`got: pw ${TOKEN}`));
    expect(await (await req(`/terminals/${id}/input`, { text: "ls -la", seal: false })).json()).toEqual({ ok: true, sealed: 0 });
    await until(() => text(events).includes("got: ls -la"));
  });

  it("continues a session in place, once: the same terminal again, a session open elsewhere refused unless forked", async () => {
    const asked: string[] = [];
    const { cwd, call } = await start(async (harness, id) => {
      asked.push(`${harness}:${id}`);
      return id === "busy" ? { pid: 4242, app: "iTerm2" } : null;
    });
    const first = await call("POST", "/terminals/resume", { harness: "claude-code", cwd, agentSessionId: "s-1", title: "发布前检查" });
    expect(first.status).toBe(201);
    expect(first.json.terminal).toMatchObject({ resumedFrom: "s-1", agentSessionId: "s-1", forked: false, name: "发布前检查" });
    // Already open here: that terminal, not a second writer.
    const again = await call("POST", "/terminals/resume", { harness: "claude-code", cwd, agentSessionId: "s-1" });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, terminal: { id: first.json.terminal.id } });
    expect(asked).toEqual(["claude-code:s-1"]);

    const busy = await call("POST", "/terminals/resume", { harness: "codex", cwd, agentSessionId: "busy" });
    expect(busy.status).toBe(409);
    expect(busy.json).toMatchObject({ error: "会话正在iTerm2中运行", elsewhere: { pid: 4242, app: "iTerm2" } });
    const forked = await call("POST", "/terminals/resume", { harness: "codex", cwd, agentSessionId: "busy", fork: true });
    expect(forked.status).toBe(201);
    expect(forked.json.terminal).toMatchObject({ resumedFrom: "busy", forked: true, agentSessionId: null });

    // A session id goes after `--resume`: nothing that reads as a flag; no fork or resume an agent cannot do.
    expect((await call("POST", "/terminals/resume", { harness: "claude-code", cwd, agentSessionId: "--dangerously-skip-permissions" })).status).toBe(400);
    expect((await call("POST", "/terminals/resume", { harness: "opencode", cwd, agentSessionId: "ses_1", fork: true })).status).toBe(400);
    expect((await call("POST", "/terminals/resume", { harness: "pi", cwd, agentSessionId: "p-1" })).status).toBe(400);
    // `dir/` and `dir` are one folder.
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd: `${cwd}/` })).json.terminal.cwd).toBe(cwd);

    // Closing the terminal that went on writing the original never deletes the original.
    expect((await call("DELETE", `/terminals/${first.json.terminal.id}?transcript=1`)).status).toBe(409);
    expect((await call("DELETE", `/terminals/${first.json.terminal.id}`)).status).toBe(200);
  });

  it("a permission request nobody answers ends with no decision when the terminal goes", async () => {
    const { cwd, base, token, call } = await start();
    const id = (await call("POST", "/terminals", { harness: "claude-code", cwd })).json.terminal.id as string;
    const events = follow(base, token, id);
    await until(() => events.find((e) => e.event === "snapshot" || e.event === "output"));
    await call("POST", `/terminals/${id}/input`, { text: "perm" });
    await until(() => events.find((e) => e.event === "permission"));
    await call("POST", `/terminals/${id}/kill`);
    await until(() => events.find((e) => e.event === "permission_resolved" && e.data.decision === null));
    await until(() => events.find((e) => e.event === "exit"));
  });
});

describe("terminal pieces", () => {
  it("cuts output only between escape sequences", () => {
    expect(safeCut("plain text")).toBe(10);
    expect(safeCut("ab\x1b[27;2H")).toBe(9);
    expect(safeCut("ab\x1b[27;")).toBe(2);
    expect(safeCut("ab\x1b")).toBe(2);
    expect(safeCut("ab\x1b]0;title")).toBe(2);
    expect(safeCut("ab\x1b]0;title\x07cd")).toBe(14);
    expect(safeCut("ab\x1b]0;title\x1b\\")).toBe(13);
    expect(safeCut("ab\x1b]0;tit\x1b")).toBe(2);
    expect(safeCut("x\x1b[1mbold\x1b[")).toBe(9);
    expect(safeCut("ab\x1b(")).toBe(2);
    expect(safeCut("ab\x1b(B")).toBe(5);
    expect(safeCut("ab\x1b7")).toBe(4);
  });

  it("names a terminal: the user's name, else the agent's task title without its status glyphs, else the folder", () => {
    expect(cleanTitle("✳ Claude Code")).toBe("Claude Code");
    expect(cleanTitle("✶  创建 hello.txt 文件")).toBe("创建 hello.txt 文件");
    expect(cleanTitle("⠋ Working")).toBe("Working");
    expect(cleanTitle("[ ! ] Action Required | 查看进程 | Codex")).toBe("查看进程 | Codex");
    expect(cleanTitle("[ . ] Action Required")).toBe("");
    expect(meaningfulTitle("✳ Claude Code", "claude-code")).toBeNull();
    expect(meaningfulTitle("codex", "codex")).toBeNull();
    expect(meaningfulTitle("me@mac: ~/proj", "claude-code")).toBeNull();
    expect(meaningfulTitle("✻ 修复登录页的样式", "claude-code")).toBe("修复登录页的样式");
    expect(terminalName(null, "✳ Claude Code", "claude-code", "/Users/me/Projects/AgentSwitch")).toBe("AgentSwitch");
    expect(terminalName(null, "✻ 修复登录页", "claude-code", "/Users/me/Projects/AgentSwitch")).toBe("修复登录页");
    expect(terminalName("发布前检查", "✻ 修复登录页", "claude-code", "/x")).toBe("发布前检查");
    expect(terminalName(null, "✳ Claude Code", "claude-code", "/x/proj", "接着上次的重构")).toBe("接着上次的重构");
    expect(terminalName(null, "✻ 新任务", "claude-code", "/x/proj", "接着上次的重构")).toBe("新任务");
  });

  it("takes the iTerm2 profile's font, spacing and dark colors", () => {
    expect(parseItermFont("MesloLGS-NF-Regular 15")).toEqual({ families: ["MesloLGS NF", "MesloLGS-NF-Regular"], size: 15 });
    expect(parseItermFont("SFMono-Regular 12.5")).toEqual({ families: ["SF Mono", "SFMono-Regular"], size: 12.5 });
    expect(parseItermFont("nonsense")).toBeNull();
    const c = (r: number, g: number, b: number) => ({ "Red Component": String(r), "Green Component": g, "Blue Component": b });
    const style = styleFromItermProfile({
      "Normal Font": "MesloLGS-NF-Regular 15", "Vertical Spacing": 1, "Horizontal Spacing": 1, "Use Separate Colors for Light and Dark Mode": true,
      "Background Color": c(1, 1, 1), "Background Color (Dark)": c(0, 0, 0), "Foreground Color (Dark)": c(1, 1, 1),
      "Ansi 1 Color (Dark)": c(0.8, 0, 0), "Selection Color (Dark)": c(0.71, 0.835, 1),
    });
    expect(style).toMatchObject({ source: "iterm", fontSize: 15, lineHeight: 1, letterSpacing: 0 });
    expect(style.fontFamily.startsWith('"MesloLGS NF", "MesloLGS-NF-Regular", "SF Mono"')).toBe(true);
    expect(style.theme).toMatchObject({ background: "#000000", foreground: "#ffffff", red: "#cc0000", selectionBackground: "rgba(181,213,255,0.4)", blue: DEFAULT_STYLE.theme.blue });
  });

  it("keys follow the cursor mode; a reply is pasted as one block when the program asks for it", () => {
    const plain = { applicationCursor: false, mouse: "none", sgrMouse: false, alternate: false, cols: 80, rows: 24 } as const;
    expect(keySequence("up", plain)).toBe("\x1b[A");
    expect(keySequence("up", { ...plain, applicationCursor: true })).toBe("\x1bOA");
    expect(keySequence("ctrl-c", plain)).toBe("\x03");
    expect(keySequence("pgup", plain)).toBe("\x1b[5~");
    // The wheel: a mouse report in the middle when the program tracks the mouse, an arrow on a full screen without it,
    // nothing on the normal screen (the screen scrolls its own history).
    expect(keySequence("wheel-up", { ...plain, mouse: "any", sgrMouse: true })).toBe("\x1b[<64;41;13M");
    expect(keySequence("wheel-down", { ...plain, mouse: "vt200" })).toBe("\x1b[M" + String.fromCharCode(32 + 65, 32 + 41, 32 + 13));
    expect(keySequence("wheel-down", { ...plain, alternate: true, applicationCursor: true })).toBe("\x1bOB");
    expect(keySequence("wheel-up", plain)).toBe("");
    expect(replyBytes("a\nb", true, true)).toBe("\x1b[200~a\nb\x1b[201~\r");
    expect(replyBytes("a\nb", false, true)).toBe("a\rb\r");
    expect(replyBytes("x\x1b[201~y", true, false)).toBe("\x1b[200~xy\x1b[201~");
  });

  it("launches Claude Code with this terminal's own hooks and Codex with notify; a missing agent cannot start", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-launch-"));
    const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex" }, gate: null, hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", env: { PATH: "/usr/bin", SECRET_GATE_REPAIR_KEY: "k" } });
    const claude = launch({ id: "t1", harness: "claude-code", cwd: "/tmp", model: "claude-opus-5-5", mode: "manual", hookToken: "tok" });
    expect(claude.args).toEqual(["--settings", join(stateDir, "t1", "settings.json"), "--model", "claude-opus-5-5", "--permission-mode", "manual"]);
    expect(launch({ id: "t5", harness: "claude-code", cwd: "/tmp", mode: "auto", hookToken: "tok" }).args.slice(-2)).toEqual(["--permission-mode", "auto"]);
    expect(launch({ id: "t6", harness: "claude-code", cwd: "/tmp", mode: "bypass", hookToken: "tok" }).args.slice(-1)).toEqual(["--dangerously-skip-permissions"]);
    expect(launch({ id: "t8", harness: "claude-code", cwd: "/tmp", mode: "auto", allowBypass: true, hookToken: "tok" }).args.slice(-3)).toEqual(["--permission-mode", "auto", "--allow-dangerously-skip-permissions"]);
    expect(launch({ id: "t7", harness: "codex", cwd: "/tmp", mode: "bypass", hookToken: "tok" }).args).toContain("--dangerously-bypass-approvals-and-sandbox");
    // asking is stated, not left to the user's config.toml
    expect(launch({ id: "t8", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok" }).args.join(" ")).toContain('-a on-request -c default_permissions="agentswitch" -c permissions.agentswitch={ extends = ":read-only", filesystem = {} }');
    expect(claude.env).toMatchObject({ AGENTSWITCH_TERMINAL_ID: "t1", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "tok", AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:4711", TERM: "xterm-256color" });
    expect(claude.env.SECRET_GATE_REPAIR_KEY).toBeUndefined();
    const settings = JSON.parse(readFileSync(join(stateDir, "t1", "settings.json"), "utf8"));
    expect(settings).toEqual(claudeHookSettings('"/n/node" "/h/hook.js"'));
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(1800);
    // "Continue" goes on in the same session; a fork only when asked for.
    const codex = launch({ id: "t2", harness: "codex", cwd: "/tmp", resume: "abc", mode: "manual", hookToken: "tok" });
    expect(codex.args).toEqual(["resume", "abc", "-c", 'notify=["/n/node","/h/hook.js","codex"]', ...CODEX_ATTENTION, "-a", "on-request", "-c", 'default_permissions="agentswitch"', "-c", 'permissions.agentswitch={ extends = ":read-only", filesystem = {} }']);
    expect(launch({ id: "t9", harness: "codex", cwd: "/tmp", resume: "abc", fork: true, mode: "manual", hookToken: "tok" }).args.slice(0, 2)).toEqual(["fork", "abc"]);
    expect(launch({ id: "t4", harness: "claude-code", cwd: "/tmp", resume: "s-1", mode: "manual", hookToken: "tok" }).args.slice(-2)).toEqual(["--resume", "s-1"]);
    expect(launch({ id: "t10", harness: "claude-code", cwd: "/tmp", resume: "s-1", fork: true, mode: "manual", hookToken: "tok" }).args.slice(-3)).toEqual(["--resume", "s-1", "--fork-session"]);
    expect(() => launch({ id: "t3", harness: "pi", cwd: "/tmp", mode: "manual", hookToken: "tok" })).toThrow(/not installed/);
  });

  it("refuses the protected paths each agent's own way: Claude's deny rules, Codex's profile, OpenCode's config, pi's extension", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-launch-"));
    const prot = { roots: ["/as/home", "/as/gate"], exempt: [], readDenied: ["/as/gate", "/as/home/local-token"] };
    const gate = { bin: "/g/bin", home: "/as/gate", proxy: "http://127.0.0.1:8080", playwrightVersion: "1", allowedOrigins: [] };
    const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex", opencode: "/bin/opencode", pi: "/bin/pi" }, gate, protected: prot,
      hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", piExtension: "/h/pi.ts", env: { PATH: "/usr/bin", HOME: "/Users/u" } });
    // Claude Code: its own deny rules besides the PreToolUse floor ("//" = from the filesystem root).
    launch({ id: "c1", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    const settings = JSON.parse(readFileSync(join(stateDir, "c1", "settings.json"), "utf8"));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(//as/home/local-token)", "Read(//as/gate/**)", "Edit(//as/home/**)"]));
    // Codex: a profile its sandbox enforces; the gate's proxy only for the commands it runs, not for Codex itself.
    const codex = launch({ id: "x1", harness: "codex", cwd: "/tmp", mode: "auto", hookToken: "tok" });
    expect(codex.args).toContain('permissions.agentswitch={ extends = ":workspace", filesystem = { "/as/home" = "read", "/as/gate" = "deny", "/as/home/local-token" = "deny" } }');
    // With its hooks the reads are the PreToolUse floor's: a deny entry would keep an approved command sandboxed.
    const hooked = agentLauncher({ binaries: { codex: "/bin/codex" }, gate, protected: prot, hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", env: {}, codexHooks: () => true });
    expect(hooked({ id: "x2", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok" }).args).toContain('permissions.agentswitch={ extends = ":read-only", filesystem = { "/as/home" = "read", "/as/gate" = "read" } }');
    expect(codex.args).not.toContain("-s");
    expect(codex.args.find((a) => a.startsWith("shell_environment_policy.set="))).toContain('"HTTPS_PROXY" = "http://127.0.0.1:8080"');
    expect(codex.env.HTTPS_PROXY).toBeUndefined();
    expect(codex.env.AGENTSWITCH_TERMINAL_ID).toBe("x1");
    // OpenCode: only refusals, the user's other permission settings untouched.
    const opencode = launch({ id: "o1", harness: "opencode", cwd: "/tmp", mode: "auto", hookToken: "tok" });
    expect(opencode.env.OPENCODE_CONFIG).toBe(join(stateDir, "o1", "opencode.json"));
    expect(opencode.args[0]).toBe("--standalone");   // not the user's shared background service, which never sees this env
    const config = JSON.parse(readFileSync(opencode.env.OPENCODE_CONFIG!, "utf8"));
    expect(config.permission.read).toMatchObject({ "/as/home/local-token": "deny", "/as/gate/*": "deny" });
    expect(config.permission.bash).toMatchObject({ "*/as/home*": "deny", "*/as/gate*": "deny" });   // a root covers what is in it
    expect(Object.values(config.permission).flatMap((rules) => Object.values(rules as object))).not.toContain("allow");
    // pi: AgentSwitch's extension, which also gives the status.
    const pi = launch({ id: "p1", harness: "pi", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(pi.args.slice(0, 2)).toEqual(["--extension", "/h/pi.ts"]);
    expect(pi.hooks).toBe(true);
  });

  it("checks pi's tool calls against the floor under Claude Code's names; its agent start and end give the status", async () => {
    const floor = (tool: string, input: Record<string, unknown>) =>
      (String(input.file_path ?? input.path ?? input.command ?? "").includes("local-token") ? `denied ${tool}` : null);
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), floor });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "pi", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const tool = (name: string, input: object) => host.hook(info.id, token, { event: "PiToolCall", payload: { tool: name, input } });
    expect(await tool("read", { path: "/x/local-token" })).toEqual({ block: true, reason: "denied Read" });
    expect(await tool("write", { path: "/x/local-token", content: "" })).toEqual({ block: true, reason: "denied Write" });
    expect(await tool("bash", { command: "cat /x/local-token" })).toEqual({ block: true, reason: "denied Bash" });
    expect(await tool("ls", { path: "/x" })).toBeNull();
    expect(piTool("edit", { path: "/a" })).toEqual({ tool: "Edit", input: { path: "/a", file_path: "/a" } });
    expect(piTool("find", { path: "/a", pattern: "*.ts" }).tool).toBe("Glob");
    await host.hook(info.id, token, { event: "PiAgentEnd", payload: {} });
    expect(host.get(info.id)!.status).toBe("idle");
    await host.hook(info.id, token, { event: "PiAgentStart", payload: {} });
    expect(host.get(info.id)!.status).toBe("working");
    await host.hook(info.id, token, { event: "PiWaiting", payload: {} });
    expect(host.get(info.id)!.status).toBe("waiting");
    await host.hook(info.id, token, { event: "PiAgentStart", payload: {} });
    expect(host.get(info.id)!.status).toBe("working");
  });

  it("pi's extension blocks what the service refuses, and everything when the service does not answer", async () => {
    const { default: extension } = await import("../src/terminals/piExtension.js");
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
    extension({ on: (event, handler) => handlers.set(event, handler) });
    const calls: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        calls.push({ auth: req.headers.authorization, terminal: req.headers["x-agentswitch-terminal"], ...JSON.parse(body) });
        const refused = JSON.stringify(JSON.parse(body).payload?.input ?? {}).includes("local-token");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ output: refused ? { block: true, reason: "受保护" } : null }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    const saved = { ...process.env };
    closers.push(() => { process.env = saved; });
    Object.assign(process.env, { AGENTSWITCH_TERMINAL_URL: `http://127.0.0.1:${port}`, AGENTSWITCH_TERMINAL_ID: "p1", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "tok" });
    const toolCall = handlers.get("tool_call")!;
    expect(await toolCall({ toolName: "read", input: { path: "/x/local-token" } })).toEqual({ block: true, reason: "受保护" });
    expect(await toolCall({ toolName: "read", input: { path: "/x/readme" } })).toBeUndefined();
    expect(calls[0]).toMatchObject({ auth: "Bearer tok", terminal: "p1", event: "PiToolCall", payload: { tool: "read" } });
    process.env.AGENTSWITCH_TERMINAL_URL = "http://127.0.0.1:9";   // nothing listens there
    expect(await toolCall({ toolName: "read", input: { path: "/x/readme" } })).toMatchObject({ block: true });
  });

  it("finds a session open in another program, and the app it runs in; not one of ours, not a stale entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-elsewhere-"));
    const sessions = join(home, ".claude", "sessions");
    const locks = join(home, ".codex", "thread-writer-locks");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(locks, { recursive: true });
    const entry = (pid: number, sessionId: string) => writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: "/w", kind: "interactive" }));
    entry(100, "in-iterm");
    entry(200, "in-ours");
    entry(300, "gone");
    entry(400, "reused");
    writeFileSync(join(locks, "thread-1.lock"), "");
    const table = new Map<number, Proc>([
      [100, { ppid: 90, comm: "claude" }], [90, { ppid: 80, comm: "-zsh" }], [80, { ppid: 70, comm: "/Users/u/Library/Application Support/iTerm2/iTermServer-3.7.3" }],
      [70, { ppid: 1, comm: "/Applications/iTerm.app/Contents/MacOS/iTerm2" }],
      [200, { ppid: 210, comm: "/Users/u/.local/bin/claude" }], [210, { ppid: 1, comm: "node" }],
      [400, { ppid: 1, comm: "/Applications/Safari.app/Contents/MacOS/Safari" }],
      [500, { ppid: 510, comm: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" }],
      [510, { ppid: 1, comm: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }],
    ]);
    const check = elsewhereCheck({
      home, processes: async () => table, alive: (pid) => pid !== 300,
      holders: async (file) => (file.endsWith("thread-1.lock") ? [500] : []),
      appName: async (bundle) => ({ "/Applications/iTerm.app": "iTerm2" } as Record<string, string>)[bundle] ?? null,
    });
    expect(await check("claude-code", "in-iterm", [])).toEqual({ pid: 100, app: "iTerm2" });
    expect(await check("claude-code", "in-ours", [210])).toBeNull();          // our terminal's process tree
    expect(await check("claude-code", "gone", [])).toBeNull();                // exited without removing its entry
    expect(await check("claude-code", "reused", [])).toBeNull();              // its pid now belongs to another program
    expect(await check("claude-code", "nobody", [])).toBeNull();
    expect(await check("codex", "thread-1", [])).toEqual({ pid: 500, app: "ChatGPT" });   // Codex's desktop app holds its lock
    expect(await check("codex", "thread-2", [])).toBeNull();
    expect(await check("opencode", "in-iterm", [])).toBeNull();
  });

  it("drops the markers of a Claude Code session the service was started from, keeps the user's own settings", () => {
    expect(withoutParentSession({ CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_PID: "9",
      ANTHROPIC_BASE_URL: "http://x", CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/usr/bin" }))
      .toEqual({ ANTHROPIC_BASE_URL: "http://x", CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/usr/bin" });
  });

  it("the phone gets every terminal route but the hook and raw keystrokes", () => {
    expect(remoteAllowed("GET", "/terminals")).toBe(true);
    expect(remoteAllowed("GET", "/terminals/ab12cd34/stream")).toBe(true);
    expect(remoteAllowed("POST", "/terminals/ab12cd34/permissions/p1")).toBe(true);
    expect(remoteAllowed("DELETE", "/terminals/ab12cd34")).toBe(true);
    expect(remoteAllowed("POST", "/terminals/hook")).toBe(false);
    expect(remoteAllowed("POST", "/terminals/ab12cd34/write")).toBe(false);
  });

  it("deletes a Claude Code transcript by its session id only", () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-transcripts-"));
    const dir = join(home, ".claude", "projects", "-Users-me-proj");
    mkdirSync(dir, { recursive: true });
    const id = "11111111-2222-3333-4444-555555555555";
    writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
    writeFileSync(join(dir, "other.jsonl"), "{}\n");
    expect(deleteTranscript("claude-code", "../other", home)).toEqual([]);
    expect(deleteTranscript("codex", id, home)).toEqual([]);
    expect(deleteTranscript("claude-code", id, home)).toEqual([join(dir, `${id}.jsonl`)]);
    expect(existsSync(join(dir, "other.jsonl"))).toBe(true);
  });
});
