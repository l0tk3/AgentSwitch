/** The OpenCode executor on its resident server (tech debt #8), against a fake v2 API (tests/fakeOpencodeServe.ts):
 *  what each execution configures and for whom, cleanup on every exit, resume, events, approvals, questions, the
 *  standalone fallback, and where secrets may and may not appear. No model, no real OpenCode. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/daemon.js";
import { NO_ANSWER_MESSAGE } from "../src/core/questions.js";
import type { McpServer } from "../src/extensions/types.js";
import type { GateOptions } from "../src/executors/gate.js";
import { executorInstructions, GUIDANCE_SEPARATOR } from "../src/executors/instructions.js";
import { opencodeExecConfig, opencodeExecutor } from "../src/executors/opencode.js";
import { OpenCodeExecServer, opencodeServeConfig } from "../src/executors/opencodeServer.js";
import { toRuleset } from "../src/executors/opencodeServeMap.js";
import { runOnServer, type ServeRunOptions } from "../src/executors/opencodeServeRun.js";
import type { ProtectedPaths } from "../src/executors/protected.js";
import type { ExecutionInput } from "../src/executors/types.js";
import type { TransferGrant } from "../src/core/transfer.js";
import { FakeOpenCode, until } from "./fakeOpencodeServe.js";

const gate: GateOptions = { bin: "/g/secret-gate", home: "/h/.secret-gate", proxy: "http://127.0.0.1:8080", playwrightVersion: "0.0.82", allowedOrigins: [] };
const scope = "Sc0pe_Fixture-0123456789abcdefgh";
const scoped = `http://scope:${scope}@127.0.0.1:8080`;
const transfer: TransferGrant = { source: ["crm.example.com"], destination: ["erp.example.com:8443"], fields: ["email"], purpose: "登记联系人" };
const repair = { url: "http://127.0.0.1:5555/credential-repair", key: "repair-key-fixture-0001" };
const prot: ProtectedPaths = { roots: ["/h/.agentswitch", "/h/.secret-gate"], exempt: [] };
const registry: McpServer = { name: "notes", kind: "stdio", command: "/bin/notes-mcp", args: ["--x"], env: { NOTES_TOKEN: "enc:v1:abc" }, headers: {}, enabled: true, harnesses: ["opencode"], approval: "ask", note: "" };

let root = "";
let fake: FakeOpenCode;
let server: OpenCodeExecServer;
const logs: string[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "agentswitch-ocserve-"));
  fake = new FakeOpenCode();
  await fake.start();
  server = new OpenCodeExecServer({ binary: "/nonexistent/opencode", home: join(root, "home"), config: {}, endpoint: { url: fake.url, password: fake.password }, log: (l) => logs.push(l) });
  logs.length = 0;
});

afterEach(async () => {
  await server.stop();
  await fake.stop();
  rmSync(root, { recursive: true, force: true });
});

function dir(name: string): string { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; }

type Events = { type: string; payload: Record<string, unknown> }[];

function input(cwd: string, over: Partial<ExecutionInput> = {}, events: Events = []): ExecutionInput {
  return { taskId: "t1", task: "copy the contact", brief: "copy the contact", cwd, model: "deepseek/deepseek-flash", effort: null,
    handoffNote: null, context: null, knownTokens: new Set(), threadHome: null, resume: null, attachments: [], browser: true,
    gateScope: scope, transfer, credentialRepair: repair, signal: new AbortController().signal,
    emit: (type, payload) => { events.push({ type, payload }); }, approve: async () => "deny", ask: async () => null, ...over };
}

const extensions = { mcpFor: () => [registry], skillsInto: (_h: string, dest: string) => { mkdirSync(join(dest, "demo"), { recursive: true }); writeFileSync(join(dest, "demo", "SKILL.md"), "---\nname: demo\n---\n"); return ["demo"]; } };
const opts = (over: Partial<ServeRunOptions> = {}): ServeRunOptions => ({ gate, browser: true, extensions, protected: prot, pollMs: 2, log: (l) => logs.push(l), ...over });

/** A standalone `opencode` that records what it got and answers with one text event. */
function standaloneBin(out: string): string {
  const bin = join(root, "fake-opencode");
  writeFileSync(bin, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({argv:process.argv.slice(2),proxy:process.env.HTTPS_PROXY}));console.log(JSON.stringify({type:'text',sessionID:'ses_standalone',part:{text:'standalone done'}}));`, { mode: 0o700 });
  return bin;
}

describe("OpenCode executor on the resident server: per-execution wiring", () => {
  it("session, shell env, MCP servers, permissions, instructions and prompt carry this execution's settings", async () => {
    const cwd = dir("work");
    let during: Record<string, Record<string, unknown>> = {};
    fake.script = async (t) => { during = fake.liveMcp(cwd) as typeof during; t.assistant([{ type: "text", text: "done" }]); };
    const events: Events = [];
    const r = await runOnServer(server, input(cwd, {}, events), opts());
    expect(r.kind).toBe("done");
    const outcome = r.kind === "done" ? r.outcome : null;
    expect(outcome).toMatchObject({ ok: true, lastText: "done", sessionId: "ses_1", sideEffectsKnown: true });
    const s = fake.sessions.get("ses_1")!;
    expect(s.directory).toBe(cwd);
    expect(s.agent).toBe("build");
    expect(s.model).toEqual({ providerID: "deepseek", id: "deepseek-flash" });
    const { permission } = opencodeExecConfig(gate, "", false, { protected: prot, skillsDir: server.skillsDir }) as { permission: Record<string, unknown> };
    expect(s.permissions).toEqual(toRuleset(permission));
    expect(s.permissions).toContainEqual({ action: "external_directory", resource: "/h/.agentswitch/*", effect: "deny" });
    expect(s.permissions).toContainEqual({ action: "external_directory", resource: `${server.skillsDir}/*`, effect: "ask" });
    expect(s.permissions).toContainEqual({ action: "webfetch", resource: "*", effect: "deny" });
    expect(s.permissions).toContainEqual({ action: "read", resource: "/h/.secret-gate/*", effect: "deny" });
    expect(s.permissions).toContainEqual({ action: "shell", resource: "*/h/.agentswitch*", effect: "deny" });
    // The shell env during the run: scoped proxy, gate home, NO_PROXY; never the repair capability or a server password.
    const env = s.envHistory[0]!;
    for (const k of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) expect(env[k]).toBe(scoped);
    expect(env.SECRET_GATE_HOME).toBe(gate.home);
    expect(env.NO_PROXY).toContain("api.deepseek.com");
    expect(env.PWD).toBe(cwd);
    expect(Object.keys(env).filter((k) => /REPAIR|OPENCODE_(SERVER_)?PASSWORD/.test(k))).toEqual([]);
    expect(s.instructions.agentswitch).toBe(executorInstructions());
    // MCP servers while the model ran: the gate's with scope, repair bridge and grant; the registry's with the plain proxy.
    const sg = during["secret-gate"] as { command: string[]; environment: Record<string, string> };
    expect(sg.command).toEqual(["/g/secret-gate", "mcp"]);
    expect(sg.environment).toMatchObject({ SECRET_GATE_SCOPE: scope, SECRET_GATE_REPAIR_KEY: repair.key, SECRET_GATE_REPAIR_URL: repair.url });
    const pw = during.playwright as { environment: Record<string, string> };
    expect(pw.environment.SECRET_GATE_SCOPE).toBe(scope);
    expect(JSON.parse(pw.environment.SECRET_GATE_TRANSFER!)).toEqual(transfer);
    expect(pw.environment.SECRET_GATE_REPAIR_KEY).toBeUndefined();
    const notes = during.notes as { command: string[]; environment: Record<string, string> };
    expect(notes.command).toEqual(["/bin/notes-mcp", "--x"]);
    expect(notes.environment.HTTPS_PROXY).toBe(gate.proxy);
    expect(notes.environment.SECRET_GATE_SCOPE).toBeUndefined();
    expect(Object.values(during).some((c) => "enabled" in c)).toBe(false);
    // Prompt: the grant is named, the scope is not. Skills landed in the shared dir.
    expect(s.prompts[0]).toContain("Authorized field transfer");
    expect(s.prompts[0]).not.toContain(scope);
    expect(readdirSync(server.skillsDir)).toEqual(["demo"]);
    expect(events.filter((e) => e.type === "transfer_grant")).toEqual([{ type: "transfer_grant", payload: { status: "applied", harness: "opencode" } }]);
    // Afterwards: MCP servers gone, the session's env no longer carries the scope, nothing ever went into a URL.
    expect(fake.liveMcp(cwd)).toEqual({});
    expect(s.env!.HTTPS_PROXY).toBe(gate.proxy);
    expect(JSON.stringify(s.env)).not.toContain(scope);
    expect(fake.requests.some((q) => q.path.includes(scope) || q.path.includes(repair.key))).toBe(false);
  });

  it("two executions in different directories at once: each location and session holds only its own scope", async () => {
    const [a, b] = [dir("a"), dir("b")];
    const scopes: Record<string, string> = { [a]: "Scope_A_000000000000000000000000", [b]: "Scope_B_111111111111111111111111" };
    const seen: Record<string, string> = {};
    let started = 0;
    fake.script = async (t) => {
      started++;
      await until(() => started === 2);   // both runs are inside their turn now
      seen[t.session.directory] = JSON.stringify({ mcp: fake.liveMcp(t.session.directory), env: t.session.env });
      t.assistant([{ type: "text", text: "ok" }]);
    };
    const [ra, rb] = await Promise.all([a, b].map((cwd) => runOnServer(server, input(cwd, { gateScope: scopes[cwd]! }), opts())));
    expect([ra!.kind, rb!.kind]).toEqual(["done", "done"]);
    expect(seen[a]).toContain(scopes[a]); expect(seen[a]).not.toContain(scopes[b]);
    expect(seen[b]).toContain(scopes[b]); expect(seen[b]).not.toContain(scopes[a]);
    expect([fake.liveMcp(a), fake.liveMcp(b)]).toEqual([{}, {}]);
  });

  it("a second execution in the same directory never reaches the server: it runs standalone", async () => {
    const cwd = dir("same");
    let release: () => void = () => undefined;
    fake.script = async (t) => { await new Promise<void>((r) => (release = r)); t.assistant([{ type: "text", text: "first" }]); };
    const first = runOnServer(server, input(cwd), opts());
    await until(() => fake.sessions.get("ses_1")?.active === true);
    const out = join(root, "standalone.json");
    const events: Events = [];
    const second = await opencodeExecutor({ server, binary: standaloneBin(out), gate, browser: false, log: (l) => logs.push(l) }).run(input(cwd, { gateScope: "Scope_Second_22222222222222222" }, events));
    expect(second).toMatchObject({ ok: true, lastText: "standalone done" });
    expect(JSON.parse(readFileSync(out, "utf8")).proxy).toBe("http://scope:Scope_Second_22222222222222222@127.0.0.1:8080");
    expect(events[0]).toEqual({ type: "text", payload: { text: "(OpenCode resident server not used: another execution is using this directory on the resident server; running opencode run --standalone)" } });
    expect(fake.requests.some((q) => q.body.includes("Scope_Second"))).toBe(false);
    release();
    expect((await first).kind).toBe("done");
  });

  it("the next execution in a directory never sees an earlier one's browser gate or scope; leftovers go first, or it runs standalone", async () => {
    const cwd = dir("seq");
    await runOnServer(server, input(cwd, { gateScope: "Scope_One_3333333333333333333333" }), opts());
    // A stale browser gate from a run whose cleanup failed (the server kept it): the next run must clear it.
    fake.mcp.set(cwd, new Map([["playwright", { type: "local", command: ["x"], environment: { SECRET_GATE_SCOPE: "Scope_One_3333333333333333333333" } }]]));
    let during = "";
    fake.script = async (t) => { during = JSON.stringify(fake.liveMcp(cwd)); t.assistant([{ type: "text", text: "ok" }]); };
    const r = await runOnServer(server, input(cwd, { gateScope: "Scope_Two_4444444444444444444444", browser: false }), opts());
    expect(r.kind).toBe("done");
    expect(during).toContain("Scope_Two"); expect(during).not.toContain("Scope_One"); expect(during).not.toContain("playwright");
    // Cleanup fails: the name is recorded and the next run clears it before adding its own ...
    fake.failures.push({ method: "DELETE", path: /\/api\/experimental\/mcp\/secret-gate/, status: 500, times: 1 });
    await runOnServer(server, input(cwd, { browser: false }), opts());
    expect(Object.keys(fake.liveMcp(cwd))).toEqual(["secret-gate"]);
    expect(logs.some((l) => l.includes("could not remove MCP server(s) secret-gate"))).toBe(true);
    const next = await runOnServer(server, input(cwd, { browser: false }), opts());
    expect(next.kind).toBe("done");
    expect(fake.liveMcp(cwd)).toEqual({});
    // ... and when it cannot, the run goes standalone instead of sharing the location.
    fake.mcp.set(cwd, new Map([["secret-gate", { environment: { SECRET_GATE_SCOPE: "old" } }]]));
    fake.failures.push({ method: "DELETE", path: /\/api\/experimental\/mcp\/secret-gate/, status: 500, times: 1 });
    const blocked = await runOnServer(server, input(cwd, { browser: false }), opts());
    expect(blocked).toEqual({ kind: "fallback", reason: expect.stringContaining("DELETE /api/experimental/mcp/secret-gate: HTTP 500") });
  });
});

