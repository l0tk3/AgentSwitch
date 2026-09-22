import { describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { echoExecutor } from "../src/executors/echo.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { RoutingLog } from "../src/router/log.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();

function build(routerReplies: string[] | ((input: { task: string }, n: number) => string), opts: { quota?: Record<string, number> } = {}) {
  const store = new Store({ dbPath: ":memory:" });
  const bus = new Bus();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const executors = Object.keys(targets.harnesses).map((h) => echoExecutor(h));
  const router = echoRouter(routerReplies);
  const routingLog = new RoutingLog(":memory:");
  const engine = new Engine({ store, bus, executors, targets, router, quota: () => opts.quota ?? {}, approvalTimeoutMs: 200, retryBackoffMs: 1, routingLog });
  return { store, bus, engine, events, executors, router, routingLog };
}

const types = (events: TaskEvent[], id: string) => events.filter((e) => e.taskId === id).map((e) => e.type);

describe("Engine", () => {
  it("an approval left unanswered when the task ends is expired, and neither that nor a late answer revives the task", async () => {
    const { store, events, bus } = build([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    const executor = { harness: "codex", async run(input: { approve: (a: string, e: string) => Promise<string> }) { void input.approve("cp x y", "outside cwd"); return { ok: true, exitCode: 0, lastText: "moved on without waiting" }; } };
    const eng = new Engine({ store, bus, executors: [executor as never], targets, router: echoRouter([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]), quota: () => ({}), approvalTimeoutMs: 10_000, retryBackoffMs: 1 });
    const t = eng.submit({ task: "x", cwd: "/tmp" });
    await eng.idle();
    expect(store.getTask(t.id)!.status).toBe("done");
    expect(store.pendingApprovals(t.id)).toEqual([]);
    const resolved = events.find((e) => e.taskId === t.id && e.type === "approval_resolved");
    expect(resolved?.payload).toMatchObject({ status: "expired" });
    expect(store.getTask(t.id)!.status).toBe("done");
  });

  it("queued → routed → dispatched → done, with the brief from the router", async () => {
    const { engine, store, events, executors } = build([decisionJson({ harness: "codex", model: "gpt-5.5", effort: "low", brief: "rewritten brief" })]);
    const t = engine.submit({ task: "do the thing", cwd: "/tmp" });
    expect(t.status).toBe("queued");
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "done", harness: "codex", model: "gpt-5.5", effort: "low", brief: "rewritten brief" });
    expect(types(events, t.id)).toEqual(["queued", "routed", "thread", "dispatched", "text", "done"]);
    expect(executors.find((e) => e.harness === "codex")!.runs[0]).toMatchObject({ brief: "rewritten brief", model: "gpt-5.5", effort: "low", browser: false });
  });

  it("every routing decision lands in the routing log; browser flag reaches the executor", async () => {
    const { engine, routingLog, executors, router } = build([
      decisionJson({ harness: "claude-code", model: "claude-sonnet-5", effort: null, needs_browser: true }),
      decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, needs_browser: true }),
    ]);
    engine.submit({ task: 'open the site @echo {"fail":"refusal","failTimes":1}', cwd: "/tmp" });
    await engine.idle();
    expect(router.calls).toHaveLength(2);
    expect(routingLog.recent().map((r) => [r.source, r.harness])).toEqual([["router", "codex"], ["router", "claude-code"]]);
    expect(executors.find((e) => e.harness === "claude-code")!.runs[0]!.browser).toBe(true);
    expect(executors.find((e) => e.harness === "codex")!.runs[0]!.browser).toBe(true);
  });

  it("approval: task waits, allow continues to done; deny ends in task_failed → router → done", async () => {
    const { engine, store, events, bus } = build([decisionJson({ harness: "claude-code", model: "claude-sonnet-5", effort: null })]);
    const t = engine.submit({ task: 'delete stuff @echo {"approval":"rm -rf /tmp/x"}', cwd: "/tmp" });
    const approvalId = await new Promise<string>((resolve) => bus.subscribe(t.id, (e) => { if (e.type === "approval_request") resolve(String(e.payload.approvalId)); }));
    expect(store.getTask(t.id)!.status).toBe("waiting_approval");
    expect(store.pendingApprovals(t.id)).toHaveLength(1);
    expect(engine.resolveApproval(approvalId, "allow")).toBe(true);
    await engine.idle();
    expect(store.getTask(t.id)!.status).toBe("done");
    expect(types(events, t.id)).toContain("approval_resolved");
    expect(engine.resolveApproval(approvalId, "allow")).toBe(false);  // already resolved
  });

  it("approval times out → denied → executor reports failure → router asked → second executor finishes", async () => {
    const { engine, store, router } = build([
      decisionJson({ harness: "claude-code", model: "claude-sonnet-5", effort: null }),
      decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, handoff_note: "user did not approve rm" }),
    ]);
    const t = engine.submit({ task: 'x @echo {"approval":"rm -rf /","approvalTimes":1}', cwd: "/tmp" });
    await engine.idle();
    const done = store.getTask(t.id)!;
    expect(done.status).toBe("done");
    expect(done.attempts.map((a) => [a.harness, a.kind])).toEqual([["claude-code", "task_failed"]]);
    expect(done.routerAsks).toBe(1);
    expect(done.harness).toBe("codex");
    expect(router.calls[1]!.task).toContain("Previous attempts");
    expect(store.pendingApprovals()).toEqual([]);
  });

  it("quota failure switches along the fallback chain without asking the router", async () => {
    const { engine, store, events, router } = build([decisionJson({ harness: "codex", model: "gpt-6-astra", effort: null, fallbacks: [{ harness: "claude-code", model: "claude-haiku-4-5-20251001" }] })]);
    const t = engine.submit({ task: 'x @echo {"fail":"quota","failTimes":1}', cwd: "/tmp" });
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "done", harness: "claude-code", model: "claude-haiku-4-5-20251001" });
    expect(router.calls).toHaveLength(1);
    const redispatch = events.find((e) => e.taskId === t.id && e.type === "redispatch");
    expect(redispatch?.payload).toMatchObject({ kind: "switch", target: { harness: "claude-code" } });
  });

  it("transport failure retries the same target once, then succeeds", async () => {
    const { engine, store, events } = build([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    const t = engine.submit({ task: 'x @echo {"fail":"transport","failTimes":1}', cwd: "/tmp" });
    await engine.idle();
    expect(store.getTask(t.id)!.status).toBe("done");
    expect(types(events, t.id).filter((x) => x === "dispatched")).toHaveLength(2);
    expect(events.find((e) => e.taskId === t.id && e.type === "redispatch")?.payload).toMatchObject({ kind: "retry" });
  });

  it("gate denial stops with a security flag", async () => {
    const { engine, store, events } = build([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    const t = engine.submit({ task: 'x @echo {"fail":"gate_denied"}', cwd: "/tmp" });
    await engine.idle();
    expect(store.getTask(t.id)!.status).toBe("failed");
    expect(events.find((e) => e.taskId === t.id && e.type === "failed")?.payload).toMatchObject({ security: true });
  });

  it("refusal: router gives up → failed with its reason", async () => {
    const { engine, store } = build([
      decisionJson({ harness: "claude-code", model: "claude-sonnet-5", effort: null }),
      decisionJson({ harness: "codex", action: "give_up", reason: "nothing listed can do this" }),
    ]);
    const t = engine.submit({ task: 'x @echo {"fail":"refusal"}', cwd: "/tmp" });
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "failed", error: "router gave up: nothing listed can do this" });
  });

  it("no verdict at all fails the task; pin skips the router", async () => {
    const { engine, store, router } = build([decisionJson()]);
    const t = engine.submit({ task: "x", cwd: "/tmp", pin: { harness: "codex", model: "gpt-9" } });
    await engine.idle();
    expect(store.getTask(t.id)!.status).toBe("failed");
    expect(store.getTask(t.id)!.error).toContain("not in catalog");
    expect(router.calls).toHaveLength(0);
    const ok = engine.submit({ task: "y", cwd: "/tmp", pin: { harness: "opencode", model: "deepseek/deepseek-flash" } });
    await engine.idle();
    expect(store.getTask(ok.id)).toMatchObject({ status: "done", harness: "opencode" });
  });

  it("cancel aborts a running task and denies its pending approval", async () => {
    const { engine, store, bus, events } = build([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    const t = engine.submit({ task: 'x @echo {"approval":"rm"}', cwd: "/tmp" });
    await new Promise<void>((resolve) => bus.subscribe(t.id, (e) => { if (e.type === "approval_request") resolve(); }));
    expect(engine.cancel(t.id)?.status).toBe("cancelled");
    await engine.idle();
    expect(store.getTask(t.id)!.status).toBe("cancelled");
    expect(store.pendingApprovals()).toEqual([]);
    expect(types(events, t.id)).toContain("cancelled");
    expect(engine.cancel("nope")).toBeUndefined();
    expect(engine.cancel(t.id)?.status).toBe("cancelled");
  });

  it("tasks run one after another and done events carry tokens", async () => {
    const { engine, store, events } = build([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    const a = engine.submit({ task: 'a @echo {"delayMs":20,"tokens":100}', cwd: "/tmp" });
    const b = engine.submit({ task: 'b @echo {"tokens":5}', cwd: "/tmp" });
    await engine.idle();
    const doneA = events.find((e) => e.taskId === a.id && e.type === "done")!;
    const doneB = events.find((e) => e.taskId === b.id && e.type === "done")!;
    expect(doneA.ts).toBeLessThanOrEqual(doneB.ts);
    expect(doneA.payload.tokens).toBe(100);
    expect(store.usageSince(0)).toEqual({ codex: 105 });
  });
});

describe("follow-ups", () => {
  it("a child task carries the parent's text and result to the router and, via the brief, to the executor", async () => {
    const { engine, store, router, executors } = build((input) => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, brief: input.task.split("User now says:\n")[1] ?? input.task }));
    const parent = engine.submit({ task: '找一下 Obsidian 库 @echo {"result":"有 3 个库：A、B、C。需要看哪个？"}', cwd: "/tmp" });
    await engine.idle();
    const child = engine.submit({ task: "看 A 里有哪些笔记", cwd: "/tmp", parentId: parent.id });
    await engine.idle();
    expect(store.getTask(child.id)).toMatchObject({ status: "done", parentId: parent.id });
    const routerSaw = router.calls[1]!.task;
    expect(routerSaw).toContain("Earlier turns");
    expect(routerSaw).toContain("有 3 个库：A、B、C");
    expect(routerSaw).toContain("User now says:\n看 A 里有哪些笔记");
    expect(executors.find((e) => e.harness === "codex")!.runs.at(-1)!.brief).toBe("看 A 里有哪些笔记");
    engine.submit({ task: "第二条", cwd: "/tmp", parentId: child.id });
    await engine.idle();
    expect(router.calls[2]!.task.split("User:").length - 1).toBe(2);   // both earlier turns
  });
});
