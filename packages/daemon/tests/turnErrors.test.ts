/** A turn that ended on the model API's error (a 400, say), for the agents that did not say so (acp/bench.md, user
 *  #125): what each one's own file or server says of it — Antigravity's error step in its conversation's file, OpenCode's
 *  `idle` row and `session.execution.failed`, pi's answer with `stopReason: "error"`, Claude Code's `isApiErrorMessage`
 *  — becomes a note of the record (`Error: …`), and the terminal's turn ends as a failed one where the service did not
 *  know (Antigravity, OpenCode). Shapes as agy 1.5.18, OpenCode 2, pi 1.6.0 and Claude Code 2.1.332 wrote them against
 *  a stand-in answering 400 (2026-11-28). Nothing here starts an agent or reads the user's files. */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { basicAuth, type StdioServe } from "../src/harness/opencodeStdio.js";
import { spawnOwned } from "../src/harness/processes.js";
import { agyErrorOf, agyErrors, agyMessages, agyTranscript } from "../src/sessions/agy.js";
import { SessionMonitor, type SessionSources } from "../src/sessions/monitor.js";
import { openCodeMessages } from "../src/sessions/opencode.js";
import { piMessages } from "../src/sessions/pi.js";
import { readRecord, recordFromMessages } from "../src/sessions/record.js";
import { errorNote } from "../src/sessions/types.js";
import { TerminalHost, type Companion, type CompanionLink, type Launcher } from "../src/terminals/host.js";
import { HOOK_SCRIPT } from "../src/terminals/launch.js";
import { OpenCodeCompanion, openCodeFailure } from "../src/terminals/opencodeTerminal.js";
import { runError } from "../src/terminals/piExtension.js";

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

const tmp = (name: string): string => realpathSync(mkdtempSync(join(tmpdir(), `agentswitch-turnerr-${name}-`)));
const line = (o: unknown) => JSON.stringify(o);
const ITEMS = (items: readonly { type: string; text?: string }[]) => items.map((i) => [i.type, i.text ?? ""]);

/** What the stand-in answered, as each agent kept it. */
const API_JSON = `{"code":400,"message":"bench: request refused (E400)","status":"INVALID_ARGUMENT","type":"invalid_request_error"}`;

// ── Protobuf, as Antigravity writes its steps ───────────────────────────────────────────────────────────────────────

