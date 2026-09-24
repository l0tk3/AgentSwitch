/** How each real executor ends a run it did not finish: cancelled by the engine, past its deadline, or failing while it
 *  sets up. Fake harness binaries and a mocked Agent SDK; no model is called. Each test runs with a private TMPDIR, so
 *  afterEach can check that the run removed every temp dir it made (Claude's run dir holds the 0600 MCP config file).
 *  Deadlines are either driven by fake timers or passed while the harness never answers: no assertion races a clock. */
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeExecutor } from "../src/executors/claude.js";
import { codexExecutor } from "../src/executors/codex.js";
import type { GateOptions } from "../src/executors/gate.js";
import { opencodeExecutor } from "../src/executors/opencode.js";
import type { ExecutionInput } from "../src/executors/types.js";
import { NO_AGENTS, NO_SIDE_EFFECTS } from "../src/core/outcome.js";

const { fakeQuery } = vi.hoisted(() => ({ fakeQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: fakeQuery }));

const REAL_TMP = tmpdir();
const savedTmp = process.env.TMPDIR;
let root = "";
let privateTmp = "";
let cwd = "";

beforeEach(() => {
  root = mkdtempSync(join(REAL_TMP, "agentswitch-lifecycle-"));
  privateTmp = join(root, "tmp"); mkdirSync(privateTmp);
  cwd = join(root, "cwd"); mkdirSync(cwd);
  process.env.TMPDIR = privateTmp;
});

afterEach(() => {
  vi.useRealTimers();
  fakeQuery.mockReset();
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  const left = readdirSync(privateTmp);
  rmSync(root, { recursive: true, force: true });
  expect(left).toEqual([]);
});

function input(over: Partial<ExecutionInput> = {}): ExecutionInput {
  return { taskId: "fixture", task: "fixture", brief: "fixture", cwd, model: "fixture-model", effort: null,
    handoffNote: null, context: null, knownTokens: new Set(), threadHome: null, resume: null, attachments: [], browser: false,
    signal: new AbortController().signal, emit: () => undefined, approve: async () => "allow", ask: async () => null, ...over };
}

function harness(name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return path;
}

const aborted = (signal: AbortSignal) => signal.aborted ? Promise.resolve()
  : new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
const gone = (pidFile: string) => { try { process.kill(Number(readFileSync(pidFile, "utf8")), 0); return false; } catch { return true; } };
const working = { type: "assistant", message: { content: [{ type: "text", text: "working" }, { type: "tool_use", name: "Write" }] } };
const failingSkills = { mcpFor: () => [], skillsInto: () => { throw new Error("skills fixture"); } };
const gate: GateOptions = { bin: "/g/secret-gate", home: "/h/.secret-gate", proxy: "http://127.0.0.1:8080", playwrightVersion: "0.0.82", allowedOrigins: [] };

describe("Claude executor stop", () => {
  const edits = { ...NO_SIDE_EFFECTS, filesChanged: 1 };

  it("cancelled while streaming: a stream that throws reports the error, no exit code, effects unknown", async () => {
    fakeQuery.mockImplementation(async function* ({ options }: { options: { abortController: AbortController } }) {
      yield working;
      await aborted(options.abortController.signal);
      throw new Error("aborted by fixture");
    });
    const ctl = new AbortController();
    const out = await claudeExecutor({ gate, maxMs: 60_000 }).run(input({ signal: ctl.signal, emit: (type) => { if (type === "text") ctl.abort(); } }));
    expect(out).toEqual({ ok: false, exitCode: null, stderr: "aborted by fixture", lastText: "working", timedOut: false, sideEffects: edits, sideEffectsKnown: false, tokens: 0, agents: NO_AGENTS });
    expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0);
  });

  it("cancelled while streaming: a stream that just ends is reported as cancelled", async () => {
    fakeQuery.mockImplementation(async function* ({ options }: { options: { abortController: AbortController } }) {
      yield working;
      await aborted(options.abortController.signal);
    });
    const ctl = new AbortController();
    const out = await claudeExecutor().run(input({ signal: ctl.signal, emit: (type) => { if (type === "text") ctl.abort(); } }));
    expect(out).toEqual({ ok: false, exitCode: null, stderr: "cancelled", lastText: "working", timedOut: false, sideEffects: edits, sideEffectsKnown: false, tokens: 0, agents: NO_AGENTS });
  });

  for (const throws of [false, true]) {
    it(`past its deadline (stream ${throws ? "throws" : "ends"} on abort): timed out after N ms, effects unknown`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fakeQuery.mockImplementation(async function* ({ options }: { options: { abortController: AbortController } }) {
        yield working;
        yield { type: "assistant", message: { content: [{ type: "text", text: "still working" }] } };
        await aborted(options.abortController.signal);
        if (throws) throw new Error("aborted by fixture");
      });
      const ctl = new AbortController();
      const pending = claudeExecutor({ gate, maxMs: 40 }).run(input({ signal: ctl.signal }));
      await vi.advanceTimersByTimeAsync(40);
      expect(await pending).toEqual({ ok: false, exitCode: null, stderr: "timed out after 40 ms", lastText: "working\nstill working", timedOut: true, sideEffects: edits, sideEffectsKnown: false, tokens: 0, agents: NO_AGENTS });
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0);
    });
  }

  it("a setup failure leaves no run dir, no deadline timer and no abort listener behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ctl = new AbortController();
    await expect(claudeExecutor({ gate, maxMs: 60_000, extensions: failingSkills }).run(input({ signal: ctl.signal }))).rejects.toThrow("skills fixture");
    expect(fakeQuery).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0);
  });
});

