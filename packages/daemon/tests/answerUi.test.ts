/** Exercise the real view bindings + submission action with delayed HTTP responses, without models. */
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const state = await import(join(UI, "lib/state.js"));
const home = await import(join(UI, "views/home.js"));
const detail = await import(join(UI, "views/task.js"));
const initial = structuredClone(state.get());
const task = { id: "task-1", task: "管理平台配置", status: "waiting_approval", createdAt: 1, cwd: "/tmp" };
const approval = { id: "question-1", taskId: task.id, kind: "question", action: "选择环境", evidence: "", createdAt: 1 };
type Question = { id: string; text: string; multi?: boolean };
type Binding = { sel: string; run: (el: unknown) => Promise<void> | void };
type View = { bindings: Binding[]; render: (s: unknown) => string };
type Input = { value: string; disabled: boolean };
const fields = new Map<string, Input>();
const button = { dataset: { task: task.id, answer: approval.id } };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function questionSetup(questions: Question[], values: string[]) {
  state.set({ approvals: [{ ...approval, evidence: JSON.stringify({ questions }) }] });
  values.forEach((value, i) => fields.set(`q-${approval.id}-${i}`, { value, disabled: false }));
}

function click(view: View = detail) {
  return view.bindings.find((b) => b.sel === "[data-answer]")!.run(button);
}