function varint(n: number): number[] {
  const out: number[] = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
const pbInt = (field: number, n: number) => [...varint(field * 8), ...varint(n)];
const pbBytes = (field: number, b: readonly number[]) => [...varint(field * 8 + 2), ...varint(b.length), ...b];
const pbText = (field: number, s: string) => pbBytes(field, [...Buffer.from(s, "utf8")]);

/** An error step's payload as agy 1.5.18 wrote it (its fields as seen; the stack trace and ids left out). */
function errorStep(at: number, detail: string): Uint8Array {
  const when = [...pbInt(1, Math.floor(at / 1000)), ...pbInt(2, (at % 1000) * 1e6)];
  const meta = [...pbBytes(1, when), ...pbInt(3, 5)];
  const error = [...pbText(1, "Agent execution terminated due to error."), ...pbText(2, detail), ...pbText(3, `${detail}\n(1) attached stack trace`), ...pbInt(7, 400)];
  return new Uint8Array([...pbInt(1, 17), ...pbInt(4, 3), ...pbBytes(5, meta), ...pbBytes(24, pbBytes(3, error))]);
}
const AGY_DETAIL = "agent executor error: generating and executing: Error 400, Message: bench: request refused (E400), Status: INVALID_ARGUMENT, Details: []";
const A = "a351c1cc-b89b-4864-b864-b3cdb46bafa8";

/** An Antigravity home with one conversation: a turn answered, then one that ended on a 400 (its prompt in the
 *  transcript, its error a step of the conversation's file alone). */
function agyHomeWith(errorAt: number) {
  const root = tmp("agy");
  const home = join(root, "gem", "antigravity-cli");
  mkdirSync(join(home, "conversations"), { recursive: true });
  const index = new DatabaseSync(join(home, "conversation_summaries.db"));
  index.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL, parent_conversation_id text NOT NULL DEFAULT '', killed numeric NOT NULL DEFAULT false)");
  index.prepare("INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris) VALUES (?, ?, ?, ?)")
    .run(A, "Bench", new Date(errorAt).toISOString().replace("T", " ").replace("Z", "+00:00"), JSON.stringify(["file:///Users/u/code/fan"]));
  index.close();
  const conv = new DatabaseSync(join(home, "conversations", `${A}.db`));
  conv.exec("CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))");
  const step = conv.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)");
  step.run(0, 14, new Uint8Array([8, 14]));
  step.run(1, 15, new Uint8Array([8, 15]));
  step.run(2, 14, new Uint8Array([8, 14]));
  step.run(3, 17, errorStep(errorAt, AGY_DETAIL));
  conv.close();
  const transcript = agyTranscript(home, A);
  mkdirSync(dirname(transcript), { recursive: true });
  const t = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  writeFileSync(transcript, [
    line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: t(errorAt - 9000), content: "<USER_REQUEST>\nBENCH-p0 answer\n</USER_REQUEST>" }),
    line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: t(errorAt - 8000), content: "c00 c01" }),
    line({ step_index: 2, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: t(errorAt - 1000), content: "<USER_REQUEST>\nBENCH-pE400 answer\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>" }),
  ].join("\n") + "\n");
  return { root, home, transcript };
}

