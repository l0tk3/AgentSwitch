/** Real HTTP handlers, fake executors: the intake receipt (a "creating" stage, then the task) and its errors. The text
 *  goes on as typed: the "sealing" stage before it (router-v0 §9) was removed on 2026-11-23. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDaemon, type Daemon } from "../src/daemon.js";
import { QuotaService } from "../src/quota/index.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, TARGETS_PATH } from "./helpers.js";

const typed = `登录 https://fin.example.test 用 enc:v1:${"A".repeat(32)} 查报表`;
const fixtures: { d: Daemon; dir: string }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const { d, dir } of fixtures.splice(0)) {
    for (const task of d.store.listTasks()) d.engine.cancel(task.id);
    await d.engine.idle();
    d.close();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
function build() {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-intake-"));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const d = buildDaemon({ home: join(dir, "home"), targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" }, {
    router: echoRouter([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]), quota: new QuotaService([]), oldDispatchOff: false,
  });
  fixtures.push({ d, dir });
  const post = (body: unknown = { task: typed, cwd }, accept = "application/x-ndjson") => d.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json", accept }, body: JSON.stringify(body) });
  return { d, cwd, post };
}
type Frame = { type: string; stage?: string; elapsedMs?: number; task?: { id: string; task: string }; status?: number; error?: string };
const frames = (text: string): Frame[] => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Frame);

describe("task intake receipts", () => {
  it("streams the creating stage, then the accepted task as typed; the intake step carries no sealing time", async () => {
    const f = build();
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = frames(await response.text());
    expect(result.map((frame) => frame.type === "progress" ? frame.stage : frame.type)).toEqual(["creating", "accepted"]);
    const accepted = result[1]!;
    expect(Object.keys(accepted).sort()).toEqual(["elapsedMs", "task", "type"]);
    expect(accepted.task?.task).toBe(typed);
    await f.d.engine.idle();
    const events = f.d.store.eventsSince(accepted.task!.id);
    expect(events.find((event) => event.type === "step" && event.payload.action === "intake")?.payload).toEqual({ action: "intake", durationMs: accepted.elapsedMs });
    expect(events.some((event) => event.type === "sealed")).toBe(false);
  });

  it.each(["application/json", "application/x-ndjson;q=0, application/json"])("preserves ordinary JSON task receipts for Accept %s", async (accept) => {
    const f = build();
    const response = await f.post({ task: "更新标题", cwd: f.cwd }, accept);
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("server-timing")).toMatch(/^intake;dur=\d+$/);
    expect(await response.json()).toMatchObject({ id: expect.any(String), task: "更新标题" });
  });

  it("validates parameters and parent/thread state before opening a progress stream", async () => {
    const f = build();
    const thread = f.d.store.createThread(f.cwd, "fixture");
    const parent = f.d.store.createTask({ task: "parent", cwd: f.cwd, threadId: thread.id });
    f.d.store.archiveThread(thread.id);
    for (const [body, status] of [
      [{ task: "" }, 400],
      [{ task: typed, cwd: "relative" }, 400],
      [{ task: typed, parent_id: "missing" }, 404],
      [{ task: typed, thread_id: "missing" }, 404],
      [{ task: typed, thread_id: thread.id }, 409],
      [{ task: typed, parent_id: parent.id }, 409],
    ] as const) {
      const response = await f.post(body);
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.text()).not.toContain("enc:v1:");
    }
    expect(f.d.store.listTasks().map((t) => t.task)).toEqual(["parent"]);
  });

  it("a diagnostic event failure after creation cannot turn an accepted task into an error receipt", async () => {
    const f = build();
    const append = f.d.store.appendEvent.bind(f.d.store);
    vi.spyOn(f.d.store, "appendEvent").mockImplementation((id, type, payload) => {
      if (type === "step" && payload?.action === "intake") throw new Error("fixture diagnostic failure");
      return append(id, type, payload);
    });
    const result = frames(await (await f.post({ task: "更新标题", cwd: f.cwd })).text());
    expect(result.at(-1)).toMatchObject({ type: "accepted", task: { id: expect.any(String) } });
    expect(result.some((frame) => frame.type === "error")).toBe(false);
    expect(f.d.store.listTasks()).toHaveLength(1);
  });
});