describe("OpenCode executor on the resident server: stop, throw, resume", () => {
  it("cancelled mid-run: interrupted, effects unknown, MCP servers removed", async () => {
    const cwd = dir("abort");
    const ctl = new AbortController();
    fake.script = async (t) => { t.assistant([{ type: "tool", id: "c1", name: "shell", state: { status: "completed", input: { command: "ls" }, content: [] } }], { finish: "tool-calls" }); await t.interrupted; };
    const r = await runOnServer(server, input(cwd, { signal: ctl.signal, emit: (type) => { if (type === "tool_call") ctl.abort(); } }), opts());
    expect(r).toMatchObject({ kind: "done", outcome: { ok: false, sideEffectsKnown: false, sideEffects: { commandsRun: 1 } } });
    expect(fake.requests.some((q) => q.method === "POST" && q.path.endsWith("/interrupt"))).toBe(true);
    expect(fake.liveMcp(cwd)).toEqual({});
  });

  it("past its deadline: interrupted, timed out", async () => {
    const cwd = dir("deadline");
    fake.script = async (t) => { await t.interrupted; };
    const r = await runOnServer(server, input(cwd), opts({ maxMs: 20 }));
    expect(r).toMatchObject({ kind: "done", outcome: { ok: false, timedOut: true, sideEffectsKnown: false } });
    expect(fake.liveMcp(cwd)).toEqual({});
  });

  it("a throw inside the run still removes the MCP servers and frees the directory", async () => {
    const cwd = dir("throw");
    fake.script = async (t) => { t.assistant([{ type: "text", text: "hello" }]); };
    await expect(runOnServer(server, input(cwd, { emit: (type) => { if (type === "text") throw new Error("sink broke"); } }), opts())).rejects.toThrow("sink broke");
    expect(fake.liveMcp(cwd)).toEqual({});
    expect((await runOnServer(server, input(cwd), opts())).kind).toBe("done");   // lease released
  });

  it("resumes the thread's session in place; a missing or foreign one gets a new session", async () => {
    const cwd = dir("resume");
    const old = fake.newSession(cwd, { model: { providerID: "deepseek", id: "other" }, agent: "build" });
    const events: Events = [];
    const r = await runOnServer(server, input(cwd, { resume: old.id }, events), opts());
    expect(r).toMatchObject({ kind: "done", outcome: { ok: true, sessionId: old.id } });
    expect(fake.requests.some((q) => q.method === "POST" && q.path === "/api/session")).toBe(false);
    expect(old.permissions.length).toBeGreaterThan(0);                            // rules patched in
    expect(old.model).toEqual({ providerID: "deepseek", id: "deepseek-flash" });  // model switched to the verdict's
    expect(old.prompts).toHaveLength(1);
    expect(events[0]).toEqual({ type: "text", payload: { text: `(resuming OpenCode session ${old.id})` } });
    const missing: Events = [];
    const r2 = await runOnServer(server, input(cwd, { resume: "ses_gone" }, missing), opts());
    expect(r2).toMatchObject({ kind: "done", outcome: { ok: true } });
    expect(r2.kind === "done" && r2.outcome.sessionId).not.toBe("ses_gone");
    expect(missing[0]!.payload.text).toBe("(OpenCode refused to resume ses_gone: session not found; starting a new session)");
    const elsewhere = fake.newSession(dir("other"));
    const foreign: Events = [];
    await runOnServer(server, input(cwd, { resume: elsewhere.id }, foreign), opts());
    expect(foreign[0]!.payload.text).toContain("it belongs to another directory");
    expect(elsewhere.prompts).toEqual([]);
  });
});