describe("a turn that ended on the API's error, in the record", () => {
  it("the note says what the API said: its message out of the JSON, with the status the agent put before it", () => {
    expect(errorNote(`400: ${API_JSON}`)).toBe("Error: 400 bench: request refused (E400)");
    expect(errorNote(`{"error": {"message": "quota exceeded"}}`)).toBe("Error: quota exceeded");
    expect(errorNote("socket hang up\nat x")).toBe("Error: socket hang up");
    expect(errorNote("")).toBe("Error: 这一轮出错结束");
  });

  it("Antigravity: its error step, read out of the conversation's file, is a note after the prompt; the messages leave it out", () => {
    const at = Date.parse("2026-11-28T01:42:28.481Z");
    const { root, home } = agyHomeWith(at);
    expect(agyErrorOf(errorStep(at, AGY_DETAIL))).toEqual({ at, text: "Error: 400 bench: request refused (E400)" });
    // Another shape of detail: without the program's own lead-in; nothing that is not a payload of that shape.
    expect(agyErrorOf(errorStep(at, "agent executor error: model unreachable"))?.text).toBe("Error: model unreachable");
    expect(agyErrorOf(new Uint8Array([8, 17]))).toBeNull();
    expect(agyErrorOf(new Uint8Array([0xff, 0xff]))).toBeNull();
    expect(agyErrors(home, A)).toEqual([{ n: 3, at, text: "Error: 400 bench: request refused (E400)" }]);
    expect(agyErrors(home, "not-an-id")).toEqual([]);
    expect(agyMessages(home, A, 10).map((m) => [m.role, m.text, m.at])).toEqual([
      ["user", "BENCH-p0 answer", 0], ["assistant", "c00 c01", 1], ["user", "BENCH-pE400 answer", 2], ["note", "Error: 400 bench: request refused (E400)", 3]]);
    const sources: SessionSources = { claudeProjects: join(root, "claude"), codexSessions: join(root, "codex"), opencodeDb: join(root, "none.db"), agyHome: home, excluded: ["/tmp/"] };
    const monitor = new SessionMonitor(sources);
    expect(ITEMS(monitor.record("agy", A)!.record.items).slice(-2)).toEqual([["user", "BENCH-pE400 answer"], ["note", "Error: 400 bench: request refused (E400)"]]);
    expect(monitor.read("agy", A)!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("OpenCode: the `idle` row that says how the turn ended — failed with the API's message, interrupted", () => {
    const db = join(tmp("oc"), "opencode.db");
    const d = new DatabaseSync(db);
    d.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
    const row = d.prepare("INSERT INTO session_message VALUES (?, 's1', ?, ?, ?, ?)");
    row.run("m1", "user", 1, 1, line({ text: "BENCH-pESC answer" }));
    row.run("m2", "assistant", 5, 2, line({ content: [{ type: "text", text: "c00 c01 " }], finish: "error", error: { type: "aborted", message: "Step interrupted" } }));
    row.run("m3", "idle", 13, 3, line({ outcome: "interrupted" }));
    row.run("m4", "user", 16, 4, line({ text: "BENCH-pE400 answer" }));
    row.run("m5", "assistant", 17, 5, line({ content: [], finish: "error", error: { type: "provider.invalid-request", message: "bench: request refused (E400)", status: 400 } }));
    row.run("m6", "idle", 19, 6, line({ outcome: "failed", error: { type: "provider.invalid-request", message: "bench: request refused (E400)", status: 400, response: { body: API_JSON } } }));
    row.run("m7", "idle", 23, 7, line({ outcome: "succeeded" }));
    d.close();
    const messages = openCodeMessages(db, "s1", 50)!;
    expect(ITEMS(recordFromMessages(messages, "r").items)).toEqual([
      ["user", "BENCH-pESC answer"], ["answer", "c00 c01"], ["note", "Interrupted"], ["user", "BENCH-pE400 answer"], ["note", "Error: bench: request refused (E400)"]]);
  });

  it("pi: an answer that stopped on an error is a note with what pi wrote of it; one you stopped, Interrupted after what it had written", () => {
    const file = join(tmp("pi"), "s.jsonl");
    writeFileSync(file, [
      line({ type: "session", id: "p1", timestamp: "2026-11-28T00:52:20Z", cwd: "/w" }),
      line({ type: "message", timestamp: "2026-11-28T00:52:30Z", message: { role: "user", content: [{ type: "text", text: "BENCH-r0 answer" }] } }),
      line({ type: "message", timestamp: "2026-11-28T00:52:31Z", message: { role: "assistant", content: [{ type: "text", text: "c00 c01" }], stopReason: "aborted" } }),
      line({ type: "message", timestamp: "2026-11-28T00:52:33Z", message: { role: "user", content: [{ type: "text", text: "BENCH-E400 answer" }] } }),
      line({ type: "message", timestamp: "2026-11-28T00:52:33Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: `400: ${API_JSON}` } }),
    ].join("\n") + "\n");
    expect(ITEMS(recordFromMessages(piMessages(file, 50), "r").items)).toEqual([
      ["user", "BENCH-r0 answer"], ["answer", "c00 c01"], ["note", "Interrupted"], ["user", "BENCH-E400 answer"], ["note", "Error: 400 bench: request refused (E400)"]]);
  });

  it("Claude Code: what it wrote as its own answer of an API error is a note, not an answer of the model's", () => {
    const file = join(tmp("claude"), "s.jsonl");
    writeFileSync(file, [
      line({ type: "user", uuid: "u1", timestamp: "2026-11-28T00:44:01.966Z", message: { role: "user", content: "BENCH-E400 answer" }, origin: { kind: "human" } }),
      line({ type: "assistant", uuid: "a1", timestamp: "2026-11-28T00:44:02.200Z", error: "unknown", isApiErrorMessage: true, message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error: 400 bench: request refused (E400)" }] } }),
    ].join("\n") + "\n");
    expect(ITEMS(readRecord("claude-code", file)!.items)).toEqual([["user", "BENCH-E400 answer"], ["note", "Error: 400 bench: request refused (E400)"]]);
  });
});

// ── The terminal's turn ──────────────────────────────────────────────────────────────────────────────────────────────

const fakeLauncher = (url: () => string): Launcher => (req) => ({
  file: process.execPath,
  args: [FAKE],
  env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: url(), AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken },
  hooks: true,
});

describe("a turn that ended on the API's error, in the terminal", () => {
  it("Antigravity: its status line said idle all along; an error step written since the terminal began ends the turn as a failed one, once", async () => {
    let error: { at: number; text: string } | null = { at: Date.now() - 60_000, text: "Error: an old one" };
    const asked: string[] = [];
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9"), agyError: (id) => { asked.push(id); return error; } });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "agy", cwd: tmpdir(), mode: "manual" });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    let at = 100;
    const says = (payload: Record<string, unknown>) => host.hook(info.id, token, { event: "AgyStatus", payload: { at: ++at, ...payload } });
    await says({ agent_state: "idle", session_id: "" });
    expect(asked).toEqual([]);   // no conversation yet: nothing to look in
    // A turn answered: its error step from before this terminal began is not this terminal's.
    await says({ agent_state: "working", session_id: A });
    await says({ agent_state: "idle", session_id: A });
    expect(asked).toEqual([A]);
    expect(host.lastTurn(info.id)).toMatchObject({ ok: true });
    // A 400: back before it says `working` — idle readings alone, and the step written just after the first.
    await says({ agent_state: "idle", session_id: A });
    error = { at: Date.now(), text: "Error: 400 bench: request refused (E400)" };
    await says({ agent_state: "idle", session_id: A });
    expect(host.get(info.id)!.status).toBe("idle");
    expect(host.lastTurn(info.id)).toMatchObject({ ok: false, line: "Error: 400 bench: request refused (E400)" });
    // The same step is told of once: a turn answered after it ends well.
    await says({ agent_state: "working", session_id: A });
    await says({ agent_state: "idle", session_id: A });
    expect(host.lastTurn(info.id)).toMatchObject({ ok: true });
  });

  it("Antigravity: a step written after the last reading is found by the second look", async () => {
    let error: { at: number; text: string } | null = null;
    let looks = 0;
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9"), agyError: () => { looks++; return error; } });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "agy", cwd: tmpdir(), mode: "manual" });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    await host.hook(info.id, token, { event: "AgyStatus", payload: { at: 1, agent_state: "idle", session_id: A } });
    expect(looks).toBe(1);
    error = { at: Date.now(), text: "Error: 400 late" };
    await until(() => host.lastTurn(info.id)?.ok === false, 3000);
    expect(looks).toBe(2);
    expect(host.lastTurn(info.id)).toMatchObject({ ok: false, line: "Error: 400 late" });
  });

  it("pi: a run whose last answer stopped on an error says so at its end, and the turn is a failed one; Claude Code's says what it showed", async () => {
    expect(runError({ messages: [{ role: "user" }, { role: "assistant", content: [], stopReason: "error", errorMessage: `400: ${API_JSON}` }] })).toBe(`400: ${API_JSON}`);
    expect(runError({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "first" }, { role: "assistant", stopReason: "stop" }] })).toBeNull();
    expect(runError({ messages: [{ role: "assistant", stopReason: "aborted" }] })).toBeNull();
    expect(runError({})).toBeNull();
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9") });
    closers.push(() => host.closeAll());
    const token = (id: string) => (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(id)!.hookToken;
    const pi = await host.spawn({ harness: "pi", cwd: tmpdir(), mode: "manual" });
    await host.hook(pi.id, token(pi.id), { event: "PiAgentStart", payload: {} });
    await host.hook(pi.id, token(pi.id), { event: "PiAgentEnd", payload: { error: `400: ${API_JSON}` } });
    expect(host.get(pi.id)!.status).toBe("idle");
    expect(host.lastTurn(pi.id)).toMatchObject({ ok: false, line: "Error: 400 bench: request refused (E400)" });
    // Its settling after it (the same hook, nothing more to say) leaves it so.
    await host.hook(pi.id, token(pi.id), { event: "PiAgentEnd", payload: {} });
    expect(host.lastTurn(pi.id)).toMatchObject({ ok: false });
    await host.hook(pi.id, token(pi.id), { event: "PiAgentStart", payload: {} });
    await host.hook(pi.id, token(pi.id), { event: "PiAgentEnd", payload: {} });
    expect(host.lastTurn(pi.id)).toMatchObject({ ok: true });
    // Claude Code: its StopFailure names a 400's kind `unknown`; what it showed says what went wrong.
    const claude = await host.spawn({ harness: "claude-code", cwd: tmpdir(), mode: "manual" });
    await host.hook(claude.id, token(claude.id), { event: "UserPromptSubmit", payload: { prompt: "BENCH-E400" } });
    await host.hook(claude.id, token(claude.id), { event: "StopFailure", payload: { error: "unknown", last_assistant_message: "API Error: 400 bench: request refused (E400)" } });
    expect(host.lastTurn(claude.id)).toMatchObject({ ok: false, line: "Error: 400 bench: request refused (E400)" });
  });

  it("OpenCode: its server's `session.execution.failed` reaches the terminal, which ends the turn as a failed one with the API's message", async () => {
    expect(openCodeFailure({ sessionID: "s", error: { type: "provider.invalid-request", message: "bench: request refused (E400)", status: 400 } })).toBe("Error: bench: request refused (E400)");
    // The companion: its server's event stream says the turn failed.
    const password = "pw-e";
    const server = createServer((req, res) => {
      if (req.headers.authorization !== basicAuth(password)) { res.writeHead(401).end(); return; }
      const path = (req.url ?? "").split("?")[0]!;
      if (path === "/api/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        send({ type: "session.execution.started", data: { sessionID: "ses_a" } });
        send({ type: "session.execution.interrupted", data: { sessionID: "ses_a", reason: "user" } });
        send({ type: "session.execution.failed", data: { sessionID: "ses_a", error: { type: "provider.invalid-request", message: "bench: request refused (E400)", status: 400 } } });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: path === "/api/session/active" ? {} : [] }));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    closers.push(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const serve = async (): Promise<StdioServe> => {
      const child = spawnOwned(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"], { stdio: ["pipe", "ignore", "ignore"] });
      closers.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
      return { child, url, password, stderrTail: () => "" };
    };
    const c = new OpenCodeCompanion({ binary: "/bin/opencode", cwd: tmpdir(), env: {}, args: [], asks: true, pollMs: 10, serve });
    closers.push(() => c.stop());
    await c.start();
    const failed: string[] = [];
    const link: CompanionLink = { status: () => undefined, ask: async () => null, failed: (said) => { failed.push(said); } };
    c.attach(link);
    await until(() => failed.length > 0);
    expect(failed).toEqual(["Error: bench: request refused (E400)"]);

    // The host: the turn ends as a failed one, the terminal at rest.
    class Scripted implements Companion {
      link: CompanionLink | null = null;
      async start() { return { args: [FAKE], env: process.env as Record<string, string> }; }
      attach(l: CompanionLink) { this.link = l; }
      stop() { /* nothing */ }
    }
    const companion = new Scripted();
    const host = new TerminalHost({ launcher: () => ({ file: process.execPath, args: ["-e", "process.exit(3)"], env: process.env as Record<string, string>, hooks: false, companion }) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "opencode", cwd: tmpdir() });
    await until(() => companion.link);
    companion.link!.status("idle");
    companion.link!.failed!("Error: bench: request refused (E400)");
    expect(host.get(info.id)!.status).toBe("idle");
    expect(host.lastTurn(info.id)).toMatchObject({ ok: false, line: "Error: bench: request refused (E400)" });
    // A look after it that says idle does not make it a turn that ended well.
    companion.link!.status("idle");
    expect(host.lastTurn(info.id)).toMatchObject({ ok: false });
  });
});
