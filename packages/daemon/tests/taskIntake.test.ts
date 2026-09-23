/** Real HTTP handlers, fake sealers/executors: progress must not persist plaintext or repeat submissions. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDaemon, type Daemon } from "../src/daemon.js";
import { QuotaService } from "../src/quota/index.js";
import { echoRouter } from "../src/router/routers/echo.js";
import type { SealResult, Sealer } from "../src/secrets/sealer.js";
import { decisionJson, TARGETS_PATH } from "./helpers.js";

const raw = "private-credential-for-intake-fixture";
const token = `enc:v1:${"A".repeat(32)}`;
const sealed: SealResult = { ok: true, text: `使用 ${token}`, sealed: [], ms: 999_999 };
const fixtures: { d: Daemon; dir: string }[] = [];
afterEach(async () => {
  for (const { d, dir } of fixtures.splice(0)) {
    for (const task of d.store.listTasks()) d.engine.cancel(task.id);
    await d.engine.idle();
    d.close();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function build(sealer?: Sealer) {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-intake-"));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const d = buildDaemon({ home: join(dir, "home"), targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" }, {
    router: echoRouter([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]), quota: new QuotaService([]), ...(sealer ? { sealer } : {}),
  });
  fixtures.push({ d, dir });
  const post = (body: unknown = { task: raw, cwd }, accept = "application/x-ndjson") => d.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json", accept }, body: JSON.stringify(body) });
  return { d, cwd, post };
}
type Frame = { type: string; stage?: string; elapsedMs?: number; sealingMs?: number; task?: { id: string; task: string }; status?: number; error?: string };
const frames = (text: string): Frame[] => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Frame);
async function firstFrame(response: Response) {
  const reader = response.body!.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("first progress frame was held behind sealing")), 500); })]).finally(() => { if (timer) clearTimeout(timer); });
  expect(first.done).toBe(false);
  return { reader, first: frames(new TextDecoder().decode(first.value))[0]! };
}
async function remainder(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Frame[]> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true }); }
  return frames(text + decoder.decode());
}

describe("task intake receipts", () => {
  it("flushes sealing before model completion, stores nothing until sealed, then accepts with measured durations", async () => {
    const pending = deferred<SealResult>();
    const sealer = vi.fn<Sealer>(async () => pending.promise);
    const f = build(sealer);
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { reader, first } = await firstFrame(response);
    expect(first).toMatchObject({ type: "progress", stage: "sealing", elapsedMs: expect.any(Number) });
    expect(Object.keys(first).sort()).toEqual(["elapsedMs", "stage", "type"]);
    expect(f.d.store.listTasks()).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.d.store.listTasks()).toHaveLength(0);
    pending.resolve(sealed);
    const rest = await remainder(reader);
    expect(rest.map((frame) => frame.type === "progress" ? frame.stage : frame.type)).toEqual(["creating", "accepted"]);
    const accepted = rest[1]!;
    expect(accepted.task?.task).toBe(`使用 ${token}`);
    expect(accepted.sealingMs).toBeGreaterThanOrEqual(15);
    expect(accepted.sealingMs).toBeLessThan(1000);
    expect(accepted.elapsedMs).toBeGreaterThanOrEqual(accepted.sealingMs!);
    expect(sealer).toHaveBeenCalledTimes(1);
    await f.d.engine.idle();
    const events = f.d.store.eventsSince(accepted.task!.id);
    expect(events.find((event) => event.type === "step" && event.payload.action === "intake")?.payload).toEqual({ action: "intake", durationMs: accepted.elapsedMs, sealingMs: accepted.sealingMs });
    expect(JSON.stringify({ first, rest, events, tasks: f.d.store.listTasks() })).not.toContain(raw);
  });

  it.each(["unavailable", "unroutable", "throws"] as const)("%s emits only a safe terminal error and creates no task", async (kind) => {
    const sealer = vi.fn<Sealer>(async () => {
      if (kind === "throws") throw new Error(`provider echoed ${raw}`);
      return { ok: false, code: kind, error: `model echoed ${raw}`, ms: 100 };
    });
    const f = build(sealer);
    const response = await f.post();
    const text = await response.text();
    const result = frames(text);
    expect(result).toEqual([
      { type: "progress", stage: "sealing", elapsedMs: expect.any(Number) },
      { type: "error", status: kind === "unroutable" ? 400 : 503, error: expect.any(String) },
    ]);
    expect(text).not.toContain(raw);
    expect(f.d.store.listTasks()).toHaveLength(0);
    expect(sealer).toHaveBeenCalledTimes(1);
  });

  it("a reader disconnect does not repeat or abandon an already received submission", async () => {
    const pending = deferred<SealResult>();
    const sealer = vi.fn<Sealer>(async () => pending.promise);
    const f = build(sealer);
    const submit = vi.spyOn(f.d.engine, "submit");
    const { reader } = await firstFrame(await f.post());
    await reader.cancel();
    pending.resolve(sealed);
    await vi.waitFor(() => expect(f.d.store.listTasks()).toHaveLength(1));
    await f.d.engine.idle();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sealer).toHaveBeenCalledTimes(1);
    expect(f.d.store.listTasks()[0]!.task).not.toContain(raw);
  });

  it("a slow reader cannot hold up creation, and no sealer means only the factual creating stage", async () => {
    const f = build();
    const response = await f.post({ task: "更新标题", cwd: f.cwd });
    await vi.waitFor(() => expect(f.d.store.listTasks()).toHaveLength(1));
    const result = frames(await response.text());
    expect(result.map((frame) => frame.type === "progress" ? frame.stage : frame.type)).toEqual(["creating", "accepted"]);
    expect(result[1]).toMatchObject({ sealingMs: 0, task: { task: "更新标题" } });
  });

  it.each(["application/json", "application/x-ndjson;q=0, application/json"])("preserves ordinary JSON task receipts for Accept %s", async (accept) => {
    const f = build();
    const response = await f.post({ task: "更新标题", cwd: f.cwd }, accept);
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("server-timing")).toMatch(/^sealing;dur=0, intake;dur=\d+$/);
    expect(await response.json()).toMatchObject({ id: expect.any(String), task: "更新标题" });
  });

  it("JSON sealing errors keep their existing status and safe text, with wall-clock timing", async () => {
    const f = build(async () => ({ ok: false, code: "unroutable", error: "missing destination", ms: 999_999 }));
    const response = await f.post(undefined, "application/json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "missing destination" });
    expect(response.headers.get("server-timing")).toMatch(/^sealing;dur=\d+, intake;dur=\d+$/);
    expect(response.headers.get("server-timing")).not.toContain("999999");
  });

  it("validates parameters and parent/thread state before opening a progress stream or calling the sealer", async () => {
    const sealer = vi.fn<Sealer>(async () => sealed);
    const f = build(sealer);
    const thread = f.d.store.createThread(f.cwd, "fixture");
    const parent = f.d.store.createTask({ task: "parent", cwd: f.cwd, threadId: thread.id });
    f.d.store.archiveThread(thread.id);
    for (const [body, status] of [
      [{ task: "" }, 400],
      [{ task: raw, cwd: "relative" }, 400],
      [{ task: raw, parent_id: "missing" }, 404],
      [{ task: raw, thread_id: "missing" }, 404],
      [{ task: raw, thread_id: thread.id }, 409],
      [{ task: raw, parent_id: parent.id }, 409],
    ] as const) {
      const response = await f.post(body);
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.text()).not.toContain(raw);
    }
    expect(sealer).not.toHaveBeenCalled();
  });

  it("rechecks thread state after sealing rather than reviving a thread deleted during intake", async () => {
    const pending = deferred<SealResult>();
    const f = build(async () => pending.promise);
    const thread = f.d.store.createThread(f.cwd);
    const { reader } = await firstFrame(await f.post({ task: raw, cwd: f.cwd, thread_id: thread.id }));
    expect(f.d.store.deleteThread(thread.id)).toBe(true);
    pending.resolve(sealed);
    expect(await remainder(reader)).toEqual([
      { type: "progress", stage: "creating", elapsedMs: expect.any(Number) },
      { type: "error", status: 404, error: "thread not found" },
    ]);
    expect(f.d.store.listTasks()).toHaveLength(0);
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
