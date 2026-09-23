import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const { postTask } = await import(join(UI, "lib/submission.js"));
const state = await import(join(UI, "lib/state.js"));
const actions = await import(join(UI, "lib/actions.js"));
const home = await import(join(UI, "views/home.js"));
const detail = await import(join(UI, "views/task.js"));
const { feedback } = await import(join(UI, "lib/feedback.js"));
const initial = structuredClone(state.get());
const task = { id: "stream-task", task: "中文消息", status: "routing", cwd: "/tmp", createdAt: 1 };
const json = (body: unknown) => new Response(JSON.stringify(body));
const encoder = new TextEncoder();

function stream() {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { control = c; } });
  return { response: new Response(body, { headers: { "content-type": "application/x-ndjson" } }),
    send: (event: unknown) => control.enqueue(encoder.encode(JSON.stringify(event) + "\n")), close: () => control.close() };
}
function server(response: Response) {
  const fetcher = vi.fn(async (path: string, opts: RequestInit) => {
    if (opts.method === "POST") return response;
    if (path === "/tasks?limit=50") return json([task]);
    if (path.endsWith("/files")) return json({ root: null, files: [] });
    if (path === `/tasks/${task.id}`) return json(task);
    return json([]);
  });
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
beforeEach(() => {
  state.set(structuredClone(initial));
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("live task intake feedback", () => {
  it("shows server-confirmed sealing and creation before acceptance, without a duplicate POST", async () => {
    const frames = stream(), fetcher = server(frames.response);
    const submitted = actions.submitTask({ task: task.task });
    frames.send({ type: "progress", stage: "sealing", elapsedMs: 0 });
    await vi.waitUntil(() => state.get().taskSubmissions.home?.phase === "sealing");
    expect(home.render(state.get())).toContain("检查并加密中…");
    expect(home.render(state.get())).toContain("消息已到达");
    expect(state.get().task).toBeNull();
    await actions.submitTask({ task: task.task });
    expect(fetcher.mock.calls.filter(([, opts]) => opts.method === "POST")).toHaveLength(1);
    frames.send({ type: "progress", stage: "creating", elapsedMs: 16400 });
    await vi.waitUntil(() => state.get().taskSubmissions.home?.phase === "creating");
    expect(home.render(state.get())).toContain("敏感信息处理完成（16.4 秒）");
    frames.send({ type: "accepted", task, elapsedMs: 16402, sealingMs: 16400 });
    await submitted;
    expect(state.get()).toMatchObject({ view: "task", task });
    expect(state.get().taskSubmissions.home.status).toBe("sent");
  });

  it("keeps a lost stream uncertain and refuses to silently send it again", async () => {
    const frames = stream(), fetcher = server(frames.response);
    const submitted = actions.submitTask({ task: task.task });
    frames.send({ type: "progress", stage: "sealing", elapsedMs: 0 }); frames.close();
    await submitted;
    expect(state.get().taskSubmissions.home.status).toBe("uncertain");
    await actions.submitTask({ task: task.task });
    expect(fetcher.mock.calls.filter(([, opts]) => opts.method === "POST")).toHaveLength(1);
  });

  it("allows a retry only after the server confirms intake was rejected", async () => {
    const frames = stream(); server(frames.response);
    const submitted = actions.submitTask({ task: task.task });
    frames.send({ type: "error", status: 503, error: "safe fixture error" }); frames.close();
    await submitted;
    expect(state.get().taskSubmissions.home.status).toBe("error");
    expect(home.render(state.get())).toContain("服务暂时无法接收消息");
  });

  it("keeps an unexpected creation error uncertain because a task may already exist", async () => {
    const frames = stream(), fetcher = server(frames.response);
    const submitted = actions.submitTask({ task: task.task });
    frames.send({ type: "progress", stage: "creating", elapsedMs: 0 });
    frames.send({ type: "error", status: 500 }); frames.close();
    await submitted;
    expect(state.get().taskSubmissions.home.status).toBe("uncertain");
    await actions.submitTask({ task: task.task });
    expect(fetcher.mock.calls.filter(([, opts]) => opts.method === "POST")).toHaveLength(1);
  });

  it("parses split UTF-8, accepts a final receipt without newline and tolerates a later stream error", async () => {
    const data = encoder.encode(JSON.stringify({ type: "accepted", task }));
    server(new Response(new ReadableStream({ start(c) { for (const byte of data) c.enqueue(new Uint8Array([byte])); c.close(); } }), { headers: { "content-type": "application/x-ndjson" } }));
    expect(await postTask({ task: task.task })).toEqual(task);
    const frames = stream(); server(frames.response);
    frames.send({ type: "accepted", task }); frames.send({ type: "error", status: 500 }); frames.close();
    expect(await postTask({ task: task.task })).toEqual(task);
  });

  it("separates intake, routing, planning and actual execution feedback", () => {
    expect(detail.eventLine({ type: "step", payload: { action: "intake", durationMs: 12500, sealingMs: 12000 } })).toContain("识别与加密 12.0 秒");
    expect(feedback(task, []).label).toBe("分诊中…");
    const planned = [{ type: "routed", seq: 1, payload: { verdict: { ok: true, harness: "codex", model: "fixture" } } },
      { type: "step", seq: 2, payload: { action: "plan", model: "codex/fixture" } }];
    expect(feedback(task, planned)).toMatchObject({ label: "规划中…", detail: expect.stringContaining("尚未派发") });
    expect(feedback(task, [...planned, { type: "dispatched", seq: 3, payload: {} }]).label).toBe("正在规划下一步…");
    expect(feedback({ ...task, status: "running", harness: "codex", model: "fixture" }, planned).label).toContain("执行中");
  });
});
