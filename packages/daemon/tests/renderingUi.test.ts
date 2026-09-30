/** Real DOM regressions for background updates while editing. No daemon or model is contacted. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const task = { id: "task-one", task: "测试任务", status: "running", createdAt: 1, cwd: "/tmp" };
const question = (id: string) => ({ id, taskId: task.id, kind: "question", createdAt: 1,
  action: "测试问题", evidence: JSON.stringify({ source: "router", questions: [{ text: "请填写说明" }] }) });
let dom: JSDOM;
let state: { get: () => any; set: (next: any) => any; patch: (next: any) => any; subscribe: (fn: (next: any) => void) => () => void };
let fetcher: ReturnType<typeof vi.fn>;
const field = (id: string) => dom.window.document.getElementById(id) as HTMLTextAreaElement;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  dom = new JSDOM(readFileSync(join(UI, "index.html"), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  vi.stubGlobal("alert", vi.fn());
  fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url === "/healthz" ? { version: "test" }
    : url === "/approvals/policy" ? { policy: { mode: "manual", human: [] }, categories: [] } : [])));
  vi.stubGlobal("fetch", fetcher);
  state = await import(join(UI, "lib/state.js"));
  await import(join(UI, "app.js"));
  await vi.advanceTimersByTimeAsync(0);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  dom.window.close();
  vi.unstubAllGlobals();
});

function edit(id: string) {
  const el = field(id);
  expect(el).toBeTruthy();
  el.focus();
  el.value = "正在输入中文，保留草稿";
  el.setSelectionRange(2, 6, "backward");
  el.scrollTop = 63;
  el.scrollLeft = 17;
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  el.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
  const blur = vi.fn();
  el.addEventListener("blur", blur);
  const observer = new dom.window.MutationObserver(() => undefined);
  observer.observe(dom.window.document.querySelector("#main")!, { childList: true, subtree: true });
  return { el, blur, observer };
}

function unchanged(id: string, saved: ReturnType<typeof edit>) {
  expect(field(id)).toBe(saved.el);
  expect(dom.window.document.activeElement).toBe(saved.el);
  expect(saved.el.value).toBe("正在输入中文，保留草稿");
  expect([saved.el.selectionStart, saved.el.selectionEnd, saved.el.selectionDirection]).toEqual([2, 6, "backward"]);
  expect([saved.el.scrollTop, saved.el.scrollLeft]).toEqual([63, 17]);
  expect(saved.blur).not.toHaveBeenCalled();
  const removed = saved.observer.takeRecords().flatMap((record) => [...record.removedNodes]);
  expect(removed.some((node) => node === saved.el || node.contains(saved.el))).toBe(false);
  saved.observer.disconnect();
}

describe("background rendering preserves live editors", () => {
  it.each(["c-task", "c-cwd", "c-pin"])("keeps home %s connected while quota, approvals and tasks change", (id) => {
    const saved = edit(id);
    field("main").scrollTop = 220;
    state.set({ quota: [{ harness: "codex", remaining: 0.47, fetchedAt: Date.now(), source: "test", detail: {} }] });
    state.set({ approvals: [question("new-question")], tasks: [task], health: false });
    unchanged(id, saved);
    expect(field("main").scrollTop).toBe(220);
    expect(dom.window.document.querySelector("aside")?.textContent).toContain("47% left");
    expect(dom.window.document.querySelector('[data-open="task-one"]')).toBeTruthy();
  });

  it.each(["home", "task"])("keeps a %s answer when another question is inserted and reordered", (view) => {
    state.set({ view, task, tasks: [task], approvals: [question("original")] });
    const saved = edit("q-original-0");
    state.set({ approvals: [question("new-question"), question("original")] });
    state.set({ approvals: [question("original"), question("new-question")] });
    unchanged("q-original-0", saved);
    expect(field("q-new-question-0")).toBeTruthy();
  });

  it("keeps follow-up input and a scrolled event pane while SSE adds progress", () => {
    state.set({ view: "task", task, tasks: [task] });
    const saved = edit("f-task");
    const events = field("events");
    Object.defineProperties(events, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
    events.scrollTop = 140;
    state.set({ events: [{ seq: 1, type: "text", at: Date.now(), payload: { text: "新的执行进度" } }],
      task: { ...task, status: "blocked", error: "测试停止原因", result: "已保存的进展" } });
    unchanged("f-task", saved);
    expect(field("events")).toBe(events);
    expect(events.scrollTop).toBe(140);
    // The task opens beside the tasks.
    expect(dom.window.document.querySelector("#detail")!.textContent).toContain("已保存的进展");
  });

  it.each(["ctx-text", "mem-text"])("keeps %s while context hints and platform records change", (id) => {
    state.set({ view: "ctx" });
    const saved = edit(id);
    state.set({ ctx: { ...state.get().ctx, hint: "测试状态更新" }, platformMem: {
      ...state.get().platformMem, loaded: true, records: [{ id: "record-one", origin: "https://example.test", text: "新观察",
        kind: "operation", status: "observed", updatedAt: Date.now(), expiresAt: Date.now() + 1000,
        source: { taskId: task.id, eventSeq: 1, quote: "测试证据" } }] } });
    unchanged(id, saved);
    expect(dom.window.document.querySelector("#main")!.textContent).toContain("新观察");
  });

  it("loads context content into an untouched field and retains unfocused drafts", () => {
    state.set({ view: "ctx" });
    state.set({ ctx: { ...state.get().ctx, text: "载入内容" } });
    expect(field("ctx-text").value).toBe("载入内容");
    const saved = edit("ctx-text");
    saved.el.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
    field("mem-text").focus();
    state.set({ health: false });
    expect(field("ctx-text")).toBe(saved.el);
    expect(saved.el.value).toBe("正在输入中文，保留草稿");
    saved.observer.disconnect();
  });

  it("does not share a follow-up draft across tasks, navigation or composer identities", async () => {
    state.set({ view: "task", task });
    const old = edit("f-task");
    state.set({ task: { ...task, id: "task-two" } });
    expect(field("f-task")).not.toBe(old.el);
    expect(field("f-task").value).toBe("");
    field("f-task").value = "第二个草稿";
    state.set({ view: "home" });
    expect(field("c-task").value).toBe("");
    old.observer.disconnect();
    const { createRenderer } = await import(join(UI, "lib/rendering.js"));
    const root = dom.window.document.createElement("div");
    dom.window.document.body.append(root);
    const render = createRenderer(root);
    render.render('<div data-composer-key="one"><textarea id="draft"></textarea></div>', "same-view");
    field("draft").value = "旧任务草稿";
    render.render('<div data-composer-key="two"><textarea id="draft"></textarea></div>', "same-view");
    expect(field("draft").value).toBe("");
  });

  it("never sends Ctrl/Meta+Enter during composition, including browser fallback signals", () => {
    const saved = edit("c-task");
    const send = vi.fn((e: Event) => e.stopImmediatePropagation());
    field("c-send").addEventListener("click", send);
    const key = (options: KeyboardEventInit = {}) => saved.el.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true, key: "Enter", ctrlKey: true, ...options,
    }));
    key();
    state.set({ health: false });
    key({ ctrlKey: false, metaKey: true });
    saved.el.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
    key({ isComposing: true });
    key({ keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
    key();
    expect(send).toHaveBeenCalledTimes(1);
    saved.observer.disconnect();
  });
});

describe("polling and equivalent state", () => {
  it("only polls quota every two visible minutes while ordinary polling continues in the background", async () => {
    const requests = (path: string) => fetcher.mock.calls.filter(([url]) => url === path).length;
    expect(requests("/quota")).toBe(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(requests("/quota")).toBe(1);
    expect(requests("/healthz")).toBe(24);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests("/quota")).toBe(2);
    Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests("/quota")).toBe(2);
    expect(requests("/healthz")).toBe(49);
    field("q-refresh").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests("/quota?refresh=1")).toBe(1);
  });

  it("does not notify or render equivalent JSON responses, but keeps opaque handles distinct", () => {
    const updates = vi.fn();
    const off = state.subscribe(updates);
    state.set({ tasks: [task] });
    const stable = state.get();
    updates.mockClear();
    const observer = new dom.window.MutationObserver(() => undefined);
    observer.observe(dom.window.document.body, { attributes: true, childList: true, subtree: true });
    state.set({ tasks: [{ ...task }], health: stable.health, approvals: [] });
    expect(state.get()).toBe(stable);
    expect(updates).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    const first = new dom.window.File(["one"], "one.txt"), second = new dom.window.File(["two"], "two.txt");
    state.patch({ pending: [{ file: first, url: "blob:same" }] });
    state.set({ pending: [{ file: second, url: "blob:same" }] });
    expect(state.get().pending[0].file).toBe(second);
    expect(updates).toHaveBeenCalledTimes(1);
    off(); observer.disconnect();
  });
});
