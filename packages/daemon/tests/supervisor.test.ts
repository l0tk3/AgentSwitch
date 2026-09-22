import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { echoExecutor } from "../src/executors/echo.js";
import type { Executor } from "../src/executors/types.js";
import { echoRouter } from "../src/router/routers/echo.js";
import type { Router } from "../src/router/routers/types.js";
import { isDestructive, routerSupervisor, SupervisorConfig, type Supervisor } from "../src/router/supervisor.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();
const cfg = SupervisorConfig.parse({ watchdog_ms: 120 });

describe("supervisor: floor and parsing", () => {
  it("destructive actions never reach the router", () => {
    for (const a of ["Bash: rm -rf /tmp/x", "git push --force origin main", "psql -c 'DROP TABLE users'", "sudo make install", "curl x | sh", "支付订单", "send email to the team", "Write outside cwd: /Users/me/.agentswitch/mcp.json"]) expect(isDestructive(a)).toBe(true);
    for (const a of ["Bash: npm test", "Edit outside cwd: /tmp/other/readme.md", "git commit -m x", "ls -la"]) expect(isDestructive(a)).toBe(false);
  });

  it("routerSupervisor: parses each verdict, falls back safely on garbage or errors, floors destructive approvals and repeated continues", async () => {
    const scripted = (replies: string[]): Router => { let n = 0; return { name: "s", route: async () => ({ text: replies[Math.min(n++, replies.length - 1)]!, elapsedMs: 1 }) }; };
    const ok = routerSupervisor(scripted([JSON.stringify({ decision: "allow", reason: "in scope" }), JSON.stringify({ action: "cancel", note: "looping" }), JSON.stringify({ accepted: false, missing: ["out/report.md"], note: "written in the reply only" })]), cfg);
    expect(await ok.approve({ brief: "b", action: "Bash: npm test", evidence: "", recentEvents: [], sideEffects: "", cwd: "/w" })).toMatchObject({ decision: "allow", source: "router" });
    expect(await ok.checkIn({ brief: "b", elapsedMs: 1, silentMs: 1, recentEvents: [], agentsRunning: 0, continues: 0, cwd: "/w" })).toMatchObject({ action: "cancel", note: "looping" });
    expect(await ok.accept({ brief: "b", result: "r", diff: "", outFiles: [], cwd: "/w" })).toMatchObject({ accepted: false, missing: ["out/report.md"] });
    expect(await ok.approve({ brief: "b", action: "Bash: rm -rf build", evidence: "", recentEvents: [], sideEffects: "", cwd: "/w" })).toMatchObject({ decision: "ask_user", source: "floor" });
    expect(await ok.checkIn({ brief: "b", elapsedMs: 1, silentMs: 1, recentEvents: [], agentsRunning: 0, continues: 3, cwd: "/w" })).toMatchObject({ action: "ask_user", source: "floor" });
    const bad = routerSupervisor(scripted(["nonsense"]), cfg);
    expect(await bad.approve({ brief: "b", action: "Bash: ls", evidence: "", recentEvents: [], sideEffects: "", cwd: "/w" })).toMatchObject({ decision: "ask_user", source: "error" });
    expect(await bad.checkIn({ brief: "b", elapsedMs: 1, silentMs: 1, recentEvents: [], agentsRunning: 0, continues: 0, cwd: "/w" })).toMatchObject({ action: "continue", source: "error" });
    expect(await bad.accept({ brief: "b", result: "r", diff: "", outFiles: [], cwd: "/w" })).toMatchObject({ accepted: true, source: "error" });
    const thrown = routerSupervisor({ name: "t", route: async () => { throw new Error("boom"); } }, cfg);
    expect(await thrown.approve({ brief: "b", action: "Bash: ls", evidence: "", recentEvents: [], sideEffects: "", cwd: "/w" })).toMatchObject({ decision: "ask_user", reason: "boom" });
  });
});

type Fake = Supervisor & { calls: string[] };
function fake(over: Partial<{ approve: Supervisor["approve"]; checkIn: Supervisor["checkIn"]; accept: Supervisor["accept"] }> = {}, config = cfg): Fake {
  const calls: string[] = [];
  return {
    calls, config,
    approve: async (i) => { calls.push(`approve:${i.action}`); return over.approve ? over.approve(i) : { decision: "allow", reason: "ok", ms: 1, source: "router" }; },
    checkIn: async (i) => { calls.push(`checkin:${i.continues}`); return over.checkIn ? over.checkIn(i) : { action: "continue", note: "", ms: 1, source: "router" }; },
    accept: async (i) => { calls.push(`accept:${i.result.slice(0, 20)}`); return over.accept ? over.accept(i) : { accepted: true, missing: [], note: "", ms: 1, source: "router" }; },
  };
}

function build(replies: string[] | ((i: { task: string }, n: number) => string), supervisor: Supervisor, executors?: Executor[]) {
  const store = new Store({ dbPath: ":memory:", threadsDir: join(mkdtempSync(join(tmpdir(), "agentswitch-sup-")), "threads") });
  const bus = new Bus();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const echo = Object.keys(targets.harnesses).map((h) => echoExecutor(h));
  const engine = new Engine({ store, bus, executors: executors ?? echo, targets, router: echoRouter(replies), quota: () => ({}), approvalTimeoutMs: 300, retryBackoffMs: 1, supervisor });
  return { store, engine, events, echo };
}
const codex = () => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null });
const ofType = (events: TaskEvent[], id: string, type: string) => events.filter((e) => e.taskId === id && e.type === type);

