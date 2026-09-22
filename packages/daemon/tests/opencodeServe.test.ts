import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenCodeServer, serveConfig, serveRouter } from "../src/router/routers/opencodeServe.js";

/** A fake `opencode serve`: sessions, async prompts that complete after a tick, message lists with an idle marker. */
function fakeServe(): { server: Server; port: () => number; calls: string[]; deleted: string[] } {
  const calls: string[] = [];
  const deleted: string[] = [];
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
      if (req.method === "POST" && url === "/api/session") { const id = `ses_${++n}`; sessions.set(id, { messages: [] }); return json(200, { data: { id, agent: JSON.parse(body).agent } }); }
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
  return { server, port: () => (server.address() as { port: number }).port, calls, deleted };
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
    const s = new OpenCodeServer({ binary: "/nonexistent", port: fake.port(), home, gateHome: "/h/.secret-gate", log: () => undefined });
    // no start(): the fake is already listening; ask() only needs the URL and the password header
    const text = await s.ask("oracle", "deepseek/deepseek-flash", "hello world!", "/tmp", new AbortController().signal);
    expect(text).toBe("echo:hello world!");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.deleted).toEqual(["ses_1"]);
    const router = serveRouter(s, "dispatcher", "deepseek/deepseek-flash");
    const reply = await router.route({ task: "TASK", cwd: "/tmp", system: "SYSTEM" }, new AbortController().signal);
    expect(reply.text).toBe("echo:\n=====\n\nTASK");   // system rides at the head of the message, the task at its tail
    expect(fake.calls.some((c) => c === "POST /api/session")).toBe(true);
    const ac = new AbortController(); ac.abort(new Error("stop"));
    await expect(s.ask("oracle", "deepseek/deepseek-flash", "x", "/tmp", ac.signal)).rejects.toThrow();
  });

  it("start() fails fast when the binary is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-ocs2-"));
    const s = new OpenCodeServer({ binary: join(home, "no-such-binary"), port: 0, home, gateHome: "/h", log: () => undefined });
    await expect(s.start()).rejects.toThrow(/exited before it was ready|did not answer/);
    expect(s.running).toBe(false);
  });
});
