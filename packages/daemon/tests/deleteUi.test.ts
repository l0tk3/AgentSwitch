/** Real delete bindings, state transitions and delayed HTTP responses; no model or live server. */
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const state = await import(join(UI, "lib/state.js"));
const actions = await import(join(UI, "lib/actions.js"));
const home = await import(join(UI, "views/home.js"));
const detail = await import(join(UI, "views/task.js"));
const initial = structuredClone(state.get());
const task = { id: "task-1", threadId: "thread-1", task: "配置测试环境", status: "done", createdAt: 1, cwd: "/tmp" };
const second = { ...task, id: "task-2", task: "检查配置", status: "cancelled" };
const thread = { id: "thread-1", status: "archived", title: "配置", taskCount: 2, updatedAt: 1 };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Binding = { sel: string; run: (el: unknown) => Promise<void> | void };

function click(kind: "task" | "thread" = "task", view = detail, id = kind === "task" ? task.id : thread.id) {
  return view.bindings.find((b: Binding) => b.sel === `[data-delete-${kind}]`)!.run({ dataset: kind === "task" ? { deleteTask: id } : { deleteThread: id } });
}

function http(del: () => Promise<Response>, reloadFails = false) {
  const fetcher = vi.fn(async (_path: string, options: RequestInit) => {
    if (options.method === "DELETE") return del();
    return reloadFails ? reply({ error: "refresh failed" }, 500) : reply([]);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("document", { querySelector: () => null });
  state.set({ ...structuredClone(initial), view: "task", task, tasks: [task, second], archivedThreads: [thread], thread: { ...thread, tasks: [task, second] } });
});
afterEach(() => vi.unstubAllGlobals());

describe("permanent deletion UI", () => {
  it("leaves everything untouched when confirmation is cancelled", async () => {
    const fetcher = http(async () => reply({ ok: true }));
    vi.stubGlobal("confirm", vi.fn(() => false));
    await click();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("无法恢复。工作目录不受影响"));
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.get().tasks).toEqual([task, second]);
    expect(state.get().deletions).toEqual({});
  });

  it("immediately shows deleting state, prevents duplicates, closes SSE and exits the deleted detail", async () => {
    const pending = deferred<Response>();
    const fetcher = http(() => pending.promise);
    const close = vi.fn();
    state.set({ es: { close }, approvals: [{ id: "q1", taskId: task.id }], answerSubmissions: { q1: { taskId: task.id, status: "sent" } }, events: [{ type: "done", ts: 1, payload: {} }] });
    const deleting = click();
    expect(detail.render(state.get())).toMatch(/data-delete-task="task-1"[^>]*disabled[^>]*>删除中…/);
    expect(home.render(state.get())).toContain("删除中…");
    state.set({ events: [] });
    expect(detail.render(state.get())).toContain("删除中…");
    await click();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    pending.resolve(reply({ ok: true }));
    await deleting;
    expect(close).toHaveBeenCalledOnce();
    expect(state.get()).toMatchObject({ view: "home", task: null, thread: null, es: null, approvals: [], events: [], answerSubmissions: {}, files: { root: null, files: [] } });
    expect(fetcher.mock.calls.filter(([, o]) => o.method === "DELETE").map(([path]) => path)).toEqual(["/tasks/task-1"]);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(["/tasks?limit=50", "/threads?status=open&limit=30", "/threads?status=archived&limit=100", "/approvals"]));
  });

  it("shows a Chinese failure without removing records and permits explicit retry", async () => {
    let fails = true;
    const fetcher = http(async () => fails ? reply({ error: "storage error" }, 500) : reply({ ok: true }));
    await click();
    expect(detail.render(state.get())).toContain("删除暂未确认，请稍后重试。");
    expect(detail.render(state.get())).toMatch(/data-delete-task="task-1"[^>]*>重试删除/);
    expect(state.get().tasks).toEqual([task, second]);
    fails = false;
    await click();
    expect(fetcher.mock.calls.filter(([, o]) => o.method === "DELETE")).toHaveLength(2);
    expect(state.get().deletions["task:task-1"].status).toBe("deleted");
  });

  it("handles active tasks locally and server-side conflicts without deleting", async () => {
    const fetcher = http(async () => reply({ error: "still running" }, 409));
    state.set({ task: { ...task, status: "running" }, tasks: [{ ...task, status: "running" }] });
    expect(detail.render(state.get())).not.toContain('data-delete-task="task-1"');
    expect(home.render(state.get())).toMatch(/data-delete-task="task-1"[^>]*disabled/);
    await click();
    expect(confirm).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    state.set({ task, tasks: [task] });
    await click();
    expect(detail.render(state.get())).toContain("还有任务正在执行或收尾");
    expect(state.get().task.id).toBe(task.id);
  });

  it("deletes archived threads with a confirmation covering every task", async () => {
    const fetcher = http(async () => reply({ ok: true }));
    const rendered = home.render(state.get());
    expect(rendered).toContain('id="archived-threads" data-keep-open');
    expect(rendered).toContain("// archived topics 1");
    expect(rendered).toContain('data-delete-thread="thread-1"');
    await click("thread", home);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("此会话内的全部任务、记录"));
    expect(fetcher.mock.calls[0]![0]).toBe("/threads/thread-1");
    expect(state.get().archivedThreads).toEqual([]);
    expect(state.get().tasks).toEqual([]);
    expect(state.get().deletions["task:task-2"].status).toBe("deleted");
    expect(state.get().view).toBe("home");
  });

  it("routes a nested delete click before the surrounding task-open row", async () => {
    const fetcher = http(async () => reply({ ok: true }));
    vi.stubGlobal("confirm", vi.fn(() => false));
    const button = { dataset: { deleteTask: task.id } };
    const row = { dataset: { open: task.id } };
    const target = { closest: (selector: string) => selector === "[data-delete-task]" ? button : selector === "tr[data-open]" ? row : null };
    const binding = home.bindings.find((b: Binding) => target.closest(b.sel));
    expect(binding.sel).toBe("[data-delete-task]");
    await binding.run(target.closest(binding.sel));
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.get().es).toBeNull();
  });

  it("treats 404 as already deleted and never retries a successful deletion after reload failure", async () => {
    const fetcher = http(async () => reply({ error: "not found" }, 404), true);
    await click();
    expect(state.get().task).toBeNull();
    expect(state.get().tasks).toEqual([second]);
    expect(state.get().hint).toContain("删除已完成");
    await click();
    expect(fetcher.mock.calls.filter(([, o]) => o.method === "DELETE")).toHaveLength(1);
  });

  it("filters stale polling results so deleted rows and approvals cannot reappear", async () => {
    http(async () => reply({ ok: true }));
    await click("thread", home);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => reply(path.startsWith("/tasks") ? [task, second]
      : path === "/approvals" ? [{ id: "q1", taskId: task.id }]
      : [thread])));
    await Promise.all([actions.loadTasks(), actions.loadThreads(), actions.loadArchivedThreads(), actions.loadApprovals()]);
    expect(state.get()).toMatchObject({ tasks: [], threads: [], archivedThreads: [], approvals: [] });
  });

  it("ignores an archived-list response started before deleting the final task", async () => {
    state.set({ tasks: [task], thread: null });
    const oldList = deferred<Response>();
    let archiveReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
      if (options.method === "DELETE") return reply({ ok: true });
      if (path.includes("status=archived") && ++archiveReads === 1) return oldList.promise;
      return reply([]);
    }));
    const oldPolling = actions.loadArchivedThreads();
    await click();
    expect(state.get().archivedThreads).toEqual([]);
    oldList.resolve(reply([thread]));
    await oldPolling;
    expect(state.get().archivedThreads).toEqual([]);
  });

  it("clears and reloads the current thread when another task in it is deleted", async () => {
    const threadReload = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
      if (options.method === "DELETE") return reply({ ok: true });
      if (path === `/threads/${thread.id}`) return threadReload.promise;
      return reply([]);
    }));
    const deleting = click("task", detail, second.id);
    await vi.waitFor(() => expect(state.get().deletions["task:task-2"]?.status).toBe("deleted"));
    expect(state.get().thread).toBeNull();
    expect(state.get().task.id).toBe(task.id);
    expect(state.get().view).toBe("task");
    threadReload.resolve(reply({ ...thread, tasks: [task], state: { summary: null, tasks: [{ taskId: task.id }] } }));
    await deleting;
    expect(state.get().thread.tasks).toEqual([task]);
    expect(state.get().thread.state.tasks).toEqual([{ taskId: task.id }]);
  });

  it("does not restore a deleted task when an earlier detail request finishes", async () => {
    const oldDetail = deferred<Response>();
    const close = vi.fn();
    vi.stubGlobal("EventSource", class { addEventListener() {} close = close; });
    vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
      if (options.method === "DELETE") return reply({ ok: true });
      if (path === `/tasks/${task.id}`) return oldDetail.promise;
      if (path.endsWith("/files")) return reply({ root: null, files: [] });
      return reply([]);
    }));
    actions.openTask(task.id);
    await click();
    oldDetail.resolve(reply(task));
    await Promise.resolve();
    await Promise.resolve();
    expect(state.get()).toMatchObject({ view: "home", task: null, thread: null, es: null });
    expect(close).toHaveBeenCalled();
  });
});
