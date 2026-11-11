/** A shell in a terminal (docs/terminal-v0.md §0, 2026-11-10): the user's own, started on this Mac only. It is no
 *  agent — nothing speaks for it, its status is never guessed — and to a paired device or another node there is none:
 *  not in the list, none to start, none to read, type into or end. */

import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { remoteAllowed } from "../src/remote/routes.js";
import { SHELL, TerminalHost, terminalName, type Launcher, type TerminalEvent } from "../src/terminals/host.js";
import { agentLauncher, HOOK_SCRIPT, userShell, withTextLocale } from "../src/terminals/launch.js";
import { TARGETS_PATH } from "./helpers.js";

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

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

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
/** An agent's stand-in, as the terminals' own tests start one. */
const fakeAgent: Launcher = (req) => ({
  file: process.execPath, args: [FAKE], hooks: true,
  env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:9", AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken },
});

/** The real launcher, its shell a plain `sh` (whatever the machine's own is, and whatever its start-up files do). */
const launcher = (env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, PS1: "$ ", ENV: "" }): Launcher =>
  agentLauncher({ binaries: {}, hookUrl: () => "http://127.0.0.1:9", stateDir: mkdtempSync(join(tmpdir(), "agentswitch-shell-state-")), shell: "/bin/sh", env });

