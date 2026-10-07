/** Codex terminals through a private app-server (codexTerminal.ts, wsLines.ts; docs/simple-view-v0.md §5.4): the
 *  command line split for a server and a TUI, lines over a WebSocket behind a token, and the companion's change of
 *  model and effort — against a hand-made WebSocket server that speaks the app-server's few methods. No Codex. */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AppServerClient } from "../src/harness/appserver.js";
import { spawnOwned } from "../src/harness/processes.js";
import { connectWsLines } from "../src/harness/wsLines.js";
import { CODEX_REMOTE_TOKEN_ENV, CodexCompanion, splitCodexArgs, type CodexServer } from "../src/terminals/codexTerminal.js";
import { codexHookArgs } from "../src/terminals/codexHooks.js";

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

type Rpc = { id?: number; method?: string; params?: Record<string, unknown> };

/** A WebSocket server by hand: the upgrade (401 without the token), text frames in (masked) and out. `answer` gets
 *  each request and says its result, or throws. */
async function wsServer(token: string | null, answer: (method: string, params: Record<string, unknown>) => unknown) {
  const seen: Rpc[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.end());
      return;
    }
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    const send = (text: string, split = false) => {
      const body = Buffer.from(text, "utf8");
      const one = (opcode: number, fin: boolean, part: Buffer) => {
        const head = part.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, part.length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 126, part.length >> 8, part.length & 0xff]);
        socket.write(Buffer.concat([head, part]));
      };
      // A long answer in two fragments, as a server may send it.
      if (split && body.length > 8) { one(0x1, false, body.subarray(0, 5)); one(0x0, true, body.subarray(5)); } else one(0x1, true, body);
    };
    let pending = Buffer.alloc(0);
    socket.on("data", (d: Buffer) => {
      pending = Buffer.concat([pending, d]);
      for (;;) {
        if (pending.length < 2) return;
        let n = pending[1]! & 0x7f, at = 2;
        if (n === 126) { if (pending.length < 4) return; n = pending.readUInt16BE(2); at = 4; }
        if (pending.length < at + 4 + n) return;
        const mask = pending.subarray(at, at + 4), payload = Buffer.from(pending.subarray(at + 4, at + 4 + n));
        const opcode = pending[0]! & 0x0f;
        pending = pending.subarray(at + 4 + n);
        if (opcode === 0x8) { socket.end(); return; }
        for (let i = 0; i < n; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
        const msg = JSON.parse(payload.toString("utf8")) as Rpc;
        seen.push(msg);
        if (msg.id === undefined) continue;
        try { send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: answer(msg.method!, msg.params ?? {}) ?? {} }), msg.method === "model/list"); }
        catch (err) { send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: (err as Error).message } })); }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  closers.push(() => { for (const s of sockets) s.destroy(); server.close(); });
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("a Codex terminal's command line, split for a server and a TUI", () => {
  it("configuration to the server, the hooks to it alone, the TUI's own to the TUI", () => {
    const hooks = codexHookArgs("/n/node /h/hook.js", 10, 600);
    const args = ["-c", 'notify=["n","s","codex"]', ...hooks, "-c", 'tui.notifications=["approval-requested"]', "-c", "shell_environment_policy.set={ A = \"1\" }",
      "-m", "gpt-6-sol", "-c", 'model_reasoning_effort="high"', "-a", "on-request", "-c", 'default_permissions="agentswitch"', "-c", "permissions.agentswitch={ extends = \":read-only\" }"];
    const { server, tui } = splitCodexArgs(args);
    expect(server.filter((a) => a.startsWith("hooks."))).toHaveLength(6);
    expect(tui.some((a) => a.startsWith("hooks."))).toBe(false);
    expect(server).toContain('notify=["n","s","codex"]');
    expect(server).toContain("shell_environment_policy.set={ A = \"1\" }");
    expect(server).toContain('default_permissions="agentswitch"');
    expect(server.some((a) => a.startsWith("tui.") || a.startsWith("model_reasoning_effort"))).toBe(false);
    // The server's are flags and their values only: nothing of a subcommand, a model or how it asks.
    expect(server.filter((_, i) => i % 2 === 0).every((a) => a === "-c")).toBe(true);
    for (const own of ['tui.notifications=["approval-requested"]', "-m", "gpt-6-sol", 'model_reasoning_effort="high"', "-a", "on-request", 'default_permissions="agentswitch"']) expect(tui).toContain(own);
  });
});

