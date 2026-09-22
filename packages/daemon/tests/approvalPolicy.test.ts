import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalPolicy, categoriesOf, DEFAULT_POLICY, loadPolicy, savePolicy, whoAnswers } from "../src/engine/approvalPolicy.js";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { echoExecutor } from "../src/executors/echo.js";
import { echoRouter } from "../src/router/routers/echo.js";
import type { Supervisor } from "../src/router/supervisor.js";
import { SupervisorConfig } from "../src/router/supervisor.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();

describe("approval policy", () => {
  it("categorises actions and routes them by mode", () => {
    expect(categoriesOf("Bash: rm -rf build")).toEqual(["delete", "shell"]);
    expect(categoriesOf("Edit outside cwd: /etc/hosts")).toEqual(["outside_cwd"]);
    expect(categoriesOf("Bash: git push origin main")).toEqual(["shell", "git_push"]);
    expect(categoriesOf("Bash: npm test")).toEqual(["shell"]);
    expect(categoriesOf("mcp__playwright__browser_click")).toEqual(["browser"]);
    expect(whoAnswers({ mode: "manual", human: [] }, "Bash: ls")).toMatchObject({ who: "user" });
    expect(whoAnswers({ mode: "auto", human: ["delete"] }, "Bash: rm -rf /")).toMatchObject({ who: "router" });
    expect(whoAnswers(DEFAULT_POLICY, "Bash: rm -rf build")).toMatchObject({ who: "user", because: "reserved: delete" });
    expect(whoAnswers(DEFAULT_POLICY, "Bash: npm test")).toMatchObject({ who: "router" });
    expect(whoAnswers({ mode: "scoped", human: ["shell"] }, "Bash: npm test")).toMatchObject({ who: "user" });
    expect(DEFAULT_POLICY).toEqual({ mode: "scoped", human: ["delete", "git_push", "irreversible"] });
  });

  it("policy file round-trips; missing or broken file → default", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-pol-"));
    const path = join(dir, "approvals.json");
    expect(loadPolicy(path)).toEqual(DEFAULT_POLICY);
    savePolicy(path, ApprovalPolicy.parse({ mode: "auto" }));
    expect(loadPolicy(path)).toEqual({ mode: "auto", human: ["delete", "git_push", "irreversible"] });
    expect(loadPolicy(undefined)).toEqual(DEFAULT_POLICY);
  });
});

function fakeSupervisor(calls: string[]): Supervisor {
  return {
    config: SupervisorConfig.parse({ watchdog_ms: 0, acceptance: false }),
    approve: async (i) => { calls.push(`${i.action}|floor=${i.floor}`); return { decision: "allow", reason: "ok", ms: 1, source: "router" }; },
    checkIn: async () => ({ action: "continue", note: "", ms: 1, source: "router" }),
    accept: async () => ({ accepted: true, missing: [], note: "", ms: 1, source: "router" }),
  };
}

function build(replies: string[] | ((i: { task: string }, n: number) => string), supervisor?: Supervisor, policyPath?: string) {
  const store = new Store({ dbPath: ":memory:", threadsDir: join(mkdtempSync(join(tmpdir(), "agentswitch-pe-")), "threads") });
  const bus = new Bus();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const engine = new Engine({ store, bus, executors: Object.keys(targets.harnesses).map((h) => echoExecutor(h)), targets, router: echoRouter(replies), quota: () => ({}), approvalTimeoutMs: 200, retryBackoffMs: 1, ...(supervisor ? { supervisor } : {}), ...(policyPath ? { policyPath } : {}) });
  return { store, engine, events, bus };
}
const codex = () => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null });
const resolved = (events: TaskEvent[], id: string) => events.filter((e) => e.taskId === id && e.type === "approval_resolved").map((e) => e.payload);

