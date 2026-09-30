/** Submission and quota races through the actual browser bindings; no live models or server. */
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const state = await import(join(UI, "lib/state.js"));
const actions = await import(join(UI, "lib/actions.js"));
const home = await import(join(UI, "views/home.js"));
const detail = await import(join(UI, "views/task.js"));
const initial = structuredClone(state.get());
const oldTask = { id: "old-task", task: "已有任务", status: "done", createdAt: 1, cwd: "/tmp" };
const newTask = { id: "new-task", task: "这是一条消息", status: "routing", createdAt: 2, cwd: "/tmp" };
const fields = new Map<string, { value: string; disabled: boolean }>();
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Binding = { sel: string; run: (el?: unknown, event?: unknown, s?: unknown) => Promise<void> | void };

const click = (view = home) => view.bindings.find((b: Binding) => b.sel === (view === home ? "#c-send" : "#f-send"))!.run({}, {}, state.get());
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function http(post: () => Promise<Response>, list?: () => Promise<Response>) {
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    if (options.method === "POST") return post();
    if (path === "/tasks?limit=50") return list ? list() : reply([newTask, oldTask]);
    if (path.endsWith("/files")) return reply({ root: null, files: [] });
    if (path.startsWith("/tasks/")) return reply(path.includes(oldTask.id) ? oldTask : newTask);
    return reply([]);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function posts(fetcher: ReturnType<typeof http>) { return fetcher.mock.calls.filter(([, options]) => options.method === "POST"); }

beforeEach(() => {
  fields.clear();
  for (const id of ["c-task", "c-cwd", "c-pin", "c-browser", "c-approval", "c-send", "f-task", "f-send"]) fields.set(id, { value: id.endsWith("task") ? "这是一条消息" : "", disabled: false });
  vi.stubGlobal("document", { querySelector: (selector: string) => fields.get(selector.replace(/^#/, "")) || null });
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  vi.stubGlobal("confirm", vi.fn(() => true));
  state.set({ ...structuredClone(initial), tasks: [oldTask] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("send UI", () => {
  it("immediately shows progress, keeps it through polling and blocks duplicate sends", async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const fetcher = http(() => pending.promise);
    const sending = click();
    expect(home.render(state.get())).toMatch(/id="c-send" disabled[^>]*aria-label="发送中…"/);
    await Promise.resolve();
    state.set({ health: true });
    expect(home.render(state.get())).toContain("正在发送消息");
    await click();
    expect(posts(fetcher)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(home.render(state.get())).toContain("可能需要几十秒");
    pending.resolve(reply(newTask, 201));
    await sending;
    expect(state.get()).toMatchObject({ view: "task", task: newTask });
    expect(fields.get("c-task")!.value).toBe("");
    expect(state.get().taskSubmissions.home.status).toBe("sent");
  });

  it("opens the POST receipt immediately while task-list refresh is still pending", async () => {
    const list = deferred<Response>();
    http(async () => reply(newTask, 201), () => list.promise);
    await click();
    expect(state.get().view).toBe("task");
    expect(state.get().task.id).toBe(newTask.id);
    list.resolve(reply([newTask]));
  });

  it("does not turn a successful send into a failure when later GET requests fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => options.method === "POST" ? reply(newTask, 201) : reply({ error: "GET failed" }, 500)));
    await click();
    await vi.waitFor(() => expect(state.get().taskSubmissions.home.message).toContain("列表暂未刷新"));
    expect(state.get().taskSubmissions.home.status).toBe("sent");
    expect(state.get().task.id).toBe(newTask.id);
    expect(state.get().view).toBe("task");
    expect(detail.render(state.get())).toContain(newTask.task);
  });

  it("preserves the draft on a confirmed 503 rejection and allows a deliberate retry", async () => {
    let reject = true;
    const fetcher = http(async () => reject ? reply({ error: "unavailable" }, 503) : reply(newTask, 201));
    await click();
    expect(home.render(state.get())).toContain("服务暂时无法接收消息");
    expect(home.render(state.get())).toMatch(/id="c-send" (?!disabled)[^>]*aria-label="重新发送"/);
    expect(fields.get("c-task")!.value).toBe("这是一条消息");
    reject = false;
    await click();
    expect(posts(fetcher)).toHaveLength(2);
    expect(state.get().taskSubmissions.home.status).toBe("sent");
  });

  it("shows identical immediate feedback for follow-up messages and keeps their parent id", async () => {
    state.set({ view: "task", task: oldTask });
    const pending = deferred<Response>();
    const fetcher = http(() => pending.promise);
    const sending = click(detail);
    expect(detail.render(state.get())).toMatch(/id="f-send" disabled[^>]*aria-label="发送中…"/);
    await Promise.resolve();
    expect(JSON.parse(posts(fetcher)[0]![1].body as string)).toEqual({ task: "这是一条消息", parent_id: oldTask.id });
    state.set({ events: [] });
    await click(detail);
    expect(posts(fetcher)).toHaveLength(1);
    pending.resolve(reply({ ...newTask, parentId: oldTask.id }, 201));
    await sending;
    expect(state.get().task.id).toBe(newTask.id);
    expect(fields.get("f-task")!.value).toBe("");
  });

  it("does not navigate away or clear newer input and attachments on another page", async () => {
    const pending = deferred<Response>();
    http(() => pending.promise);
    const sending = click();
    await Promise.resolve();
    actions.openTask(oldTask.id);
    fields.get("f-task")!.value = "别的页面的新草稿";
    const attachment = { file: new File(["new"], "new.txt"), url: null };
    state.set({ pending: [attachment] });
    pending.resolve(reply(newTask, 201));
    await sending;
    expect(state.get().task.id).toBe(oldTask.id);
    expect(state.get().view).toBe("task");
    expect(fields.get("f-task")!.value).toBe("别的页面的新草稿");
    expect(state.get().pending).toEqual([attachment]);
    expect(state.get().taskSubmissions.home.taskId).toBe(newTask.id);
  });

  it("keeps upload failures retryable and never POSTs a task without its attachments", async () => {
    const attachment = { file: new File(["content"], "document.txt"), url: null };
    state.set({ pending: [attachment] });
    const fetcher = vi.fn(async () => reply({ error: "upload unavailable" }, 503));
    vi.stubGlobal("fetch", fetcher);
    await click();
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(home.render(state.get())).toContain("附件上传失败，消息尚未发送");
    expect(state.get().pending).toEqual([attachment]);
    expect(fields.get("c-task")!.value).toBe("这是一条消息");
  });

  it("never automatically repeats an uncertain POST and offers an explicit confirmed unlock", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((path: string, options: RequestInit) => {
      if (options.method === "POST") return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      return Promise.resolve(reply(path === "/tasks?limit=50" ? [oldTask] : []));
    });
    vi.stubGlobal("fetch", fetcher);
    const sending = click();
    await vi.advanceTimersByTimeAsync(120_000);
    await sending;
    expect(state.get().taskSubmissions.home.status).toBe("uncertain");
    expect(home.render(state.get())).toContain("核对后允许重发");
    await click();
    await home.bindings.find((b: Binding) => b.sel === "[data-send-refresh]").run({ dataset: { sendRefresh: "home" } });
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
    const unlock = home.bindings.find((b: Binding) => b.sel === "[data-send-unlock]").run;
    vi.stubGlobal("confirm", vi.fn(() => false));
    unlock({ dataset: { sendUnlock: "home" } });
    expect(state.get().taskSubmissions.home.status).toBe("uncertain");
    vi.stubGlobal("confirm", vi.fn(() => true));
    unlock({ dataset: { sendUnlock: "home" } });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("重复执行"));
    expect(state.get().taskSubmissions.home.status).toBe("error");
    expect(fields.get("c-task")!.value).toBe("这是一条消息");
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  });

  it("shares a bounded quota request instead of exhausting browser connections", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_path: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })));
    vi.stubGlobal("fetch", fetcher);
    const first = actions.loadQuota();
    const second = actions.loadQuota(true);
    const settled = Promise.allSettled([first, second]);
    expect(first).toBe(second);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await settled).every((r) => r.status === "rejected")).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => reply([])));
    await actions.loadQuota();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
