/** The old dispatch off (ui/lib/oldDispatch.js, 2026-11-24): no composer, its controls disabled with the note, no
 *  request sent; the old tasks still listed and opened, and the way to the terminals in place of the composer. */
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const off = await import(join(UI, "lib/oldDispatch.js"));
const state = await import(join(UI, "lib/state.js"));
const actions = await import(join(UI, "lib/actions.js"));
const home = await import(join(UI, "views/home.js"));
const detail = await import(join(UI, "views/task.js"));
const ctx = await import(join(UI, "views/ctx.js"));
const { sidebar } = await import(join(UI, "lib/sidebar.js"));
const initial = structuredClone(state.get());
const task = { id: "task-1", threadId: "thread-1", task: "配置测试环境", status: "done", harness: "codex", createdAt: 1, cwd: "/tmp" };
const thread = { id: "thread-1", status: "open", title: "配置", updatedAt: 1, tasks: [task] };
const ask = { id: "ap-1", taskId: task.id, kind: "permission", action: "rm -rf build", createdAt: 1 };
const question = { id: "ap-2", taskId: task.id, kind: "question", action: "哪个环境？", createdAt: 1 };
const NOTE = "旧调度已停用，新调度测试中。";
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetcher = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("document", { querySelector: () => null, getElementById: () => null, documentElement: { classList: { contains: () => false } } });
  state.set({ ...structuredClone(initial), view: "task", task, tasks: [task], threads: [thread], thread, approvals: [ask, question],
    policy: { policy: { mode: "scoped", human: [] }, categories: [{ id: "delete", title: "删除" }] } });
});
afterEach(() => vi.unstubAllGlobals());

describe("old dispatch off", () => {
  it("is off by default, behind one constant", () => {
    expect(off.OLD_DISPATCH_OFF).toBe(true);
    expect(off.oldDispatchOff()).toBe(true);
  });

  it("shows a notice and the way to the terminals in place of the composer, and still lists the old tasks", () => {
    const html = home.render(state.get());
    expect(html).not.toContain('id="c-task"');
    expect(html).not.toContain('id="c-send"');
    expect(html).toContain("Dispatch Off");
    expect(html).toContain(NOTE);
    expect(html).toContain('href="/ui/terminal.html"');
    expect(html).toContain('data-open="task-1"');
  });

  it("disables approving and answering, follow-up, hand-off, rating and archiving, with the note", () => {
    const html = home.render(state.get()) + detail.render(state.get());
    expect(html).toMatch(/data-decision="allow" disabled title="旧调度已停用，新调度测试中。"/);
    expect(html).toMatch(/data-answer="ap-2"[^>]*disabled/);
    expect(html).not.toContain('id="f-task"');
    expect(html).toMatch(/id="t-handoff" disabled/);
    expect(html).toMatch(/data-rate="1" disabled/);
    expect(html).toMatch(/id="t-archive" disabled/);
    expect(sidebar(state.get())).toContain("· Off");
    expect(ctx.render({ ...state.get(), view: "ctx" })).toMatch(/id="pol-save" disabled/);
  });

  it("sends nothing to the daemon", async () => {
    await actions.submitTask({ task: "x", ephemeral: true });
    await actions.approve(task.id, ask.id, "allow");
    await actions.answer(task.id, question.id, { text: "prod" });
    await actions.rateTask(task.id, 1);
    await actions.handoffTask(task.id, "");
    await actions.archiveThread(thread.id);
    await actions.savePolicy({ mode: "auto", human: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