describe("Engine: approval policy", () => {
  it("scoped (default): a reserved category waits for the user, the rest goes to the router; auto drops the floor; manual never asks the router; a task override wins", async () => {
    const calls: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-polf-"));
    const policyPath = join(dir, "approvals.json");
    const { engine, events } = build(() => codex(), fakeSupervisor(calls), policyPath);
    const a = engine.submit({ task: 'a @echo {"approval":"rm -rf build","approvalTimes":1}', cwd: "/tmp/p1" });
    const b = engine.submit({ task: 'b @echo {"approval":"npm test"}', cwd: "/tmp/p2" });
    await engine.idle();
    expect(resolved(events, a.id)[0]).toMatchObject({ by: "timeout" });
    expect(resolved(events, b.id)[0]).toMatchObject({ by: "router" });
    expect(calls).toEqual(["bash: npm test|floor=true"]);
    savePolicy(policyPath, ApprovalPolicy.parse({ mode: "auto" }));
    const c = engine.submit({ task: 'c @echo {"approval":"rm -rf build"}', cwd: "/tmp/p3" });
    await engine.idle();
    expect(resolved(events, c.id)[0]).toMatchObject({ by: "router" });
    expect(calls.at(-1)).toBe("bash: rm -rf build|floor=false");
    const d = engine.submit({ task: 'd @echo {"approval":"npm test","approvalTimes":1}', cwd: "/tmp/p4", approval: { mode: "manual", human: [] } });
    await engine.idle();
    expect(resolved(events, d.id)[0]).toMatchObject({ by: "timeout" });
    expect(calls).toHaveLength(2);
    expect(events.find((e) => e.taskId === d.id && e.type === "supervisor")!.payload).toMatchObject({ decision: "ask_user", source: "policy", reason: "manual mode" });
  });
});

describe("Engine: the router asks the user (clarify)", () => {
  const clarify = (q: string) => JSON.stringify({ harness: "codex", model: "gpt-5.5", brief: "?", confidence: 0.3, action: "clarify", question: q });

  it("a clarify decision raises a question card; the answer is appended and the task re-routed; deny/timeout fails the task", async () => {
    const { engine, store, events, bus } = build([clarify("哪个财务系统？"), codex()]);
    const t = engine.submit({ task: "登录财务系统", cwd: "/tmp/q1" });
    const approvalId = await new Promise<string>((resolve) => bus.subscribe(t.id, (e) => { if (e.type === "approval_request") resolve(String(e.payload.approvalId)); }));
    expect(store.getApproval(approvalId)).toMatchObject({ kind: "question", action: "哪个财务系统？" });
    expect(store.getTask(t.id)!.status).toBe("waiting_approval");
    expect(engine.answer(approvalId, "core 那个，8600 端口")).toBe(true);
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "done", harness: "codex" });
    expect(store.getApproval(approvalId)).toMatchObject({ status: "allowed", answer: "core 那个，8600 端口" });
    expect(resolved(events, t.id)[0]).toMatchObject({ decision: "answer", kind: "question", by: "user" });
    expect(engine.answer(approvalId, "again")).toBe(false);
    const { engine: e2, store: s2 } = build([clarify("要哪个？")]);
    const u = e2.submit({ task: "x", cwd: "/tmp/q2" });
    await e2.idle();
    expect(s2.getTask(u.id)).toMatchObject({ status: "failed", error: expect.stringContaining("waiting for your answer: 要哪个？") });
  });

  it("stops after two clarification rounds", async () => {
    const { engine, store, bus } = build(() => clarify("再问一次？"));
    const t = engine.submit({ task: "x", cwd: "/tmp/q3" });
    bus.subscribe(t.id, (e) => { if (e.type === "approval_request") setTimeout(() => engine.answer(String(e.payload.approvalId), "答"), 5); });
    await engine.idle();
    expect(store.getTask(t.id)!.status).toBe("failed");
    expect(store.getTask(t.id)!.error).toContain("kept asking");
  });
});