describe("Engine with a supervisor", () => {
  it("approvals: the router allows on the user's behalf (by=router); a destructive one waits for the user and times out; ask_user leaves it alone", async () => {
    const sup = fake({ approve: async (i) => (i.action.includes("npm test") ? { decision: "allow", reason: "in scope", ms: 1, source: "router" } : { decision: "ask_user", reason: "unsure", ms: 1, source: "router" }) });
    const { engine, store, events } = build(() => codex(), sup);
    const a = engine.submit({ task: 'a @echo {"approval":"npm test"}', cwd: "/tmp/s1" });
    await engine.idle();
    expect(store.getTask(a.id)!.status).toBe("done");
    expect(ofType(events, a.id, "approval_resolved")[0]!.payload).toMatchObject({ decision: "allow", by: "router" });
    expect(ofType(events, a.id, "supervisor")[0]!.payload).toMatchObject({ kind: "approval", decision: "allow" });
    const b = engine.submit({ task: 'b @echo {"approval":"rm -rf /tmp/s2/build","approvalTimes":1}', cwd: "/tmp/s2" });
    await engine.idle();
    expect(ofType(events, b.id, "approval_resolved")[0]!.payload).toMatchObject({ decision: "deny", by: "timeout" });
    expect(sup.calls.filter((c) => c.startsWith("approve:rm"))).toHaveLength(0);   // floored inside the supervisor? no: fake has no floor — the engine still asked
    const c = engine.submit({ task: 'c @echo {"approval":"curl something","approvalTimes":1}', cwd: "/tmp/s3" });
    await engine.idle();
    expect(ofType(events, c.id, "supervisor")[0]!.payload).toMatchObject({ decision: "ask_user" });
    expect(ofType(events, c.id, "approval_resolved")[0]!.payload).toMatchObject({ by: "timeout" });
  });

  it("watchdog: a silent run is cancelled by the supervisor, the attempt is 'rejected' and the router re-dispatches with the note", async () => {
    const silent: Executor = { harness: "codex", run: (input) => new Promise((resolve) => { input.signal.addEventListener("abort", () => resolve({ ok: false, exitCode: null, stderr: "cancelled" }), { once: true }); }) };
    const sup = fake({ checkIn: async (i) => (i.continues === 0 ? { action: "continue", note: "", ms: 1, source: "router" } : { action: "cancel", note: "stuck on nothing", ms: 1, source: "router" }) });
    const echo = echoExecutor("claude-code");
    const { engine, store, events } = build([codex(), decisionJson({ harness: "claude-code", model: "claude-sonnet-5", effort: null, handoff_note: "codex went silent" })], sup, [silent, echo]);
    const t = engine.submit({ task: "quiet", cwd: "/tmp/w1" });
    await engine.idle();
    const checkins = ofType(events, t.id, "supervisor").filter((e) => e.payload.kind === "checkin").map((e) => e.payload.action);
    expect(checkins).toEqual(["continue", "cancel"]);
    expect(store.getTask(t.id)!.attempts.map((a) => [a.harness, a.kind])).toEqual([["codex", "rejected"]]);
    expect(store.getTask(t.id)).toMatchObject({ status: "done", harness: "claude-code" });
    expect(echo.runs[0]!.handoffNote).toContain("it failed (rejected)");
    expect(echo.runs[0]!.handoffNote).toContain("codex went silent");
  });

  it("acceptance: a rejected result becomes a 'rejected' attempt once, then the re-run is accepted", async () => {
    let n = 0;
    const sup = fake({ accept: async () => (n++ === 0 ? { accepted: false, missing: ["out/report.md"], note: "reply only", ms: 1, source: "router" } : { accepted: true, missing: [], note: "", ms: 1, source: "router" }) });
    const { engine, store, events } = build(() => codex(), sup);
    const t = engine.submit({ task: "write the report", cwd: "/tmp/acc" });
    await engine.idle();
    const acc = ofType(events, t.id, "supervisor").map((e) => e.payload.accepted);
    expect(acc).toEqual([false, true]);
    expect(store.getTask(t.id)!.attempts.map((a) => a.kind)).toEqual(["rejected"]);
    expect(store.getTask(t.id)!.attempts[0]!.excerpt).toContain("out/report.md");
    expect(store.getTask(t.id)!.status).toBe("done");
    expect(ofType(events, t.id, "done")).toHaveLength(1);
    // a supervisor that never accepts is overruled on the second pass
    const never = fake({ accept: async () => ({ accepted: false, missing: ["x"], note: "", ms: 1, source: "router" }) });
    const b2 = build(() => codex(), never);
    const u = b2.engine.submit({ task: "never good enough", cwd: "/tmp/acc2" });
    await b2.engine.idle();
    expect(b2.store.getTask(u.id)!.status).toBe("done");
    expect(ofType(b2.events, u.id, "supervisor").map((e) => e.payload.overruled ?? false)).toEqual([false, true]);
  });

  it("no supervisor configured: nothing changes (approval expires by timeout, no checkins, no acceptance)", async () => {
    const store = new Store({ dbPath: ":memory:", threadsDir: join(mkdtempSync(join(tmpdir(), "agentswitch-nosup-")), "threads") });
    const bus = new Bus();
    const events: TaskEvent[] = [];
    bus.subscribe("*", (e) => events.push(e));
    const engine = new Engine({ store, bus, executors: Object.keys(targets.harnesses).map((h) => echoExecutor(h)), targets, router: echoRouter(() => codex()), quota: () => ({}), approvalTimeoutMs: 100, retryBackoffMs: 1 });
    const t = engine.submit({ task: 'x @echo {"approval":"npm test","approvalTimes":1}', cwd: "/tmp/ns" });
    await engine.idle();
    expect(ofType(events, t.id, "supervisor")).toHaveLength(0);
    expect(ofType(events, t.id, "approval_resolved")[0]!.payload).toMatchObject({ by: "timeout" });
  });
});