describe("a shell's launch", () => {
  it("is a login shell in the service's environment, with none of the terminal's hook variables", () => {
    const plan = launcher({ PATH: "/usr/bin:/bin", HOME: "/Users/u", LANG: "zh_CN.UTF-8", CLAUDECODE: "1" })({ id: "t1", harness: SHELL, cwd: "/tmp", mode: "manual", hookToken: "secret-token" });
    expect(plan.file).toBe("/bin/sh");
    expect(plan.args).toEqual(["-l"]);
    expect(plan.env).toMatchObject({ PATH: "/usr/bin:/bin", HOME: "/Users/u", LANG: "zh_CN.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor" });
    // What runs in it cannot speak for it: it is given no way to.
    expect(Object.keys(plan.env).filter((k) => k.startsWith("AGENTSWITCH_TERMINAL"))).toEqual([]);
    expect(JSON.stringify(plan.env)).not.toContain("secret-token");
    // Nor is it told it runs inside an agent's session (the service may have been started from one).
    expect(plan.env.CLAUDECODE).toBeUndefined();
    // Its status is not guessed from what it prints.
    expect(plan.hooks).toBe(true);
    expect(plan.companion).toBeUndefined();
  });

  it("reads UTF-8 where the environment names no locale, and leaves a named one alone", () => {
    expect(withTextLocale({ PATH: "/bin" })).toEqual({ PATH: "/bin", LC_CTYPE: "UTF-8" });
    for (const named of [{ LANG: "en_US.UTF-8" }, { LC_ALL: "C" }, { LC_CTYPE: "zh_CN.UTF-8" }]) expect(withTextLocale(named)).toEqual(named);
  });

  it("is the user's own shell: a program that is there", () => {
    const file = userShell({ SHELL: "/no/such/shell" });
    expect(isAbsolute(file)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("is called what it is until it is named or names what runs in it", () => {
    expect(terminalName(null, "", SHELL, "/Users/u/code/site")).toBe("Shell");
    expect(terminalName(null, "u@mac: ~/code/site", SHELL, "/Users/u/code/site")).toBe("Shell");
    expect(terminalName(null, "-zsh", SHELL, "/Users/u/code/site")).toBe("Shell");
    expect(terminalName(null, "vim notes.md", SHELL, "/Users/u/code/site")).toBe("vim notes.md");
    expect(terminalName("deploy", "vim notes.md", SHELL, "/Users/u/code/site")).toBe("deploy");
    // An agent's is its folder's name, as before.
    expect(terminalName(null, "", "codex", "/Users/u/code/site")).toBe("site");
  });
});

describe("a shell in the host", () => {
  it("runs what is typed, stays idle whatever it prints, and nothing speaks for it", async () => {
    let token = "";
    const real = launcher();
    const host = new TerminalHost({ launcher: (req) => { token = req.hookToken; return real(req); }, idleAfterMs: 100, choiceLookMs: 30 });
    closers.push(() => host.closeAll());
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-shell-cwd-")));
    const info = await host.spawn({ harness: SHELL, cwd, cols: 80, rows: 20 });
    expect(info).toMatchObject({ harness: "shell", status: "idle", name: "Shell", agentSessionId: null, model: null });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    host.write(info.id, "echo sum-$((40+2)) && pwd\r");
    await until(() => text(events).includes("sum-42"));
    await until(() => text(events).includes(cwd));
    // Printing is not work: an agent without hooks would be `working` now. (A screen is told it is idle as it joins.)
    await new Promise((r) => setTimeout(r, 150));
    expect(events.flatMap((e) => (e.type === "status" ? [e.status] : [])).filter((status) => status !== "idle")).toEqual([]);
    expect(host.get(info.id)?.status).toBe("idle");
    // Its hook token opens nothing: not a status, not a session, not the key of a profile.
    await expect(host.hook(info.id, token, { event: "UserPromptSubmit", payload: { session_id: "s1" } })).rejects.toThrow(/unknown terminal or hook token/);
    expect(() => host.profileOf(info.id, token)).toThrow(/unknown terminal or hook token/);
    expect(host.get(info.id)).toMatchObject({ status: "idle", agentSessionId: null });
    // Nor is what it draws a question of its own (2026-11-10): rows, one of them marked, and how to choose under them —
    // as Claude Code asks whether to trust a folder — are read on an agent's screen as a list to pick from, and hold
    // back a reply to an agent that has no session yet (docs/simple-view-v0.md §5.17). A shell never has a session,
    // and what runs in it draws what it likes: its screen is not read for one.
    host.write(info.id, "printf '\\033[2J\\033[H Trust this folder?\\n\\n \\342\\235\\257 No, exit\\n   Yes, I trust this folder\\n\\n Enter to confirm \\302\\267 Esc to cancel\\n'; sleep 1\r");
    await until(() => text(events).includes("❯ No, exit"));
    await new Promise((r) => setTimeout(r, 250));
    expect(events.filter((e) => e.type === "choices" && e.choices !== null)).toEqual([]);
    expect(host.get(info.id)?.choices ?? null).toBeNull();
    host.write(info.id, "exit 3\r");
    await until(() => host.get(info.id)?.status === "exited");
    expect(host.get(info.id)?.exitCode).toBe(3);
  });
});

describe("a shell over HTTP", () => {
  function start() {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-shell-"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-shell-cwd-")));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const shell = launcher();
    const daemon = buildDaemon(cfg, { terminalLauncher: (req) => (req.harness === SHELL ? shell(req) : fakeAgent(req)) });
    closers.push(() => daemon.close());
    const phone = markRemote({}, { deviceId: "phone" });
    const call = async (method: string, path: string, body?: unknown, env?: object) => {
      const res = await daemon.api.request(path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }, env);
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    return { cwd, phone, call };
  }

  it("is started on the Mac itself: listed there, and offered there", async () => {
    const { cwd, call } = start();
    const made = await call("POST", "/terminals/shell", { cwd, cols: 90, rows: 24 });
    expect(made.status).toBe(201);
    expect(made.json.terminal).toMatchObject({ harness: "shell", cwd, status: "idle", name: "Shell", cols: 90, rows: 24 });
    const id = made.json.terminal.id as string;
    const listed = await call("GET", "/terminals");
    expect(listed.json.shell).toBe(true);
    expect(listed.json.terminals.map((t: { id: string }) => t.id)).toEqual([id]);
    // It is not one of the agents: the choices a new terminal has are as they were.
    expect(listed.json.agents).not.toContain("shell");
    expect((await call("POST", "/terminals", { harness: "shell", cwd })).status).toBe(400);
    // A folder that is not there, a path that is not absolute: refused as for any terminal.
    expect((await call("POST", "/terminals/shell", { cwd: join(cwd, "gone") })).status).toBe(400);
    expect((await call("POST", "/terminals/shell", { cwd: "relative/path" })).status).toBe(400);
    // Typed into, sized, named and ended as any terminal is.
    expect((await call("POST", `/terminals/${id}/write`, { data: "echo typed-$((1+1))\r" })).status).toBe(200);
    expect((await call("PATCH", `/terminals/${id}`, { name: "deploy" })).json.terminal.name).toBe("deploy");
    expect((await call("POST", `/terminals/${id}/resize`, { cols: 100, rows: 30 })).status).toBe(200);
    // What only an agent has, it has not.
    for (const [path, body] of [["model", { model: "opus" }], ["mode", { mode: "plan" }], ["effort", { effort: "high" }], ["daybreak", { on: true }], ["choices", { picks: [] }], ["permissions/p1", { decision: "allow" }]] as const) {
      const res = await call("POST", `/terminals/${id}/${path}`, body);
      expect(res.status, path).toBe(400);
      expect(res.json.error, path).toMatch(/a shell is no agent/);
    }
    expect((await call("GET", `/terminals/${id}/commands`)).status).toBe(400);
    expect((await call("DELETE", `/terminals/${id}`)).status).toBe(200);
    expect((await call("GET", "/terminals")).json.terminals).toEqual([]);
  });

  it("is not there for a paired device: not listed, not started, not read, typed into, named or ended", async () => {
    const { cwd, call, phone } = start();
    const id = (await call("POST", "/terminals/shell", { cwd })).json.terminal.id as string;
    const agent = (await call("POST", "/terminals", { harness: "codex", cwd })).json.terminal.id as string;
    // The list a phone gets has the agent's terminal and no shell, and does not say one could be opened.
    const listed = await call("GET", "/terminals", undefined, phone);
    expect(listed.status).toBe(200);
    expect(listed.json.terminals.map((t: { id: string }) => t.id)).toEqual([agent]);
    expect(listed.json.shell).toBeUndefined();
    expect((await call("GET", `/terminals/${agent}`, undefined, phone)).status).toBe(200);
    // None to start: the route is not among those a paired device may call, and refuses one itself.
    expect(remoteAllowed("POST", "/terminals/shell")).toBe(false);
    const fromPhone = await call("POST", "/terminals/shell", { cwd }, phone);
    expect(fromPhone.status).toBe(403);
    expect((await call("POST", "/terminals", { harness: "shell", cwd }, phone)).status).toBe(400);
    expect((await call("GET", "/terminals")).json.terminals).toHaveLength(2);
    // Every route of one terminal answers as if there were no such terminal.
    const routes: [string, string, unknown?][] = [
      ["GET", ""], ["PATCH", "", { name: "mine now" }], ["DELETE", ""], ["GET", "/stream"], ["GET", "/stream?view=record"], ["GET", "/commands"], ["GET", "/files?q=a"],
      ["POST", "/write", { data: "echo pwned > /tmp/agentswitch-shell-pwned\r" }], ["POST", "/input", { text: "echo pwned" }], ["POST", "/keys", { keys: ["Enter"] }],
      ["POST", "/attach", { uploads: ["u1"] }], ["POST", "/resize", { cols: 20, rows: 5 }], ["POST", "/redraw"], ["POST", "/kill"],
      ["POST", "/model", { model: "opus" }], ["POST", "/mode", { mode: "plan" }], ["POST", "/effort", { effort: "high" }], ["POST", "/choices", { picks: [] }], ["POST", "/permissions/p1", { decision: "allow" }],
    ];
    for (const [method, path, body] of routes) {
      expect(remoteAllowed(method, `/terminals/${id}${path.split("?")[0]}`), `${method} ${path} is a route a paired device may call for an agent's terminal`).toBe(true);
      const res = await call(method, `/terminals/${id}${path}`, body, phone);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.json, `${method} ${path}`).toEqual({ error: "not found" });
    }
    // Untouched by all of it: still there, still running, its name and its size its own.
    const still = (await call("GET", `/terminals/${id}`)).json.terminal;
    expect(still).toMatchObject({ id, harness: "shell", status: "idle", name: "Shell", cols: 120, rows: 36 });
  });
});
