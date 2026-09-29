import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenCodeServer, serveConfig, serveRouter } from "../src/router/routers/opencodeServe.js";

/** A fake `opencode serve`: sessions, async prompts that complete after a tick, message lists with an idle marker. */
function fakeServe(): { server: Server; port: () => number; calls: string[]; deleted: string[]; models: unknown[] } {
  const calls: string[] = [];
  const deleted: string[] = [];
  /** The model of each session created, as sent. */
  const models: unknown[] = [];
  let modelLooks = 0;
  const sessions = new Map<string, { messages: Record<string, unknown>[] }>();
  let n = 0;
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    calls.push(`${req.method} ${req.url}`);
    if (!auth.startsWith("Basic ") || !Buffer.from(auth.slice(6), "base64").toString().startsWith("opencode:")) { res.statusCode = 401; return res.end("nope"); }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const json = (code: number, v: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
      if (req.method === "GET" && url === "/api/config") return json(200, []);
      // A cold location lists no models the first time (as OpenCode does), then DeepSeek Flash with its variants.
      if (req.method === "GET" && url.startsWith("/api/model?")) {
        if (modelLooks++ === 0) return json(200, { data: [] });
        return json(200, { data: [{ providerID: "deepseek", id: "deepseek-flash", variants: [{ id: "none" }, { id: "low" }, { id: "high" }, { id: "max" }] }, { providerID: "opencode", id: "plain", variants: [] }] });
      }
      if (req.method === "POST" && url === "/api/session") { const id = `ses_${++n}`; sessions.set(id, { messages: [] }); models.push(JSON.parse(body).model); return json(200, { data: { id, agent: JSON.parse(body).agent } }); }
      const m = /^\/api\/session\/(ses_\d+)(\/prompt|\/message)?$/.exec(url);
      if (!m) return json(404, { error: "no route" });
      const s = sessions.get(m[1]!);
      if (!s) return json(404, { error: "no session" });
      if (req.method === "POST" && m[2] === "/prompt") {
        const text = String(JSON.parse(body).text);
        const created = Date.now();
        s.messages.push({ id: "msg_u", type: "user", time: { created }, text });
        setTimeout(() => {
          s.messages.push({ id: "msg_a", type: "assistant", time: { created: created + 1, completed: created + 2 }, content: [{ type: "text", text: `echo:${text.slice(-12)}` }, { type: "reasoning", text: "…" }] });
          s.messages.push({ id: "msg_i", type: "idle", time: { created: created + 3 }, outcome: "succeeded" });
        }, 30);
        return json(200, { data: { id: "msg_u", type: "user", time: { created } } });
      }
      if (req.method === "GET" && m[2] === "/message") return json(200, { data: [...s.messages].reverse() });
      if (req.method === "DELETE" && !m[2]) { deleted.push(m[1]!); sessions.delete(m[1]!); return json(200, { data: true }); }
      return json(404, { error: "no route" });
    });
  });
  return { server, port: () => (server.address() as { port: number }).port, calls, deleted, models };
}