describe("OpenCode executor on the resident server: events, approvals, questions, sub-agents", () => {
  it("text and tool calls become events; edits, operations and sub-agents are counted; a refusal is detected", async () => {
    const cwd = dir("events");
    const tool = (id: string, name: string, input: unknown, status = "completed") => ({ type: "tool", id, name, state: { status, input, content: [] } });
    fake.script = async (t) => {
      t.assistant([{ type: "reasoning", text: "…" }, { type: "text", text: "Working. " }, tool("a", "shell", { command: "make" }), tool("b", "edit", { filePath: "x" }), tool("c", "subagent", { description: "look around" })], { finish: "tool-calls" });
      t.assistant([{ type: "text", text: "All done." }]);
    };
    const events: Events = [];
    const r = await runOnServer(server, input(cwd, {}, events), opts());
    expect(events.filter((e) => e.type !== "transfer_grant")).toEqual([
      { type: "text", payload: { text: "Working. " } },
      { type: "tool_call", payload: { tool: "shell", input: { command: "make" } } },
      { type: "tool_call", payload: { tool: "edit", input: { filePath: "x" } } },
      { type: "tool_call", payload: { tool: "subagent", input: { description: "look around" } } },
      { type: "agent", payload: { harness: "opencode", agentId: "", status: "completed", description: "look around" } },
      { type: "text", payload: { text: "All done." } },
    ]);
    expect(r).toMatchObject({ kind: "done", outcome: { ok: true, lastText: "Working. All done.", sideEffects: { filesChanged: 1, commandsRun: 2, approvalsGranted: 0 }, agents: { spawned: 1, completed: 1, failed: 0 } } });
    fake.script = async (t) => { t.assistant([{ type: "text", text: "I can't help with that request." }]); };
    const refused = await runOnServer(server, input(cwd), opts());
    expect(refused).toMatchObject({ kind: "done", outcome: { ok: false, refusal: { source: "text" } } });
    fake.script = async (t) => { t.assistant([], { error: { type: "provider", message: "rate limit exceeded", status: 429 }, finish: "error" }); throw new Error("turn failed"); };
    const failed = await runOnServer(server, input(cwd), opts());
    expect(failed).toMatchObject({ kind: "done", outcome: { ok: false, exitCode: 1, httpStatus: 429, stderr: expect.stringContaining("rate limit exceeded") } });
  });

  it("rules that say ask go to the engine's approval flow; replies are once or reject, never always", async () => {
    const cwd = dir("approve");
    const decisions: string[] = [];
    fake.script = async (t) => {
      decisions.push(await t.ask("shell", ["rm -rf build"]));
      decisions.push(await t.ask("external_directory", ["/etc/*"]));
      t.assistant([{ type: "text", text: "ok" }]);
    };
    const asked: [string, string][] = [];
    const r = await runOnServer(server, input(cwd, { approve: async (action, evidence) => { asked.push([action, evidence]); return action.startsWith("Bash") ? "allow" : "deny"; } }), opts());
    expect(asked.map((a) => a[0])).toEqual(["Bash: rm -rf build", "OpenCode access outside cwd: /etc/*"]);
    expect(JSON.parse(asked[0]![1])).toMatchObject({ action: "shell", resources: ["rm -rf build"] });
    expect(decisions).toEqual(["once", "reject"]);
    expect(fake.replies.map((x) => x.body.decision)).toEqual(["once", "reject"]);
    expect(r).toMatchObject({ kind: "done", outcome: { sideEffects: { approvalsGranted: 1 } } });
  });

  it("the question tool goes to the engine's questions; no answer says so; other forms are cancelled", async () => {
    const cwd = dir("ask");
    const answers: unknown[] = [];
    const field = { key: "q0", type: "string", title: "Color", description: "Which color?", custom: true, options: [{ value: "Red", label: "Red" }, { value: "Blue", label: "Blue", description: "cool" }] };
    fake.script = async (t) => {
      answers.push(await t.form([field]));
      answers.push(await t.form([field]));
      answers.push(await t.form([{ key: "k", type: "string", description: "token" }], "oauth"));
      t.assistant([{ type: "text", text: "ok" }]);
    };
    let n = 0;
    const seen: unknown[] = [];
    await runOnServer(server, input(cwd, { ask: async (qs) => { seen.push(qs); return n++ === 0 ? { q0: ["Blue"] } : null; } }), opts());
    expect(seen[0]).toEqual([{ id: "q0", header: "Color", text: "Which color?", options: [{ label: "Red", description: "" }, { label: "Blue", description: "cool" }], multi: false, secret: false }]);
    expect(seen).toHaveLength(2);
    expect(answers).toEqual([{ q0: "Blue" }, { q0: NO_ANSWER_MESSAGE }, "cancelled"]);
  });

  it("sub-agent sessions get the execution's shell env and guidance as soon as they appear", async () => {
    const cwd = dir("child");
    let childEnv: Record<string, string> | null = null;
    fake.script = async (t) => {
      const c = t.child();
      await until(() => c.env !== null);
      childEnv = c.env; c.active = false;
      t.assistant([{ type: "text", text: "ok" }]);
    };
    await runOnServer(server, input(cwd), opts());
    expect(childEnv!.HTTPS_PROXY).toBe(scoped);
    const child = [...fake.sessions.values()].find((s) => s.parentID)!;
    expect(child.instructions.agentswitch).toBe(executorInstructions());
    expect(child.env!.HTTPS_PROXY).toBe(gate.proxy);   // scrubbed afterwards too
  });
});