function http(post: () => Promise<Response>, failReload = false) {
  const fetcher = vi.fn(async (path: string, options: RequestInit) => {
    if (options.method === "POST") return post();
    if (failReload) return reply({ error: "reload failed" }, 500);
    if (path === "/approvals") return reply([]);
    if (path === "/tasks?limit=50") return reply([{ ...task, status: "routing" }]);
    return reply({ ...task, status: "routing" });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function posts(fetcher: ReturnType<typeof http>) {
  return fetcher.mock.calls.filter(([, init]) => init.method === "POST");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  fields.clear();
  vi.stubGlobal("document", { getElementById: (id: string) => fields.get(id) || null });
  state.set({ ...structuredClone(initial), view: "task", task, tasks: [task] });
  questionSetup([{ id: "environment", text: "使用哪个环境？" }], ["测试环境"]);
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("answer UI", () => {
  it("task detail reads indexed fields, immediately shows progress across state renders, and prevents duplicate POSTs", async () => {
    const pending = deferred<Response>();
    const fetcher = http(() => pending.promise);
    let rendered = "";
    const unsubscribe = state.subscribe((s: unknown) => { rendered = detail.render(s); });
    try {
      const submitting = click();
      expect(rendered).toContain("提交中…");
      expect(rendered).toMatch(/data-answer="question-1"[^>]*disabled/);
      expect(rendered).toContain('id="q-question-1-0" data-keep');
      expect(JSON.parse(posts(fetcher)[0]![1].body as string)).toEqual({ approval_id: approval.id, text: "测试环境" });
      state.set({ events: [{ type: "text", ts: 1, payload: { text: "更新" } }] });
      expect(rendered).toContain("提交中…");
      expect(home.render(state.get())).toContain("提交中…");
      await click();
      expect(posts(fetcher)).toHaveLength(1);
      pending.resolve(reply({ ok: true }));
      await submitting;
      expect(state.get().answerSubmissions[approval.id].status).toBe("sent");
      expect(state.get().task.status).toBe("routing");
      expect(state.get().approvals).toEqual([]);
    } finally { unsubscribe(); }
  });

  it("keeps inputs and allows an explicit retry after a confirmed failure", async () => {
    let fail = true;
    const fetcher = http(async () => fail ? reply({ error: "could not process" }, 503) : reply({ ok: true }));
    await click(home);
    const failed = home.render(state.get());
    expect(failed).toContain("暂时无法处理答复，请稍后重试。输入已保留。");
    expect(failed).toMatch(/data-answer="question-1"[^>]*>重新提交/);
    expect(failed).not.toMatch(/data-answer="question-1"[^>]*disabled/);
    expect(failed).toContain('id="q-question-1-0" data-keep');
    expect(fields.get("q-question-1-0")!.value).toBe("测试环境");
    fail = false;
    await click(home);
    expect(posts(fetcher)).toHaveLength(2);
    expect(state.get().answerSubmissions[approval.id].status).toBe("sent");
  });

  it("keeps a successful POST committed when refreshing state fails", async () => {
    const fetcher = http(async () => reply({ ok: true }), true);
    await click();
    expect(state.get().answerSubmissions[approval.id].status).toBe("sent");
    const rendered = detail.render(state.get());
    expect(rendered).toContain("答复已提交，页面状态暂未刷新");
    expect(rendered).toMatch(/data-answer="question-1"[^>]*disabled/);
    expect(rendered).toContain("刷新状态");
    await click();
    expect(posts(fetcher)).toHaveLength(1);
  });

  it("submits every answer and all multiple selections from task detail", async () => {
    questionSetup([{ id: "environment", text: "环境" }, { id: "actions", text: "操作", multi: true }], [" 测试环境 ", "新增， 编辑, 查询"]);
    const fetcher = http(async () => reply({ ok: true }));
    await click();
    expect(JSON.parse(posts(fetcher)[0]![1].body as string)).toEqual({ approval_id: approval.id, answers: { environment: ["测试环境"], actions: ["新增", "编辑", "查询"] } });
  });

  it("preserves every selection even when there is only one question", async () => {
    questionSetup([{ id: "actions", text: "操作", multi: true }], ["新增, 查询"]);
    const fetcher = http(async () => reply({ ok: true }));
    await click(home);
    expect(JSON.parse(posts(fetcher)[0]![1].body as string)).toEqual({ approval_id: approval.id, answers: { actions: ["新增", "查询"] } });
  });

  it("explains missing input without sending an incomplete answer", async () => {
    questionSetup([{ id: "environment", text: "环境" }, { id: "actions", text: "操作", multi: true }], ["测试环境", " ，, "]);
    const fetcher = http(async () => reply({ ok: true }));
    await click();
    expect(posts(fetcher)).toHaveLength(0);
    expect(detail.render(state.get())).toContain("请回答所有问题后再提交。");
    expect(fields.get("q-question-1-0")!.value).toBe("测试环境");
  });

  it("treats a timeout as uncertain and only refreshes, never resends", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((path: string, options: RequestInit) => {
      if (options.method === "POST") return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      if (path === "/approvals") return Promise.resolve(reply(state.get().approvals));
      return Promise.resolve(reply(path === "/tasks?limit=50" ? [task] : task));
    });
    vi.stubGlobal("fetch", fetcher);
    const submitting = click();
    await vi.advanceTimersByTimeAsync(120_000);
    await submitting;
    expect(state.get().answerSubmissions[approval.id].status).toBe("uncertain");
    expect(detail.render(state.get())).toContain("提交结果待确认");
    expect(fields.get("q-question-1-0")!.value).toBe("测试环境");
    await click();
    await detail.bindings.find((b: Binding) => b.sel === "[data-answer-refresh]").run({ dataset: { task: task.id, answerRefresh: approval.id } });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("shares option selection on task detail and home without accumulating single-choice values", () => {
    const select = detail.bindings.find((b: Binding) => b.sel === "[data-opt]").run;
    select({ dataset: { for: "q-question-1-0", opt: "生产环境", multi: "false" } });
    expect(fields.get("q-question-1-0")!.value).toBe("生产环境");
    select({ dataset: { for: "q-question-1-0", opt: "测试环境", multi: "true" } });
    select({ dataset: { for: "q-question-1-0", opt: "测试环境", multi: "true" } });
    expect(fields.get("q-question-1-0")!.value).toBe("生产环境, 测试环境");
    fields.get("q-question-1-0")!.disabled = true;
    select({ dataset: { for: "q-question-1-0", opt: "其他", multi: "false" } });
    expect(fields.get("q-question-1-0")!.value).toBe("生产环境, 测试环境");
    expect(home.bindings.find((b: Binding) => b.sel === "[data-opt]").run).toBe(select);
  });

  it("clears uncertainty once the question ended without claiming a lost answer was accepted", async () => {
    const fetcher = http(async () => { throw new TypeError("connection lost"); });
    await click();
    expect(state.get().answerSubmissions[approval.id]).toMatchObject({ status: "resolved", message: "问题已结束，请查看任务当前进展。" });
    expect(detail.render(state.get())).not.toContain("提交结果待确认");
    await click();
    expect(posts(fetcher)).toHaveLength(1);
  });
});
