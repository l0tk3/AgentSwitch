/** buildDaemon wires the enc:ref: wrapper around real-mode executors: a fake `secret-gate` CLI, a local listener as
 *  the proxy, an echo router and a capturing executor. No gate process, no model. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDaemon, defaultConfig, type Daemon } from "../src/daemon.js";
import type { ExecutionInput, Executor } from "../src/executors/types.js";
import { QuotaService } from "../src/quota/index.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson } from "./helpers.js";

const token = `enc:v1:${"W".repeat(40)}`;
const saved = { bin: process.env.SECRET_GATE_BIN, home: process.env.SECRET_GATE_HOME, proxy: process.env.SECRET_GATE_PROXY };
let dir = "", server: Server | null = null, daemon: Daemon | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentswitch-refs-wiring-"));
  const bin = join(dir, "secret-gate");
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const stdin = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
if (process.argv[3] === 'release') process.stdout.write(JSON.stringify({ released: 1 }));
else process.stdout.write(JSON.stringify({ refs: stdin.tokens.map((t, i) => ({ ref: 'enc:ref:' + String(i).padStart(16, 'W'), label: 'mail' })) }));
`, { mode: 0o700 });
  process.env.SECRET_GATE_BIN = bin;
  process.env.SECRET_GATE_HOME = join(dir, "gate-home");
});

afterEach(async () => {
  daemon?.close(); daemon = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  for (const [key, value] of [["SECRET_GATE_BIN", saved.bin], ["SECRET_GATE_HOME", saved.home], ["SECRET_GATE_PROXY", saved.proxy]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function listen(): Promise<number> {
  server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

function start(proxyPort: number): { daemon: Daemon; seen: ExecutionInput[] } {
  process.env.SECRET_GATE_PROXY = `http://127.0.0.1:${proxyPort}`;
  const seen: ExecutionInput[] = [];
  const executor: Executor = { harness: "claude-code", async run(input) { seen.push(input); return { ok: true, exitCode: 0, lastText: `logged in with ${input.task.split(" ").at(-1)}` }; } };
  const cfg = { ...defaultConfig({ AGENTSWITCH_HOME: join(dir, "home"), AGENTSWITCH_ROUTER: "echo", AGENTSWITCH_EXECUTORS: "real", AGENTSWITCH_TERMINALS: "0", AGENTSWITCH_BROWSER_HOST: "0" }), port: 0 };
  daemon = buildDaemon(cfg, { executors: [executor], router: echoRouter([decisionJson({ harness: "claude-code", model: "claude-sonnet-4-6", effort: null })]), quota: new QuotaService([]) });
  return { daemon, seen };
}

describe("daemon wiring of the enc:ref: wrapper (real executors)", () => {
  it("the executor reads references and gets a scope; the stored result keeps the ciphertext; the scope is released", async () => {
    const { daemon: d, seen } = start(await listen());
    const task = d.engine.submit({ task: `log in to mail.example with ${token}`, cwd: dir });
    await d.engine.idle();
    const ref = `enc:ref:${"0".padStart(16, "W")}`;
    expect(seen[0]!.task).toBe(`log in to mail.example with ${ref}`);
    expect(seen[0]!.gateScope).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(d.store.getTask(task.id)).toMatchObject({ status: "done", result: `logged in with ${token}` });
    const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; stdin: { scope: string; tokens?: string[] } });
    expect(calls.map((c) => c.argv)).toEqual([["refs", "register"], ["refs", "release"]]);
    expect(calls.map((c) => c.stdin.scope)).toEqual([seen[0]!.gateScope, seen[0]!.gateScope]);
    expect(calls[0]!.stdin.tokens).toEqual([token]);
    const stored = JSON.stringify(d.store.eventsSince(task.id));
    expect(stored).not.toContain(seen[0]!.gateScope!);
    expect(stored).not.toContain(ref);
  });

  it("with the proxy down the task fails once, clearly, and no harness ran", async () => {
    const port = await listen();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const { daemon: d, seen } = start(port);
    const task = d.engine.submit({ task: `log in to mail.example with ${token}`, cwd: dir });
    await d.engine.idle();
    expect(seen).toHaveLength(0);
    const done = d.store.getTask(task.id)!;
    expect(done.status).toBe("failed");
    expect(done.error).toContain("凭据网关未运行");
    expect(done.attempts.map((a) => a.kind)).toEqual(["gate_unavailable"]);
  });
});
