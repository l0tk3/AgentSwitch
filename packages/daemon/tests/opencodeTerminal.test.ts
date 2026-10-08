/** OpenCode terminals watched through their own server (opencodeTerminal.ts, docs/terminal-v0.md §3): a fake server
 *  answering OpenCode's routes, the companion's status and permission cards, and the host starting a program with
 *  what a companion says. No OpenCode and no model. */

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { basicAuth, type StdioServe } from "../src/harness/opencodeStdio.js";
import { spawnOwned } from "../src/harness/processes.js";
import { TerminalHost, type Companion, type CompanionLink, type PermissionDecision, type TerminalEvent } from "../src/terminals/host.js";
import { OpenCodeCompanion, openCodeAsk } from "../src/terminals/opencodeTerminal.js";
import { agentLauncher } from "../src/terminals/launch.js";

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

async function until<T>(get: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

type Request = { id: string; sessionID: string; action: string; resources: string[] };

/** OpenCode's routes the companion reads and the reply it sends, over a real loopback server with the password. */
async function fakeServer(password: string) {
  const state = { active: {} as Record<string, unknown>, requests: [] as Request[], forms: [] as unknown[], replies: [] as { path: string; body: unknown }[], unauthorized: 0,
    // Its models (two with variants, one switched off), its sessions, and the switches asked of it.
    models: [
      { id: "space-bunny", providerID: "opencode", enabled: true, variants: [{ id: "low" }, { id: "high" }, { id: "max" }] },
      { id: "ling-flash", providerID: "opencode", enabled: true, variants: [] },
      { id: "retired", providerID: "opencode", enabled: false, variants: [] },
    ] as { id: string; providerID: string; enabled: boolean; variants: { id: string }[] }[],
    sessions: [] as { id: string; time: { created: number }; model?: { id: string; providerID: string; variant?: string } }[],
    switches: [] as { session: string; model: unknown }[] };
  const body = (req: IncomingMessage) => new Promise<unknown>((ok) => { let t = ""; req.on("data", (d) => { t += d; }); req.on("end", () => ok(t ? JSON.parse(t) : null)); });
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== basicAuth(password)) { state.unauthorized++; res.writeHead(401).end(); return; }
    const path = (req.url ?? "").split("?")[0]!;
    const json = (v: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "GET" && path === "/api/session/active") return json({ data: state.active });
    if (req.method === "GET" && path === "/api/permission/request") return json({ data: state.requests });
    if (req.method === "GET" && path === "/api/form") return json({ data: state.forms });
    if (req.method === "GET" && path === "/api/model") return json({ data: state.models });
    if (req.method === "GET" && path === "/api/session") return json({ data: state.sessions });
    const one = /^\/api\/session\/([^/]+)(\/model)?$/.exec(path);
    if (one && req.method === "GET" && !one[2]) { const s = state.sessions.find((x) => x.id === decodeURIComponent(one[1]!)); return s ? json({ data: s }) : void res.writeHead(404).end(); }
    if (one && req.method === "POST" && one[2]) {
      // As the real one: any model is taken without a word.
      const sent = (await body(req)) as { model: { id: string; providerID: string; variant?: string } };
      state.switches.push({ session: decodeURIComponent(one[1]!), model: sent.model });
      const s = state.sessions.find((x) => x.id === decodeURIComponent(one[1]!));
      if (s) s.model = sent.model;
      res.writeHead(204).end();
      return;
    }
    if (req.method === "POST" && path.endsWith("/reply")) {
      state.replies.push({ path, body: await body(req) });
      state.requests = state.requests.filter((r) => !path.includes(r.id));
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  closers.push(() => server.close());
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Stands in for `opencode serve --stdio`: a process that lives until its stdin closes, and the fake server's address. */
function fakeServe(url: string, password: string, started: { env?: Readonly<Record<string, string>> } = {}) {
  return async (o: { env: Readonly<Record<string, string>> }): Promise<StdioServe> => {
    started.env = o.env;
    const child = spawnOwned(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"], { stdio: ["pipe", "ignore", "ignore"] });
    closers.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
    return { child, url, password, stderrTail: () => "" };
  };
}

/** The screens' side of a companion: statuses as they come, and each card with a way to answer it. */
function fakeLink() {
  const statuses: string[] = [];
  const cards: { tool: string; input: unknown; signal: AbortSignal; answer: (d: PermissionDecision | null) => void }[] = [];
  const link: CompanionLink = {
    status: (s) => { if (statuses[statuses.length - 1] !== s) statuses.push(s); },
    ask: (tool, input, signal) => new Promise((answer) => {
      cards.push({ tool, input, signal, answer });
      signal.addEventListener("abort", () => answer(null), { once: true });
    }),
  };
  return { statuses, cards, link, last: () => statuses[statuses.length - 1] };
}

describe("OpenCode terminal companion", () => {
  it("attaches the TUI to its server with the password, never the user's own server password", async () => {
    const { url } = await fakeServer("pw1");
    const started: { env?: Readonly<Record<string, string>> } = {};
    const c = new OpenCodeCompanion({ binary: "/bin/opencode", cwd: tmpdir(), env: { PATH: "/bin", OPENCODE_SERVER_PASSWORD: "users", OPENCODE_CONFIG: "/x.json" }, args: ["-m", "m1", "--auto"], asks: false, serve: fakeServe(url, "pw1", started) });
    closers.push(() => c.stop());
    const plan = await c.start();
    expect(plan!.args).toEqual(["--server", url, "-m", "m1", "--auto"]);
    expect(plan!.env).toEqual({ PATH: "/bin", OPENCODE_CONFIG: "/x.json", OPENCODE_PASSWORD: "pw1" });
    expect(started.env?.OPENCODE_CONFIG).toBe("/x.json");   // the server runs with the terminal's config and gate
  });

  it("idle, working while a session runs, waiting on a request whose card is answered on the server", async () => {
    const { state, url } = await fakeServer("pw2");
    const c = new OpenCodeCompanion({ binary: "/bin/opencode", cwd: tmpdir(), env: {}, args: [], asks: true, pollMs: 10, serve: fakeServe(url, "pw2") });
    closers.push(() => c.stop());
    await c.start();
    const screens = fakeLink();
    c.attach(screens.link);
    await until(() => screens.last() === "idle");
    state.active = { ses_1: { type: "busy" } };
    await until(() => screens.last() === "working");
    state.requests = [{ id: "per_1", sessionID: "ses_1", action: "bash", resources: ["rm -rf build"] }];
    const card = await until(() => screens.cards[0]);
    expect(card).toMatchObject({ tool: "Bash", input: { command: "rm -rf build" } });
    await until(() => screens.last() === "waiting");
    await new Promise((r) => setTimeout(r, 50));
    expect(screens.cards).toHaveLength(1);   // one card per request, however many looks
    card.answer("deny");
    await until(() => state.replies.length === 1);
    expect(state.replies[0]).toEqual({ path: "/api/session/ses_1/permission/per_1/reply", body: { decision: "reject", message: "在 AgentSwitch 上被拒绝。" } });
    await until(() => screens.last() === "working");
    state.active = {};
    await until(() => screens.last() === "idle");
    expect(state.unauthorized).toBe(0);
  });

  it("switches the model and the level of the session the TUI is on, on its own server; only what that server lists", async () => {
    // 2026-10-07, user: codex不能hook掉它的模型选择…其他的agent也是. Seen on OpenCode 2.0.24: POST /api/session/:id/model,
    // the TUI writes "Switched model to Space Bunny Free (max)" and its footer follows.
    const { state, url } = await fakeServer("pw5");
    const c = new OpenCodeCompanion({ binary: "/bin/opencode", cwd: tmpdir(), env: {}, args: [], asks: true, pollMs: 10, serve: fakeServe(url, "pw5") });
    closers.push(() => c.stop());
    await c.start();
    const screens = fakeLink();
    c.attach(screens.link);
    await until(() => screens.last() === "idle");
    // Before its first message the TUI has no session: nothing to switch. One of another day is not its own.
    state.sessions = [{ id: "ses_old", time: { created: Date.now() - 86_400_000 }, model: { id: "ling-flash", providerID: "opencode" } }];
    await expect(c.setModel({ model: "opencode/space-bunny" })).rejects.toThrow(/no session yet/);
    // Its own: made since the terminal started.
    state.sessions.push({ id: "ses_new", time: { created: Date.now() }, model: { id: "ling-flash", providerID: "opencode" } });
    expect(await c.setModel({ model: "opencode/space-bunny" })).toEqual({ model: "opencode/space-bunny", variant: null });
    expect(state.switches.at(-1)).toEqual({ session: "ses_new", model: { id: "space-bunny", providerID: "opencode" } });
    // A level alone keeps the model; one that model does not have is refused here (its server would take it).
    expect(await c.setModel({ variant: "max" })).toEqual({ model: "opencode/space-bunny", variant: "max" });
    expect(state.switches.at(-1)).toEqual({ session: "ses_new", model: { id: "space-bunny", providerID: "opencode", variant: "max" } });
    await expect(c.setModel({ variant: "ultra" })).rejects.toThrow(/one of low, high, max/);
    // Another model starts at its own default level; one that takes none refuses a level.
    expect(await c.setModel({ model: "opencode/ling-flash" })).toEqual({ model: "opencode/ling-flash", variant: null });
    await expect(c.setModel({ variant: "high" })).rejects.toThrow(/takes no level/);
    // Not its model, one switched off, not a model's name at all: never sent.
    const sent = state.switches.length;
    await expect(c.setModel({ model: "opencode/no-such" })).rejects.toThrow(/not a model of its/);
    await expect(c.setModel({ model: "opencode/retired" })).rejects.toThrow(/not a model of its/);
    await expect(c.setModel({ model: "bare" })).rejects.toThrow(/not a model of its/);
    expect(state.switches).toHaveLength(sent);
    // The session seen running is the one, whatever else the folder holds.
    state.sessions.push({ id: "ses_other", time: { created: Date.now() + 5 }, model: { id: "ling-flash", providerID: "opencode" } });
    state.active = { ses_new: { type: "busy" } };
    await until(() => screens.last() === "working");
    state.active = {};
    await until(() => screens.last() === "idle");
    await c.setModel({ model: "opencode/space-bunny" });
    expect(state.switches.at(-1)!.session).toBe("ses_new");
    // Started on a session (`--session`): that one.
    const resumed = new OpenCodeCompanion({ binary: "/bin/opencode", cwd: tmpdir(), env: {}, args: ["--session", "ses_old"], asks: true, pollMs: 10, serve: fakeServe(url, "pw5") });
    closers.push(() => resumed.stop());
    await resumed.start();
    await resumed.setModel({ model: "opencode/space-bunny", variant: "low" });
    expect(state.switches.at(-1)).toEqual({ session: "ses_old", model: { id: "space-bunny", providerID: "opencode", variant: "low" } });
  });

  it("withdraws a card answered in the TUI, and allows once", async () => {
    const { state, url } = await fakeServer("pw3");
    const c = new OpenCodeCompanion({ binary: "/bin/opencode", cwd: tmpdir(), env: {}, args: [], asks: true, pollMs: 10, serve: fakeServe(url, "pw3") });
    closers.push(() => c.stop());
    await c.start();
    const screens = fakeLink();
    c.attach(screens.link);
    state.active = { ses_1: {} };
    state.requests = [{ id: "per_1", sessionID: "ses_1", action: "external_directory", resources: ["/opt/x/*"] }];
    const first = await until(() => screens.cards[0]);
    expect(first).toMatchObject({ tool: "external_directory", input: { path: "/opt/x/*" } });
    state.requests = [];   // answered in the TUI
    await until(() => first.signal.aborted);
    state.requests = [{ id: "per_2", sessionID: "ses_1", action: "edit", resources: ["src/a.ts"] }];
    const second = await until(() => screens.cards[1]);
    second.answer("allow");
    await until(() => state.replies.length === 1);
    expect(state.replies[0]!.body).toEqual({ decision: "once" });
  });

  it("with --auto the TUI approves: no cards; a question waits either way", async () => {
    const { state, url } = await fakeServer("pw4");
    const c = new OpenCodeCompanion({ binary: "/bin/opencode", cwd: tmpdir(), env: {}, args: ["--auto"], asks: false, pollMs: 10, serve: fakeServe(url, "pw4") });
    closers.push(() => c.stop());
    await c.start();
    const screens = fakeLink();
    c.attach(screens.link);
    state.active = { ses_1: {} };
    state.requests = [{ id: "per_1", sessionID: "ses_1", action: "bash", resources: ["ls"] }];
    await until(() => screens.last() === "working");
    state.forms = [{ id: "frm_1" }];
    await until(() => screens.last() === "waiting");
    expect(screens.cards).toHaveLength(0);
  });

  it("a server that does not start leaves the TUI to its own", async () => {
    const lines: string[] = [];
    const c = new OpenCodeCompanion({ binary: "/bin/opencode", cwd: tmpdir(), env: {}, args: [], asks: true, log: (l) => lines.push(l), serve: async () => { throw new Error("no such binary"); } });
    expect(await c.start()).toBeNull();
    expect(lines.join("\n")).toMatch(/no such binary/);
  });

  it("cards read like the others", () => {
    expect(openCodeAsk({ id: "p", sessionID: "s", action: "shell", resources: ["a", "b"] })).toEqual({ tool: "Bash", input: { command: "a ; b" } });
    expect(openCodeAsk({ id: "p", sessionID: "s", action: "webfetch", resources: ["https://x.test"] })).toEqual({ tool: "WebFetch", input: { url: "https://x.test" } });
  });

  it("the launcher gives an OpenCode terminal the companion, still able to start standalone", () => {
    const launch = agentLauncher({ binaries: { opencode: "/bin/opencode" }, hookUrl: () => "http://127.0.0.1:1", stateDir: tmpdir(), env: {}, opencodeServer: true });
    const plan = launch({ id: "o1", harness: "opencode", cwd: tmpdir(), mode: "manual", hookToken: "tok", model: "m1" });
    expect(plan.companion).toBeInstanceOf(OpenCodeCompanion);
    expect(plan.args).toEqual(["--standalone", "-m", "m1"]);
    expect(plan.hooks).toBe(false);
  });
});

/** A companion in the host: it changes how the program starts, then its status and requests reach the screens. */
class ScriptedCompanion implements Companion {
  link: CompanionLink | null = null;
  stops = 0;
  constructor(private readonly started: { args: string[]; env: Record<string, string> } | null) {}
  async start() { return this.started; }
  attach(link: CompanionLink) { this.link = link; }
  stop() { this.stops++; }
}

describe("terminal host with a companion", () => {
  it("starts the program as the companion says, takes its status and requests, and stops it with the program", async () => {
    const companion = new ScriptedCompanion({ args: [FAKE], env: process.env as Record<string, string> });
    const host = new TerminalHost({ launcher: () => ({ file: process.execPath, args: ["-e", "process.exit(3)"], env: process.env as Record<string, string>, hooks: false, companion }) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "opencode", cwd: tmpdir() });
    expect(info.hooks).toBe(true);
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    await until(() => companion.link);
    companion.link!.status("working");
    expect(host.get(info.id)!.status).toBe("working");
    const withdraw = new AbortController();
    const answer = companion.link!.ask("Bash", { command: "make" }, withdraw.signal);
    const asked = await until(() => events.find((e) => e.type === "permission"));
    expect(host.get(info.id)!.status).toBe("waiting");
    host.decide(info.id, (asked as { request: { id: string } }).request.id, "allow");
    expect(await answer).toBe("allow");
    const second = companion.link!.ask("Bash", { command: "make install" }, withdraw.signal);
    withdraw.abort();
    expect(await second).toBeNull();
    host.kill(info.id);
    await until(() => host.get(info.id)!.status === "exited");
    expect(companion.stops).toBeGreaterThan(0);
  });

  it("a terminal whose companion sets the model takes the request through it: while it rests, and the screens are told", async () => {
    const companion = new ScriptedCompanion({ args: [FAKE], env: process.env as Record<string, string> });
    const asked: unknown[] = [];
    (companion as Companion).setModel = async (want) => {
      asked.push(want);
      if (want.model === "opencode/no-such") throw new Error("not a model of its: opencode/no-such");
      return { model: want.model ?? "opencode/space-bunny", variant: want.variant ?? null };
    };
    const host = new TerminalHost({ launcher: () => ({ file: process.execPath, args: ["-e", "process.exit(3)"], env: process.env as Record<string, string>, hooks: false, companion }) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "opencode", cwd: tmpdir() });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    await until(() => companion.link);
    // Not while it works.
    companion.link!.status("working");
    await expect(host.askModel(info.id, "opencode/space-bunny")).rejects.toMatchObject({ code: "busy" });
    companion.link!.status("idle");
    await host.askModel(info.id, "opencode/space-bunny");
    expect(host.get(info.id)!.modelNow).toBe("opencode/space-bunny");
    expect(events.filter((e) => e.type === "model")).toEqual([{ type: "model", model: "opencode/space-bunny" }]);
    await host.askEffort(info.id, "max");
    expect(host.get(info.id)!.effort).toBe("max");
    expect(asked).toEqual([{ model: "opencode/space-bunny", session: null }, { variant: "max", session: null }]);
    // What its companion refuses is said as it said it.
    await expect(host.askModel(info.id, "opencode/no-such")).rejects.toMatchObject({ code: "invalid", message: "not a model of its: opencode/no-such" });
  });

  it("a companion that does not start: the program starts as planned, status guessed", async () => {
    const companion = new ScriptedCompanion(null);
    const host = new TerminalHost({ launcher: () => ({ file: process.execPath, args: [FAKE], env: process.env as Record<string, string>, hooks: false, companion }) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "opencode", cwd: tmpdir() });
    expect(info.hooks).toBe(false);
    expect(companion.link).toBeNull();
    expect(companion.stops).toBe(1);
  });

  it("a terminal deleted while its companion starts never starts its program", async () => {
    let release!: () => void;
    const companion = new ScriptedCompanion({ args: [FAKE], env: process.env as Record<string, string> });
    companion.start = () => new Promise((ok) => { release = () => ok({ args: [FAKE], env: process.env as Record<string, string> }); });
    const host = new TerminalHost({ launcher: () => ({ file: process.execPath, args: [FAKE], env: process.env as Record<string, string>, hooks: false, companion }) });
    closers.push(() => host.closeAll());
    const starting = host.spawn({ harness: "opencode", cwd: tmpdir(), resume: "ses_1" });
    const listed = await until(() => host.list()[0]);
    expect(listed).toMatchObject({ agentSessionId: "ses_1", pid: null });   // a second resume finds this one
    host.remove(listed.id);
    release();
    await expect(starting).rejects.toThrow(/deleted while it started/);
    expect(companion.stops).toBe(1);
    expect(host.list()).toEqual([]);
  });
});