describe("a Codex terminal resumed behind a server", () => {
  it("how it asks goes to the server alone: a TUI attached to a server refuses a permission override when resuming", () => {
    // 0.162, with a real login: "Error: Permission overrides are not supported when resuming a remote task."
    const asking = ["-a", "on-request", "-c", 'default_permissions="agentswitch"', "-c", "permissions.agentswitch={ extends = \":read-only\" }"];
    const resumed = splitCodexArgs(["resume", "-C", "/w", "ses1", "-c", 'notify=["n"]', "-m", "gpt-6-sol", ...asking]);
    expect(resumed.tui).toEqual(["resume", "-C", "/w", "ses1", "-c", 'notify=["n"]', "-m", "gpt-6-sol"]);
    expect(resumed.server).toEqual(["-c", 'notify=["n"]', "-c", 'approval_policy="on-request"', "-c", 'default_permissions="agentswitch"', "-c", "permissions.agentswitch={ extends = \":read-only\" }"]);
    const skipping = splitCodexArgs(["fork", "-C", "/w", "ses1", "--dangerously-bypass-approvals-and-sandbox"]);
    expect(skipping.tui).toEqual(["fork", "-C", "/w", "ses1"]);
    expect(skipping.server).toEqual(["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"']);
    // A new session keeps them on the TUI, where they work (and on the server as configuration).
    const fresh = splitCodexArgs(asking);
    expect(fresh.tui).toEqual(asking);
    expect(fresh.server).toEqual(asking.slice(2));
  });
});

describe("lines over a WebSocket", () => {
  it("a line out is a frame, a frame in is a line; a fragmented answer is joined; no token, no way in", async () => {
    const { url, seen } = await wsServer("tok", (method) => (method === "model/list" ? { data: [{ model: "a-long-enough-name" }] } : { echoed: method }));
    await expect(connectWsLines(url)).rejects.toThrow(/refused: HTTP 401/);
    await expect(connectWsLines(url, { token: "wrong" })).rejects.toThrow(/refused: HTTP 401/);
    const ws = await connectWsLines(url, { token: "tok" });
    closers.push(() => ws.close());
    const rpc = new AppServerClient(ws.input, ws.output, async () => ({}), () => undefined);
    expect(await rpc.request("initialize", { clientInfo: { name: "t", version: "0" } }, 2000)).toEqual({ echoed: "initialize" });
    expect(await rpc.request("model/list", {}, 2000)).toEqual({ data: [{ model: "a-long-enough-name" }] });
    // A long request (a 16-bit length) arrives whole.
    const long = "x".repeat(3000);
    await rpc.request("thread/read", { threadId: long }, 2000);
    expect(seen.at(-1)).toMatchObject({ method: "thread/read", params: { threadId: long } });
  });

  it("not a WebSocket server is said so", async () => {
    const plain = createServer((_req, res) => res.writeHead(200).end("hello"));
    await new Promise<void>((ok) => plain.listen(0, "127.0.0.1", ok));
    closers.push(() => plain.close());
    await expect(connectWsLines(`ws://127.0.0.1:${(plain.address() as AddressInfo).port}`)).rejects.toThrow(/refused: HTTP 200/);
  });
});

describe("Codex terminal companion", () => {
  const models = [
    { id: "gpt-6-sol", model: "gpt-6-sol", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "gpt-6-astra", model: "gpt-6-astra", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }] },
  ];
  async function companion(threads: string[], thread: Record<string, unknown>, more: { daybreak?: boolean; config?: Record<string, unknown> } = {}) {
    const updates: Record<string, unknown>[] = [];
    const { url, seen } = await wsServer("secret", (method, params) => {
      if (method === "thread/loaded/list") return { data: threads };
      // A helper of Codex's own keeps no record (`th-helper`); the others are the same thread's settings here.
      if (method === "thread/read") return { thread: params.threadId === "th-helper" ? { ephemeral: true } : thread };
      if (method === "model/list") return { data: models };
      if (method === "config/read") return { config: more.config ?? {} };
      if (method === "thread/settings/update") { updates.push(params); Object.assign(thread, { model: params.model, reasoningEffort: params.effort ?? thread.reasoningEffort }); return {}; }
      return {};
    });
    const started: { flags?: readonly string[]; env?: Record<string, string> } = {};
    const serve = async (o: { flags: readonly string[]; env: Record<string, string> }): Promise<CodexServer> => {
      started.flags = o.flags; started.env = o.env;
      const child = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      closers.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
      return { child, url, token: "secret" };
    };
    const args = ["-c", 'notify=["n"]', ...codexHookArgs("/n/node /h/hook.js", 10, 600), "-c", 'tui.notification_method="osc9"', "-m", "gpt-6-sol", "-a", "on-request"];
    const c = new CodexCompanion({ binary: "/bin/codex", cwd: tmpdir(), env: { PATH: "/usr/bin" }, args, dir: tmpdir(), serve, log: () => undefined, threadWaitMs: 0, ...(more.daybreak ? { daybreak: true } : {}) });
    closers.push(() => c.stop());
    return { c, updates, seen, started };
  }

  it("starts the TUI attached to its server, the token in its environment and on no command line", async () => {
    const { c, started } = await companion(["th1"], { model: "gpt-6-sol", reasoningEffort: "medium" });
    const plan = await c.start();
    expect(c.reportsStatus).toBe(false);
    expect(plan!.args.slice(-4)).toEqual(["--remote", expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/), "--remote-auth-token-env", CODEX_REMOTE_TOKEN_ENV]);
    expect(plan!.args).not.toContain("secret");
    expect(plan!.env[CODEX_REMOTE_TOKEN_ENV]).toBe("secret");
    expect(plan!.args.some((a) => a.startsWith("hooks."))).toBe(false);
    expect(started.flags!.filter((a) => a.startsWith("hooks."))).toHaveLength(6);
    expect(started.env).not.toHaveProperty(CODEX_REMOTE_TOKEN_ENV);
  });

  it("changes the model and the effort of the thread the TUI is on; only what its server lists", async () => {
    const { c, updates } = await companion(["th1", "th-subagent"], { model: "gpt-6-sol", reasoningEffort: "medium" });
    await c.start();
    // Another model starts at its own default effort.
    expect(await c.setModel({ model: "gpt-6-astra" })).toEqual({ model: "gpt-6-astra", variant: "low" });
    expect(updates.at(-1)).toEqual({ threadId: "th1", model: "gpt-6-astra", effort: "low" });
    // An effort alone keeps the model; one that model has not is refused before anything is sent.
    expect(await c.setModel({ variant: "ultra" })).toEqual({ model: "gpt-6-astra", variant: "ultra" });
    expect(updates.at(-1)).toEqual({ threadId: "th1", model: "gpt-6-astra", effort: "ultra" });
    const sent = updates.length;
    await expect(c.setModel({ variant: "medium" })).rejects.toThrow(/one of low, ultra/);
    await expect(c.setModel({ model: "gpt-0" })).rejects.toThrow(/not a model of its: gpt-0/);
    expect(updates).toHaveLength(sent);
  });

  it("the thread the terminal follows, when its server holds it; never a helper of Codex's own that keeps no record", async () => {
    const { c, updates } = await companion(["th-helper", "th1", "th2"], { model: "gpt-6-sol", reasoningEffort: "medium" });
    await c.start();
    await c.setModel({ variant: "high" });
    expect(updates.at(-1)).toMatchObject({ threadId: "th1" });
    await c.setModel({ variant: "low", session: "th2" });
    expect(updates.at(-1)).toMatchObject({ threadId: "th2" });
    // One it does not hold (a session the hooks named before a `/resume` inside the TUI): the one it holds.
    await c.setModel({ variant: "high", session: "gone" });
    expect(updates.at(-1)).toMatchObject({ threadId: "th1" });
  });

  it("no thread yet, or no server: said, not sent", async () => {
    const { c, updates } = await companion([], {});
    await expect(c.setModel({ model: "gpt-6-sol" })).rejects.toThrow(/its server is not running/);
    await c.start();
    await expect(c.setModel({ model: "gpt-6-sol" })).rejects.toThrow(/no session yet/);
    c.stop();
    await expect(c.setModel({ model: "gpt-6-sol" })).rejects.toThrow(/its server is not running/);
    expect(updates).toHaveLength(0);
  });

  it("says how Codex's Daybreak switch stands: the thread's saved choice, its own default before it has a thread; only where the switch is on offer", async () => {
    // Not started with the switch: the companion has no word of it (the host then offers none).
    expect((await companion(["th1"], { daybreakEnabled: true })).c.daybreak).toBeUndefined();
    const thread: Record<string, unknown> = { model: "gpt-6-sol", daybreakEnabled: true };
    const { c, seen } = await companion(["th-helper", "th1"], thread, { daybreak: true, config: { daybreak: true } });
    await c.start();
    expect(await c.daybreak!()).toBe(true);
    thread.daybreakEnabled = false;   // turned in the TUI, which saved it on its server
    expect(await c.daybreak!("th1")).toBe(false);
    expect(seen.some((m) => m.method === "config/read")).toBe(false);
    // A thread with no choice saved is off, as the TUI reads it (one begun with the switch on is given it at its start).
    delete thread.daybreakEnabled;
    expect(await c.daybreak!()).toBe(false);
    expect(seen.some((m) => m.method === "config/read")).toBe(false);
    // No thread yet: how its new sessions start (its config, read not written).
    const fresh = await companion([], {}, { daybreak: true, config: { daybreak: true } });
    await fresh.c.start();
    expect(await fresh.c.daybreak!()).toBe(true);
    expect(fresh.seen.filter((m) => m.method?.startsWith("thread/metadata") || m.method === "config/batchWrite" || m.method === "config/value/write")).toEqual([]);
    // The feature goes to both: the TUI holds the switch, its server the program it sends.
    expect(splitCodexArgs(["-c", "features.cli_daybreak=true", "-m", "gpt-6-sol"])).toEqual({ server: ["-c", "features.cli_daybreak=true"], tui: ["-c", "features.cli_daybreak=true", "-m", "gpt-6-sol"] });
  });

  it("a server that does not start leaves the TUI to run on its own", async () => {
    const c = new CodexCompanion({ binary: "/bin/codex", cwd: tmpdir(), env: {}, args: ["-m", "x"], dir: tmpdir(), serve: async () => { throw new Error("no such binary"); }, log: () => undefined });
    expect(await c.start()).toBeNull();
  });
});
