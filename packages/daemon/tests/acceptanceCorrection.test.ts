/** A result the acceptance check rejects goes back to the executor that wrote it (router-v0 §6.2, 2026-09-24): same
 *  target, its own session resumed, the reason in its handoff — even when it ran commands, since checking its own work
 *  is exactly what it can do. One correction; a second rejection ends the task as before. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import type { ExecutionInput, Executor } from "../src/executors/types.js";
import type { ExecutionOutcome } from "../src/core/outcome.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { SupervisorConfig, type Supervisor } from "../src/router/supervisor.js";
import { decisionJson, realTargets } from "./helpers.js";

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

/** A listing that ran 20 commands (ls): "side effects" by count, nothing changed. */
const listed = (text: string, session: string): ExecutionOutcome => ({ ok: true, lastText: text, sideEffects: { filesChanged: 0, commandsRun: 20, approvalsGranted: 0 }, sideEffectsKnown: true, sessionId: session });

function build(verdicts: boolean[]) {
  const store = new Store({ dbPath: ":memory:", threadsDir: join(mkdtempSync(join(tmpdir(), "agentswitch-correct-")), "threads") });
  stores.push(store);
  const bus = new Bus();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const runs: ExecutionInput[] = [];
  const executor: Executor = { harness: "opencode", async run(input) {
    runs.push(input);
    return runs.length === 1 ? listed("共 17 个项目：（表格只列了 15 个）", "s-1") : listed("核对后共 17 个项目，完整列表如下……", "s-1");
  } };
  const supervisor: Supervisor = {
    config: SupervisorConfig.parse({ watchdog_ms: 60_000 }),
    approve: async () => ({ decision: "ask_user", reason: "", ms: 0, source: "router" }),
    checkIn: async () => ({ action: "continue", note: "", ms: 0, source: "router" }),
    accept: async () => (verdicts.shift() ?? true
      ? { accepted: true, missing: [], note: "", ms: 0, source: "router" }
      : { accepted: false, missing: ["项目清单不完整：正文称 17 个，表格只列 15 个"], note: "计数自相矛盾", ms: 0, source: "router" }),
  };
  const router = echoRouter(() => decisionJson({ harness: "opencode", model: "deepseek/deepseek-flash", effort: null }));
  const engine = new Engine({ store, bus, executors: [executor], targets: realTargets(), router, supervisor, quota: () => ({}), retryBackoffMs: 1 });
  return { engine, store, events, runs };
}

describe("acceptance correction", () => {
  it("a rejected result with commands run goes back to the same executor, in its session, with the reason", async () => {
    const f = build([false, true]);
    const t = f.engine.submit({ task: "列出 Projects 下的项目", cwd: mkdtempSync(join(tmpdir(), "agentswitch-correct-cwd-")) });
    await f.engine.idle();
    expect(f.store.getTask(t.id)).toMatchObject({ status: "done", result: "核对后共 17 个项目，完整列表如下……" });
    expect(f.runs).toHaveLength(2);
    expect(f.runs.map((r) => [r.model, r.resume])).toEqual([["deepseek/deepseek-flash", null], ["deepseek/deepseek-flash", "s-1"]]);
    expect(f.runs[1]!.handoffNote).toMatch(/验收.*项目清单不完整[\s\S]*先只读地核对/);
    expect(f.events.filter((e) => e.type === "redispatch").map((e) => e.payload)).toEqual([expect.objectContaining({ kind: "correction" })]);
  });

  it("a second rejection ends the task with the reason, no further runs", async () => {
    const f = build([false, false]);
    const t = f.engine.submit({ task: "列出 Projects 下的项目", cwd: mkdtempSync(join(tmpdir(), "agentswitch-correct-cwd-")) });
    await f.engine.idle();
    expect(f.runs).toHaveLength(2);
    expect(f.store.getTask(t.id)?.status).toBe("partial");
    expect(f.store.getTask(t.id)?.error).toMatch(/项目清单不完整/);
  });
});