describe("Codex executor stop", () => {
  const authPath = () => { const path = join(root, "auth.json"); writeFileSync(path, "{}"); return path; };
  /** Answers every request (turn/start with one agent message) unless `silent`; never completes the turn. */
  const appServer = (pidFile: string, silent: boolean) => harness("fake-codex", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => { const m = JSON.parse(line); if (!m.id || ${silent}) return;
      send({ id: m.id, result: m.method === 'thread/start' ? { thread: { id: 't' } } : {} });
      if (m.method === 'turn/start') send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'working' } } });
    });`);

  it("cancelled while the turn runs: 'cancelled', the thread id kept, the app-server gone", async () => {
    const pidFile = join(root, "pid");
    const ctl = new AbortController();
    const out = await codexExecutor({ binary: appServer(pidFile, false), authPath: authPath(), maxMs: 60_000 })
      .run(input({ signal: ctl.signal, emit: (type) => { if (type === "text") ctl.abort(); } }));
    expect(out).toEqual({ ok: false, exitCode: 1, stderr: "cancelled", lastText: "working", sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: false, agents: NO_AGENTS, timedOut: false, sessionId: "t" });
    expect(gone(pidFile)).toBe(true);
    expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0);
  });

  it("past its deadline while the turn runs: the timeout is recorded as an error and as the stop reason", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pidFile = join(root, "pid");
    let turnRunning!: () => void;
    const running = new Promise<void>((resolve) => { turnRunning = resolve; });
    const pending = codexExecutor({ binary: appServer(pidFile, false), authPath: authPath(), maxMs: 50 })
      .run(input({ emit: (type) => { if (type === "text") turnRunning(); } }));
    await running;
    vi.advanceTimersByTime(50 + 1_000);   // the deadline, then the process-group grace period
    expect(await pending).toEqual({ ok: false, exitCode: 1, stderr: "timed out\ntimed out", lastText: "working", sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: false, agents: NO_AGENTS, timedOut: true, sessionId: "t" });
    expect(gone(pidFile)).toBe(true);
  });

  it("past its deadline before the app-server answers: the stopped RPC is the second error", async () => {
    const out = await codexExecutor({ binary: appServer(join(root, "pid"), true), authPath: authPath(), maxMs: 100 }).run(input());
    expect(out).toEqual({ ok: false, exitCode: 1, stderr: "timed out\nexecution stopped", lastText: "", sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: false, agents: NO_AGENTS, timedOut: true });
  });

  it("already cancelled: no RPC is sent to the stopped app-server", async () => {
    const ctl = new AbortController(); ctl.abort();
    const out = await codexExecutor({ binary: appServer(join(root, "pid"), false), authPath: authPath(), maxMs: 60_000 }).run(input({ signal: ctl.signal }));
    expect(out).toEqual({ ok: false, exitCode: 1, stderr: "app-server closed", lastText: "", sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: false, agents: NO_AGENTS, timedOut: false });
  });

  it("a missing auth.json leaves no temp CODEX_HOME behind", async () => {
    await expect(codexExecutor({ binary: "/nonexistent/codex", authPath: join(root, "missing-auth.json") }).run(input()))
      .rejects.toThrow(`${join(root, "missing-auth.json")} not found; run codex login`);
  });
});

describe("OpenCode executor stop", () => {
  it("cancelled after a tool call: the operation is counted, effects unknown, the process gone", async () => {
    const pidFile = join(root, "pid");
    const bin = harness("fake-opencode", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      console.log(JSON.stringify({ type: 'tool_use', part: { tool: 'mcp_submit' } })); setInterval(() => {}, 1000);`);
    const ctl = new AbortController();
    const out = await opencodeExecutor({ binary: bin, maxMs: 60_000 }).run(input({ signal: ctl.signal, emit: (type) => { if (type === "tool_call") ctl.abort(); } }));
    expect(out).toEqual({ ok: false, exitCode: null, stderr: "", lastText: "", timedOut: false, sideEffects: { ...NO_SIDE_EFFECTS, commandsRun: 1 }, sideEffectsKnown: false, agents: NO_AGENTS });
    expect(gone(pidFile)).toBe(true);
    expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0);
  });

  it("already cancelled: the process is stopped at once", async () => {
    const ctl = new AbortController(); ctl.abort();
    const bin = harness("fake-opencode", "console.log(JSON.stringify({ type: 'text', part: { text: 'done' } }));");
    const out = await opencodeExecutor({ binary: bin, maxMs: 60_000 }).run(input({ signal: ctl.signal }));
    expect(out).toMatchObject({ ok: false, timedOut: false, sideEffectsKnown: false });
  });

  it("past its deadline while silent: timed out, no exit code", async () => {
    const bin = harness("fake-opencode", "setInterval(() => {}, 1000);");
    const out = await opencodeExecutor({ binary: bin, maxMs: 100 }).run(input());
    expect(out).toEqual({ ok: false, exitCode: null, stderr: "", lastText: "", timedOut: true, sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: false, agents: NO_AGENTS });
  });

  it("a setup failure leaves no temp dir behind", async () => {   // afterEach checks the private TMPDIR is empty
    await expect(opencodeExecutor({ binary: "/nonexistent/opencode", extensions: failingSkills }).run(input())).rejects.toThrow("skills fixture");
  });
});
