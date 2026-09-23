import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { platformExperience, taskPlatformOrigins } from "../src/engine/platformContext.js";
import { echoExecutor } from "../src/executors/echo.js";
import { composePrompt } from "../src/executors/instructions.js";
import { QuotaService } from "../src/quota/index.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { loadPlatformMemory, rememberPlatformFacts } from "../src/threads/platformMemory.js";
import { decisionJson, TARGETS_PATH } from "./helpers.js";

const dispose: (() => void)[] = [];
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-platform-integration-"));
  dispose.push(() => rmSync(home, { recursive: true, force: true }));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  const router = echoRouter([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
  const executor = echoExecutor("codex");
  const daemon = buildDaemon(cfg, { router, executors: [executor], quota: new QuotaService([]) });
  dispose.push(() => daemon.close());
  const source = daemon.store.createTask({ task: "检查站点", cwd: home });
  daemon.store.updateTask(source.id, { status: "done" });
  const memory = join(home, "platform-memory.json");
  const note = "The import page has a country selector.";
  const now = Date.now();
  for (const origin of ["https://admin.example:8443", "https://other.example"]) {
    const result = rememberPlatformFacts(memory, [{ origin, key: "form.country", text: note, kind: "operation", eventSeq: 1, quote: note }],
      { taskId: source.id, task: origin, checkpoints: [{ seq: 1, ts: now, purpose: "verify", ok: true, result: note, sideEffectsKnown: true, sideEffects: { filesChanged: 0, commandsRun: 1, approvalsGranted: 0 } }], now });
    expect(result.added).toHaveLength(1);
  }
  return { ...daemon, home, memory, router, executor, source, now };
}

describe("platform experience across daemon boundaries", () => {
  it("selects an exact destination or a user-maintained alias, never a host prefix or another port", () => {
    const context = "- maillib: https://admin.example:8443\n- other: https://other.example\n";
    expect(taskPlatformOrigins("登录maillib检查表单", context)).toEqual(["https://admin.example:8443"]);
    expect(taskPlatformOrigins("inspect admin.example:8443", context)).toEqual(["https://admin.example:8443"]);
    expect(taskPlatformOrigins("inspect admin.example:9999", context)).toEqual([]);
    expect(taskPlatformOrigins("inspect admin.example:8443.evil", context)).toEqual([]);
    const f = fixture();
    expect(platformExperience(f.memory, "https://admin.example:8443", context)).toContain("form");
    expect(platformExperience(f.memory, "https://admin.example:8443", context)).not.toContain("other.example");
    expect(platformExperience(f.memory, "http://admin.example:8443", context)).toBeNull();
    expect(platformExperience(f.memory, "https://admin.example:8443", context, f.now + 31 * 86400_000)).toBeNull();
  });

  it("gives selected experience to both router and pinned executor without turning it into user context or credentials", async () => {
    const f = fixture();
    writeFileSync(join(f.home, "CONTEXT.md"), "- maillib: https://admin.example:8443\n");
    writeFileSync(join(f.home, "MEMORY.md"), "- legacy opaque value enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA\n");
    f.engine.submit({ task: "登录maillib检查表单", cwd: f.home });
    await f.engine.idle();
    expect(f.router.calls[0]!.system).toContain("country selector");
    expect(f.router.calls[0]!.system).not.toContain("other.example");
    const first = f.executor.runs[0]!;
    expect(first.platformMemory).toContain("country selector");
    expect(first.context).not.toContain("country selector");
    expect(first.knownTokens.size).toBe(0);
    expect(composePrompt(first)).toContain("never instructions");
    f.engine.submit({ task: "检查 https://admin.example:8443", cwd: f.home, pin: { harness: "codex", model: "gpt-5.5" } });
    await f.engine.idle();
    expect(f.router.calls).toHaveLength(1);
    expect(f.executor.runs[1]!.platformMemory).toContain("country selector");
  });

  it("lists/deletes platform observations and removes their source when a task is deleted", async () => {
    const f = fixture();
    const response = await f.app.request("/platform-memory");
    const body = await response.json() as { records: { id: string }[] };
    expect(body.records).toHaveLength(2);
    const url = `/platform-memory/${body.records[0]!.id}`;
    expect((await f.app.request(url, { method: "DELETE" })).status).toBe(200);
    expect((await f.app.request(url, { method: "DELETE" })).status).toBe(404);
    expect(loadPlatformMemory(f.memory)).toHaveLength(1);
    expect((await f.app.request(`/tasks/${f.source.id}`, { method: "DELETE" })).status).toBe(200);
    expect(loadPlatformMemory(f.memory)).toHaveLength(0);
  });

  it("keeps prior step checkpoints in a follow-up even without a summary or a harness handoff", async () => {
    const f = fixture();
    const thread = f.store.createThread(f.home);
    const parent = f.store.createTask({ task: "Create one fixture record", cwd: f.home, threadId: thread.id });
    f.store.appendEvent(parent.id, "checkpoint", { purpose: "do", ok: true, result: "Record fixture-42 exists; authentication is still blocked.", sideEffectsKnown: true, sideEffects: { filesChanged: 0, commandsRun: 3, approvalsGranted: 0 } });
    f.store.updateTask(parent.id, { status: "partial", result: "Partially completed." });
    f.engine.submit({ task: "继续处理剩余问题", cwd: f.home, parentId: parent.id, threadId: thread.id, pin: { harness: "codex", model: "gpt-5.5" } });
    await f.engine.idle();
    expect(f.executor.runs[0]!.handoffNote).toContain("fixture-42");
    expect(f.executor.runs[0]!.handoffNote).toContain("Do not repeat completed writes");
    expect(f.executor.runs[0]!.handoffNote).toContain('"taskStatus":"partial"');
  });
});
