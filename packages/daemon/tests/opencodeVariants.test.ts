/** OpenCode's variants for the terminals' model menus (models/opencodeVariants.ts): asked of an `opencode serve --stdio`
 *  started for the question, against a fake program that reports a fake API's address. */
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stdioServePorts } from "../src/harness/opencodeStdio.js";
import { readOpenCodeVariants } from "../src/models/opencodeVariants.js";

/** A fake OpenCode API: a cold location lists no models the first `cold` times (as OpenCode does), then two. */
function fakeApi(cold: number): { server: Server; port: () => number; calls: string[] } {
  const calls: string[] = [];
  let looks = 0;
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    calls.push(`${req.method} ${req.url}`);
    if (!auth.startsWith("Basic ") || !Buffer.from(auth.slice(6), "base64").toString().startsWith("opencode:")) { res.statusCode = 401; return res.end("nope"); }
    res.setHeader("content-type", "application/json");
    if (looks++ < cold) return res.end(JSON.stringify({ data: [] }));
    return res.end(JSON.stringify({ data: [{ providerID: "deepseek", id: "deepseek-flash", variants: [{ id: "none" }, { id: "low" }, { id: "high" }, { id: "max" }] }, { providerID: "opencode", id: "plain", variants: [] }] }));
  });
  return { server, port: () => (server.address() as { port: number }).port, calls };
}

/** A program that records its pid, argv and env, reports `port` as `serve --stdio` does and exits on stdin EOF. */
function fakeBinary(home: string, port: number): { bin: string; spawned: string } {
  const bin = join(home, "fake-serve"), spawned = join(home, "spawned.json");
  writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(spawned)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2),env:process.env}));console.log(JSON.stringify({url:'http://127.0.0.1:${port}'}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`, { mode: 0o700 });
  return { bin, spawned };
}

const runs = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (spawned: string): number => (JSON.parse(readFileSync(spawned, "utf8")) as { pid: number }).pid;

describe("readOpenCodeVariants", () => {
  const api = fakeApi(1), never = fakeApi(Infinity);
  beforeAll(async () => { await Promise.all([api, never].map((f) => new Promise<void>((ok) => f.server.listen(0, "127.0.0.1", ok)))); });
  afterAll(() => { api.server.close(); never.server.close(); });

  it("starts a server of its own without the proxy, asks until the models are listed, and stops it", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-ocv-"));
    const { bin, spawned } = fakeBinary(home, api.port());
    const saved = { ...process.env };
    Object.assign(process.env, { HTTPS_PROXY: "http://proxy:1", OPENCODE_SERVER_PASSWORD: "leak", OPENCODE_PASSWORD: "inherited" });
    let found: Record<string, string[]>;
    try { found = await readOpenCodeVariants({ binary: bin, home: join(home, "opencode-exec"), askEveryMs: 5 }); }
    finally { for (const k of ["HTTPS_PROXY", "OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    // Each model with its levels in order; one that takes none has none.
    expect(found).toEqual({ "deepseek/deepseek-flash": ["none", "low", "high", "max"], "opencode/plain": [] });
    expect(api.calls).toEqual(Array(2).fill(`GET /api/model?directory=${encodeURIComponent(join(home, "opencode-exec"))}`));
    const seen = JSON.parse(readFileSync(spawned, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(seen.argv).toEqual(["serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1"]);
    expect(seen.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(seen.env.OPENCODE_PASSWORD).toMatch(/^[\w-]{20,}$/);
    expect(seen.env.OPENCODE_PASSWORD).not.toBe("inherited");
    expect(seen.env.HTTPS_PROXY).toBeUndefined();
    expect(seen.env.PWD).toBe(join(home, "opencode-exec"));
    // Stopped once it answered: not one of AgentSwitch's own ports any more.
    await vi.waitFor(() => expect(runs(pidOf(spawned))).toBe(false), { timeout: 4_000, interval: 10 });
    await vi.waitFor(() => expect(stdioServePorts()).not.toContain(api.port()), { timeout: 4_000, interval: 10 });
  });

  it("a server that never lists its models is given up on, and stopped; a program that does not start is an error", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-ocv2-"));
    const { bin, spawned } = fakeBinary(home, never.port());
    expect(await readOpenCodeVariants({ binary: bin, home: join(home, "x"), askEveryMs: 5, askForMs: 40 })).toEqual({});
    await vi.waitFor(() => expect(runs(pidOf(spawned))).toBe(false), { timeout: 4_000, interval: 10 });
    await expect(readOpenCodeVariants({ binary: join(home, "no-such-binary"), home: join(home, "y") })).rejects.toThrow(/opencode serve --stdio (failed to start|exited .* before it was ready)/);
  });
});