describe("OpenCode executor on the resident server: fallback and secrets", () => {
  it("falls back to opencode run --standalone when the server is down or setup fails before the prompt", async () => {
    const out = join(root, "standalone.json");
    const down = new OpenCodeExecServer({ binary: join(root, "missing-opencode"), home: join(root, "down"), config: {}, log: () => undefined });
    const events: Events = [];
    const r = await opencodeExecutor({ server: down, binary: standaloneBin(out), gate, log: (l) => logs.push(l) }).run(input(dir("down"), {}, events));
    expect(r).toMatchObject({ ok: true, lastText: "standalone done" });
    expect(events[0]!.payload.text).toContain("OpenCode resident server not used");
    await down.stop();

    // Setup fails after the session and the first MCP server: both removed, one transfer_grant event (the fallback's).
    const cwd = dir("setup");
    fake.failures.push({ method: "PUT", path: /\/api\/experimental\/mcp\/playwright/, status: 500, times: 1 });
    const setup: Events = [];
    const r2 = await opencodeExecutor({ server, binary: standaloneBin(out), gate, log: (l) => logs.push(l) }).run(input(cwd, {}, setup));
    expect(r2).toMatchObject({ ok: true, lastText: "standalone done" });
    expect(fake.liveMcp(cwd)).toEqual({});
    expect(fake.sessions.size).toBe(0);   // the unused session was deleted
    expect(setup.filter((e) => e.type === "transfer_grant")).toHaveLength(1);

    // Rules not in effect (probe disagrees), a missing build agent, a refused prompt: standalone too.
    fake.evaluate = () => "allow";
    expect(await runOnServer(server, input(dir("probe")), opts())).toEqual({ kind: "fallback", reason: "the permission rules are not in effect on the resident server" });
    fake.evaluate = null;
    fake.agentsReady = false;
    expect(await runOnServer(server, input(dir("agent")), opts())).toEqual({ kind: "fallback", reason: "the build agent is not available in this directory" });
    fake.agentsReady = true;
    fake.failures.push({ method: "POST", path: /\/prompt$/, status: 409, times: 1 });
    expect(await runOnServer(server, input(dir("prompt")), opts())).toMatchObject({ kind: "fallback", reason: expect.stringContaining("HTTP 409") });
  });

  it("an unanswered probe ask is rejected at once and does not stay pending", async () => {
    fake.evaluate = (_s, action) => (action === "webfetch" ? "ask" : "deny");
    const r = await runOnServer(server, input(dir("probe-ask")), opts());
    expect(r.kind).toBe("fallback");
    expect(fake.permissions).toEqual([]);
    expect(fake.replies.every((x) => x.body.decision === "reject")).toBe(true);
  });

  it("scope, repair key and grant stay out of error text, logs and events even when the server echoes them", async () => {
    const cwd = dir("echo");
    const echoBody = JSON.stringify({ _tag: "InvalidRequestError", message: `bad config ${scope} ${repair.key}` });
    fake.failures.push({ method: "PUT", path: /\/api\/experimental\/mcp\/secret-gate/, status: 400, times: 1, body: echoBody });
    const out = join(root, "standalone.json");
    const events: Events = [];
    await opencodeExecutor({ server, binary: standaloneBin(out), gate, log: (l) => logs.push(l) }).run(input(cwd, {}, events));
    const text = JSON.stringify({ logs, events: events.filter((e) => e.type === "text") });
    expect(text).toContain("HTTP 400 InvalidRequestError");
    for (const secret of [scope, repair.key, JSON.stringify(transfer)]) expect(text).not.toContain(secret);
  });

  it("the server process: stdio mode, proxy-free env without repair vars, 0600 config without MCP, exits when stopped", async () => {
    const out = join(root, "spawned.json");
    const bin = join(root, "fake-serve");
    writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({argv:process.argv.slice(2),env:process.env}));console.log(JSON.stringify({url:'http://127.0.0.1:9'}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`, { mode: 0o700 });
    const home = join(root, "exec-home");
    const saved = { ...process.env };
    Object.assign(process.env, { HTTPS_PROXY: "http://proxy:1", SECRET_GATE_REPAIR_KEY: "k", OPENCODE_SERVER_PASSWORD: "leak" });
    const s = new OpenCodeExecServer({ binary: bin, home, config: opencodeServeConfig(gate, prot, join(home, "skills")), log: () => undefined });
    try { await s.start(); } finally { for (const k of ["HTTPS_PROXY", "SECRET_GATE_REPAIR_KEY", "OPENCODE_SERVER_PASSWORD"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    expect(s.running).toBe(true);
    const seen = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(seen.argv).toEqual(["serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1"]);
    expect(seen.env.HTTPS_PROXY).toBeUndefined();
    expect(seen.env.SECRET_GATE_REPAIR_KEY).toBeUndefined();
    expect(seen.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(seen.env.OPENCODE_PASSWORD).toMatch(/^[\w-]{20,}$/);
    expect(statSync(seen.env.OPENCODE_CONFIG!).mode & 0o777).toBe(0o600);
    const config = JSON.parse(readFileSync(seen.env.OPENCODE_CONFIG!, "utf8")) as Record<string, unknown>;
    expect(config.mcp).toBeUndefined();
    expect(config.permission).toMatchObject({ webfetch: "deny" });
    await s.stop();
    expect(s.running).toBe(false);
  });

  it("standalone fallback: the guidance rides at the head of the message, the rest is the serve path's prompt; no config instructions", async () => {
    const cwd = dir("guidance");
    await runOnServer(server, input(cwd, { handoffNote: "earlier attempt: tests were red", context: "- site: crm.example.com" }), opts());
    const served = fake.sessions.get("ses_1")!.prompts[0]!;
    const out = join(root, "standalone-guidance.json");
    const bin = join(root, "fake-opencode-config");
    writeFileSync(bin, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({argv:process.argv.slice(2),config:JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG,'utf8'))}));console.log(JSON.stringify({type:'text',sessionID:'ses_standalone',part:{text:'standalone done'}}));`, { mode: 0o700 });
    const r = await opencodeExecutor({ binary: bin, gate, browser: true, extensions, protected: prot, log: (l) => logs.push(l) }).run(input(dir("guidance-standalone"), { handoffNote: "earlier attempt: tests were red", context: "- site: crm.example.com" }));
    expect(r).toMatchObject({ ok: true, lastText: "standalone done" });
    const seen = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; config: Record<string, unknown> };
    expect(seen.argv.slice(0, 5)).toEqual(["run", "--standalone", "--format", "json", "-m"]);
    const message = seen.argv.at(-1)!;
    expect(message).toBe(`${executorInstructions()}${GUIDANCE_SEPARATOR}${served}`);
    expect(message).toContain("You are being run by AgentSwitch");   // EXECUTOR.md
    expect(message).toContain("secret_fill");                        // the gate's AGENTS.md
    expect(seen.config).not.toHaveProperty("instructions");
  });

  it("serve is the default executor mode; AGENTSWITCH_OPENCODE_EXECUTOR=run switches it off", () => {
    expect(defaultConfig({ HOME: "/h" }).opencodeExecutor).toBe("serve");
    expect(defaultConfig({ HOME: "/h", AGENTSWITCH_OPENCODE_EXECUTOR: "run" }).opencodeExecutor).toBe("run");
  });
});
