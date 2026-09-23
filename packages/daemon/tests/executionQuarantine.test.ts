import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { ExecutionOutcome } from "../src/router/failure.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { realTargets } from "./helpers.js";

it("blocks a new writer and deletion until an unresponsive cancelled executor actually settles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-execution-quarantine-"));
  const cwd = join(dir, "work"), elsewhere = join(dir, "elsewhere");
  mkdirSync(cwd); mkdirSync(elsewhere);
  const marker = join(cwd, "in-progress.txt"); writeFileSync(marker, "keep until executor stops");
  const store = new Store({ dbPath: ":memory:", threadsDir: join(dir, "threads") });
  const thread = store.createThread(cwd);
  let settle!: (outcome: ExecutionOutcome) => void, runs = 0;
  const pending = new Promise<ExecutionOutcome>((resolve) => { settle = resolve; });
  const ok = { ok: true, lastText: "verified fixture", sideEffects: { filesChanged: 0, commandsRun: 0, approvalsGranted: 0 } };
  const engine = new Engine({ store, bus: new Bus(), targets: realTargets(), router: echoRouter([]), quota: () => ({}),
    executors: [{ harness: "codex", async run() { return ++runs === 1 ? pending : ok; } }],
  });
  const submit = (path: string, threadId?: string, ephemeral = false) => engine.submit({ task: "fixture", cwd: path, ephemeral, ...(threadId ? { threadId } : {}), pin: { harness: "codex", model: "gpt-5.5" } });
  try {
    const original = submit(cwd, thread.id, true);
    await vi.waitUntil(() => runs === 1);
    engine.cancel(original.id);
    await engine.idle(); // bounded teardown completes, but the execution promise is still pending
    expect(existsSync(marker)).toBe(true);
    expect(engine.deleteTask(original.id)).toMatchObject({ ok: false, code: "busy" });
    const sameCwd = submit(cwd);
    const sameThread = submit(elsewhere, thread.id);
    await engine.idle();
    for (const task of [sameCwd, sameThread]) {
      expect(store.getTask(task.id)).toMatchObject({ status: "blocked", error: expect.stringContaining("尚未退出") });
      expect(store.eventsSince(task.id).some((event) => event.type === "dispatched")).toBe(false);
    }
    const independent = submit(elsewhere);
    await engine.idle();
    expect(store.getTask(independent.id)?.status).toBe("done");
    expect(runs).toBe(2);
    settle(ok);
    await new Promise((resolve) => setImmediate(resolve));
    const successor = submit(cwd, thread.id);
    await engine.idle();
    expect(store.getTask(original.id)?.status).toBe("cancelled");
    expect(store.getTask(successor.id)?.status).toBe("done");
    expect(runs).toBe(3);
    expect(engine.deleteTask(original.id)).toEqual({ ok: true });
  } finally {
    settle(ok);
    for (const task of store.listTasks()) engine.cancel(task.id);
    await engine.idle(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
}, 6000);
