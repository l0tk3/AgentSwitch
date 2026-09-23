import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const state = await import(join(UI, "lib/state.js"));
const detail = await import(join(UI, "views/task.js"));
const receipt = (over: Record<string, unknown> = {}) => ({
  type: "feedback", seq: 1, ts: 1,
  payload: { version: 1, source: "user", status: "answered", questions: [], answers: {}, ...over },
});

describe("feedback timeline receipts", () => {
  it("keeps user confirmation distinct from a router answer", () => {
    const user = detail.eventLine(receipt());
    const router = detail.eventLine(receipt({ source: "router" }));
    expect(user).toContain("反馈已记录（用户确认）");
    expect(router).toContain("反馈已记录（路由器答复）");
    expect(router).not.toContain("用户确认");
    for (const line of [user, router]) expect(line).toContain("已加入后续上下文");
  });

  it.each(["user", "router"])("an unanswered %s feedback does not imply a recorded answer or a second question card", (source) => {
    const line = detail.eventLine(receipt({ source, status: "unanswered", answers: null }));
    expect(line).toBe("反馈待答复 · 尚无有效答复");
    expect(line).not.toMatch(/已记录|已加入|用户确认|请.*回答/);
  });

  it.each([null, "malformed", {}, { version: 2, source: "user", status: "answered" }, { version: 1, source: "unknown", status: "answered" }, { version: 1, source: "router", status: "pending" }])("handles malformed receipt payload %j without inventing confirmation", (payload) => {
    expect(detail.eventLine({ type: "feedback", payload })).toBe("反馈记录（格式待核对）");
  });

  it("does not repeat arbitrary question, answer or reason data in the receipt", () => {
    const privateMaterial = "PRIVATE_FEEDBACK_CONTENT";
    const line = detail.eventLine(receipt({
      questions: [{ text: privateMaterial }], answers: { q: [privateMaterial] }, reason: privateMaterial,
      approvalId: privateMaterial,
    }));
    expect(line).not.toContain(privateMaterial);
  });

  it("renders feedback beside escaped question and answer events without active markup", () => {
    const untrusted = '<img src=x onerror="alert(1)">';
    const task = { id: "feedback-fixture", task: "验证反馈展示", cwd: "/fixture", createdAt: 1, status: "running" };
    const page = detail.render({
      ...structuredClone(state.get()), task, tasks: [task],
      events: [
        { type: "approval_request", seq: 1, ts: 1, payload: { kind: "question", source: "executor", questions: [{ text: untrusted }] } },
        { type: "approval_resolved", seq: 2, ts: 2, payload: { decision: "answer", text: untrusted } },
        receipt({ questions: [{ text: untrusted }], answers: { q: [untrusted] }, reason: untrusted }),
      ],
    });
    expect(page).toContain("反馈已记录（用户确认）");
    expect(page).toContain("&lt;img");
    expect(page).not.toContain("<img");
    expect(page.match(/&lt;img/g)).toHaveLength(2);
  });
});
