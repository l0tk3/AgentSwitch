import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const state = await import(join(UI, "lib/state.js"));
const actions = await import(join(UI, "lib/actions.js"));
const home = await import(join(UI, "views/home.js"));
const detail = await import(join(UI, "views/task.js"));
const feedback = await import(join(UI, "lib/feedback.js"));
const initial = structuredClone(state.get());
const task = { id: "fixture", task: "完成配置和复查", cwd: "/fixture", createdAt: 1, status: "partial", result: "配置已保存", error: "尚未复查" };
const reply = (body: unknown) => new Response(JSON.stringify(body));

beforeEach(() => state.set({ ...structuredClone(initial), view: "task", task, tasks: [task] }));
afterEach(() => vi.unstubAllGlobals());

describe("incomplete task UI", () => {
  it.each(["partial", "blocked"])("%s is a yellow terminal result with a reason and a follow-up", (status) => {
    const current = { ...task, status };
    state.set({ task: current, tasks: [current] });
    expect(feedback.feedback(current, [])).toMatchObject({ stage: 3, tone: "warn", label: status === "partial" ? "部分完成" : "执行受阻" });
    const page = detail.render(state.get());
    expect(page).toContain(`badge ${status}`);
    expect(page).toContain("已保存的进展");
    expect(page).toContain("未完成原因");
    expect(page).not.toContain('class="card ok"');
    expect(page).not.toContain('id="t-cancel"');
    expect(page).toContain('id="f-send"');
    expect(home.render(state.get())).toContain(status === "partial" ? "部分完成" : "执行受阻");
  });

  it.each([
    ["规划调用超时：45 秒内未能给出动作", "规划超时"],
    ["规划服务未能给出有效动作，请核对现场后继续", "规划失败"],
    ["等待你的答复：请选择使用哪个环境", "待补充条件"],
    ["waiting for your answer: Which environment?", "待补充条件"],
    ["副作用未知，请先核对现场", "执行受阻"],
  ])("blocked reason %s has the matching label without inventing missing information", (error, label) => {
    const current = { ...task, status: "blocked", error };
    state.set({ task: current, tasks: [current] });
    expect(feedback.feedback(current, [])).toMatchObject({ label, detail: error });
    expect(detail.render(state.get())).toContain(label);
    expect(home.render(state.get())).toContain(label);
    if (label !== "待补充条件") expect(detail.render(state.get())).not.toContain("待补充条件");
  });

  it.each([
    ["timeout", "调用超时"], ["invalid_response", "回复格式无效"], ["service_error", "服务调用失败"], ["cancelled", "已取消"],
  ])("planning %s reports the stage, model, specific error, elapsed time and attempts", (failureKind, message) => {
    const line = detail.eventLine({ type: "step", payload: { action: "plan", source: "error", stage: "initial_plan", model: "claude-code/fixture-model", failureKind, routerError: "规划服务未返回下一步动作", routerMs: 45123, tries: 2 } });
    for (const fragment of ["初次规划已停止", "claude-code/fixture-model", message, "规划服务未返回下一步动作", "耗时 45.1 秒", "尝试 2 次"]) expect(line).toContain(fragment);
    expect(line).not.toContain("按路由器的决定执行");
    const next = detail.eventLine({ type: "step", payload: { action: "plan", source: "error", stage: "next_action", failureKind, routerError: "loop model timed out", routerMs: 0, tries: 1 } });
    expect(next).toContain("下一步规划已停止");
    expect(next).toContain("规划调用超时");
    expect(next).toContain("耗时 0.0 秒");
    expect(next).not.toContain("undefined");
  });

  it("executor and router question cards both explain that declining stops execution", () => {
    for (const source of ["router", "executor"]) {
      const card = home.approvalCard({ id: "q", taskId: "fixture", kind: "question", createdAt: 1, evidence: JSON.stringify({ source, questions: [{ id: "q", text: "继续吗？" }] }) }, task);
      expect(card).toContain("暂不回答，停止执行");
      expect(card).not.toContain("自己看着办");
    }
  });

  it("new SSE events update the terminal task and preserve checkpoint evidence in the timeline", async () => {
    type Listener = (message: { data: string }) => Promise<void>;
    const listeners = new Map<string, Listener>();
    vi.stubGlobal("EventSource", class { addEventListener(type: string, listener: Listener) { listeners.set(type, listener); } close() {} });
    let responseTask = { ...task, status: "running" };
    vi.stubGlobal("fetch", vi.fn(async (path: string) => reply(path === "/approvals" ? [] : path.endsWith("/files") ? { root: null, files: [] } : responseTask)));
    actions.openTask(task.id);
    await vi.waitFor(() => expect(state.get().task.status).toBe("running"));
    expect([...listeners.keys()]).toEqual(expect.arrayContaining(["checkpoint", "partial", "blocked"]));
    const point = { type: "checkpoint", seq: 1, ts: 1, payload: { purpose: "do", ok: false, result: "需要检查远端是否已提交", sideEffectsKnown: false, sideEffects: { filesChanged: 0, commandsRun: 1, approvalsGranted: 0 } } };
    await listeners.get("checkpoint")!({ data: JSON.stringify(point) });
    responseTask = { ...task, status: "blocked" };
    await listeners.get("blocked")!({ data: JSON.stringify({ type: "blocked", seq: 2, ts: 2, payload: { error: task.error } }) });
    expect(state.get().task.status).toBe("blocked");
    const page = detail.render(state.get());
    expect(page).toContain("已保存步骤进展");
    expect(page).toContain("副作用记录不完整，继续前请核对现场");
    expect(page).toContain("需要检查远端是否已提交");
  });
});