describe("OpenCodeServer client", () => {
  const fake = fakeServe();
  beforeAll(() => new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r)));
  afterAll(() => fake.server.close());

  it("serveConfig declares a read-only dispatcher and a tool-less oracle", () => {
    const cfg = serveConfig("/h/.secret-gate") as { agent: Record<string, { tools: Record<string, boolean>; steps: number }> };
    expect(cfg.agent.dispatcher!.tools.read).toBeUndefined();
    expect(cfg.agent.dispatcher!.tools.bash).toBe(false);
    expect(cfg.agent.oracle!.tools.read).toBe(false);
    expect(cfg.agent.oracle!.steps).toBe(1);
  });

  it("ask(): creates a session, prompts, waits for the idle marker, returns the assistant text, deletes the session", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-ocs-"));
    const s = new OpenCodeServer({ binary: "/nonexistent", home, gateHome: "/h/.secret-gate", endpoint: { url: `http://127.0.0.1:${fake.port()}`, password: "pw" }, log: () => undefined });
    await s.start();   // the fake is already listening: start() only takes the endpoint, nothing is spawned
    expect(s.running).toBe(true);
    const text = await s.ask("oracle", "deepseek/deepseek-flash", "hello world!", "/tmp", new AbortController().signal);
    expect(text).toBe("echo:hello world!");
    await vi.waitFor(() => expect(fake.deleted).toEqual(["ses_1"]), { timeout: 4_000, interval: 5 });   // the DELETE is fire-and-forget
    const router = serveRouter(s, "dispatcher", "deepseek/deepseek-flash");
    const reply = await router.route({ task: "TASK", cwd: "/tmp", system: "SYSTEM" }, new AbortController().signal);
    expect(reply.text).toBe("echo:\n=====\n\nTASK");   // system rides at the head of the message, the task at its tail
    expect(fake.calls.some((c) => c === "POST /api/session")).toBe(true);
    const ac = new AbortController(); ac.abort(new Error("stop"));
    await expect(s.ask("oracle", "deepseek/deepseek-flash", "x", "/tmp", ac.signal)).rejects.toThrow();
  });

  it("the router's effort goes as the model's variant when the model has one by that name, else not at all", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-ocs-"));
    const lines: string[] = [];
    const s = new OpenCodeServer({ binary: "/nonexistent", home, gateHome: "/h/.secret-gate", endpoint: { url: `http://127.0.0.1:${fake.port()}`, password: "pw" }, log: (l) => lines.push(l) });
    await s.start();
    const input = { task: "TASK", cwd: "/tmp", system: "SYSTEM" };
    const from = fake.models.length;
    await serveRouter(s, "dispatcher", "deepseek/deepseek-flash", "high").route(input, new AbortController().signal);
    await serveRouter(s, "oracle", "deepseek/deepseek-flash", "ultra").route(input, new AbortController().signal);   // not one of its levels
    await serveRouter(s, "oracle", "opencode/plain", "high").route(input, new AbortController().signal);            // a model without levels
    await serveRouter(s, "oracle", "deepseek/deepseek-flash").route(input, new AbortController().signal);           // none set
    expect(fake.models.slice(from)).toEqual([
      { providerID: "deepseek", id: "deepseek-flash", variant: "high" },
      { providerID: "deepseek", id: "deepseek-flash" },
      { providerID: "opencode", id: "plain" },
      { providerID: "deepseek", id: "deepseek-flash" },
    ]);
    // OpenCode would fail the turn for a variant the model lacks: said once per call, never sent.
    expect(lines.join("\n")).toContain('router effort "ultra" is not a variant of deepseek/deepseek-flash (none, low, high, max)');
    expect(fake.calls.filter((c) => c.startsWith("GET /api/model?")).length).toBeLessThanOrEqual(3);   // looked up once per model, after the cold look
  });

  it("start() fails fast when the binary is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-ocs2-"));
    const s = new OpenCodeServer({ binary: join(home, "no-such-binary"), port: 0, home, gateHome: "/h", log: () => undefined });
    await expect(s.start()).rejects.toThrow(/opencode serve --stdio (failed to start|exited .* before it was ready)/);
    expect(s.running).toBe(false);
    await expect(s.ask("oracle", "deepseek/deepseek-flash", "x", "/tmp", new AbortController().signal)).rejects.toThrow("not running");
  });

  it("the process: `serve --stdio` on the configured port, password only as OPENCODE_PASSWORD, proxy-free env, both agents; answers, then exits when stopped", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-ocs3-"));
    const out = join(home, "spawned.json");
    const bin = join(home, "fake-serve");
    // Records argv and env, reports the fake API's address as `serve --stdio` does, exits on stdin EOF.
    writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({argv:process.argv.slice(2),env:process.env}));console.log(JSON.stringify({url:'http://127.0.0.1:${fake.port()}'}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`, { mode: 0o700 });
    const saved = { ...process.env };
    Object.assign(process.env, { HTTPS_PROXY: "http://proxy:1", OPENCODE_SERVER_PASSWORD: "leak", OPENCODE_PASSWORD: "inherited" });
    const logs: string[] = [];
    const s = new OpenCodeServer({ binary: bin, port: 4799, home: join(home, "router"), gateHome: "/h/.secret-gate", log: (l) => logs.push(l) });
    try { await s.start(); } finally { for (const k of ["HTTPS_PROXY", "OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    expect(s.running).toBe(true);
    const seen = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(seen.argv).toEqual(["serve", "--stdio", "--port", "4799", "--hostname", "127.0.0.1"]);
    expect(seen.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(seen.env.OPENCODE_PASSWORD).toMatch(/^[\w-]{20,}$/);
    expect(seen.env.OPENCODE_PASSWORD).not.toBe("inherited");
    expect(seen.env.HTTPS_PROXY).toBeUndefined();
    expect(seen.env.NO_PROXY).toBe("127.0.0.1,localhost");
    expect(seen.env.PWD).toBe(join(home, "router"));
    const config = JSON.parse(readFileSync(seen.env.OPENCODE_CONFIG!, "utf8")) as { agent: Record<string, unknown> };
    expect(Object.keys(config.agent).sort()).toEqual(["dispatcher", "oracle"]);
    const reply = await serveRouter(s, "oracle", "deepseek/deepseek-flash").route({ task: "PING", cwd: "/tmp", system: "S" }, new AbortController().signal);
    expect(reply.text).toBe("echo:\n=====\n\nPING");   // the fake echoes the last 12 characters
    await s.stop();
    expect(s.running).toBe(false);
    expect(logs.some((l) => l.includes(`ready on http://127.0.0.1:${fake.port()}`))).toBe(true);
  });
});
