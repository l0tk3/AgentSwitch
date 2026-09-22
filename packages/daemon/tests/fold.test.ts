import { describe, expect, it } from "vitest";
import { foldThread } from "../src/threads/fold.js";
import { FOLD, type ThreadEvent } from "../src/threads/types.js";

const ev = (seq: number, type: ThreadEvent["type"], payload: Record<string, unknown>, ts = seq * 1000): ThreadEvent => ({ threadId: "t1", seq, ts, type, payload });

describe("foldThread", () => {
  it("empty log → empty state", () => {
    expect(foldThread([])).toMatchObject({ tasks: [], sessions: {}, summary: null, title: null, handoffs: [], cost: {}, lastTarget: null });
  });

  it("task accumulates, cost adds up per harness/model, lastTarget follows the latest task", () => {
    const s = foldThread([
      ev(1, "task", { taskId: "a", harness: "claude-code", model: "claude-sonnet-5", status: "failed", kind: "refusal", tokens: 100 }),
      ev(2, "task", { taskId: "b", harness: "codex", model: "gpt-5.5", status: "done", tokens: 50 }),
      ev(3, "task", { taskId: "c", harness: "codex", model: "gpt-5.5", status: "done", tokens: 25 }),
    ]);
    expect(s.tasks.map((t) => t.taskId)).toEqual(["a", "b", "c"]);
    expect(s.cost).toEqual({ "claude-code/claude-sonnet-5": 100, "codex/gpt-5.5": 75 });
    expect(s.lastTarget).toEqual({ harness: "codex", model: "gpt-5.5" });
    expect(s.lastActivity).toBe(3000);
  });

  it("session is last-wins per harness: two harnesses keep one handle each", () => {
    const s = foldThread([
      ev(1, "session", { harness: "claude-code", sessionId: "c1", taskId: "a" }),
      ev(2, "session", { harness: "codex", sessionId: "x1", taskId: "b" }),
      ev(3, "session", { harness: "claude-code", sessionId: "c2", taskId: "c" }),
    ]);
    expect(Object.keys(s.sessions).sort()).toEqual(["claude-code", "codex"]);
    expect(s.sessions["claude-code"]!.sessionId).toBe("c2");
    expect(s.sessions.codex!.sessionId).toBe("x1");
  });

  it("summary is last-wins, seeds the title once; title events override", () => {
    const s = foldThread([
      ev(2, "summary", { title: "Fix login", goal: "make login work", progress: "half", files: ["a.ts"], unresolved: [], decisions: ["use React form"] }),
      ev(4, "summary", { title: "Fix login v2", goal: "make login work", progress: "done", files: ["a.ts", "b.ts"], unresolved: [], decisions: [] }),
      ev(5, "title", { title: "用户改的标题" }),
    ]);
    expect(s.summary!.progress).toBe("done");
    expect(s.summarySeq).toBe(4);
    expect(s.title).toBe("用户改的标题");
    expect(foldThread([ev(1, "summary", { title: "T", goal: "g" })]).title).toBe("T");
  });

  it("handoff accumulates with summaryRef; malformed payloads are ignored, order follows seq", () => {
    const s = foldThread([
      ev(3, "handoff", { from: { harness: "codex", model: "gpt-5.5", taskId: "b" }, to: { harness: "claude-code", taskId: "c" }, reason: "user", summaryRef: 2 }),
      ev(1, "handoff", { from: { harness: "claude-code", model: "claude-sonnet-5", taskId: "a" }, to: null, reason: "failure:refusal" }),
      ev(2, "handoff", { nothing: true }),
      ev(4, "session", { harness: "codex" }),
      ev(5, "task", { taskId: "z", harness: "codex", model: "gpt-5.5", status: "done", tokens: 12 }),
    ]);
    expect(s.handoffs.map((h) => h.reason)).toEqual(["failure:refusal", "user"]);
    expect(s.handoffs[1]!.summaryRef).toBe(2);
    expect(s.sessions).toEqual({});
    expect(s.cost).toEqual({ "codex/gpt-5.5": 12 });
  });

  it("every event type declares a fold policy", () => {
    expect(Object.keys(FOLD).sort()).toEqual(["handoff", "session", "summary", "task", "title"]);
  });
});
