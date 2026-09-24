import { describe, expect, it } from "vitest";
import { EMPTY_FOLD, foldMessage, outcomeFromFold } from "../src/executors/claude.js";
import { applyNotification, EMPTY_TURN, outcomeFromTurn } from "../src/executors/codex.js";
import { outcomeFromRun, summarizeRun } from "../src/executors/opencode.js";
import { classifyFailure, excerpt } from "../src/router/failure.js";
import { detectRefusal } from "../src/core/outcome.js";

describe("conservative final-text refusal detection", () => {
  it.each([
    "I can't help with that request.",
    "I cannot assist with the requested operation.",
    "I'm unable to provide those instructions.",
    "I’m not able to assist with this request.",
    "I'm sorry, but I can’t help with that.",
    "Sorry, I won't be able to help with this request.",
    "I'm not going to carry out this task.",
    "I am not going to fulfill this request.",
    "I am not going to perform this request.",
    "I will not carry out this task.",
    "I’m sorry, but I’m not going to carry out this task.",
    "**I cannot help with that request.**",
    "抱歉，我无法协助完成这个操作。",
    "我不能帮你完成这个请求。",
    "很抱歉，无法提供这类指导。",
    "无法协助提供这类操作步骤。",
    "不能帮助你执行这项请求。",
  ])("recognizes a direct refusal: %s", (lastText) => {
    expect(detectRefusal({ ok: true, lastText })?.source).toBe("text");
    expect(classifyFailure({ ok: true, lastText })).toBe("refusal");
  });

  it.each([
    '> I cannot help with that request.',
    '"I cannot help with that request." is an example response.',
    "```text\nI cannot help with that request.\n```",
    "    I cannot help with that request.",
    "\tI cannot help with that request.",
    "The model replied: I cannot help with that request.",
    "The refusal handler now recognizes safety guidelines in errors.",
    'Log: stop_reason="refusal"',
    "# Refusal examples\nI cannot help with that request.",
    "无法协助是这篇文章分析的例句。",
    "> 无法协助提供这类操作步骤。",
    "```text\n不能帮助你执行这项请求。\n```",
    "I am unable to connect to the service.",
    "I cannot help but notice the test passed.",
    "I'm not going to carry out the old plan; the change is finished.",
    "I am not going to perform the old migration; the new migration is complete.",
    '> I\'m not going to carry out this task.',
    '"I\'m not going to carry out this task." is the regression fixture.',
    "The request was refused by the proxy: ECONNREFUSED.",
    "Implemented successfully.\n\nFixture: I can't assist with that.",
  ])("does not mistake quoted or ordinary content for refusal: %s", (lastText) => {
    expect(detectRefusal({ ok: true, lastText })).toBeNull();
    expect(classifyFailure({ ok: true, lastText })).toBeNull();
  });

  it("does not infer provider signals or text refusals from stderr", () => {
    expect(detectRefusal({ ok: false, stderr: 'I cannot help. stop_reason="refusal"' })).toBeNull();
    expect(classifyFailure({ ok: false, stderr: "connection refused ECONNREFUSED" })).toBe("transport");
    expect(classifyFailure({ ok: false, stderr: "rate limit exceeded; request refused" })).toBe("quota");
  });

  it.each([300, 33_000])("preserves complete refusal evidence beyond %i characters", (length) => {
    const lastText = `I cannot assist with that request.\n\n${"Explanation. ".repeat(Math.ceil(length / 13))}\n\nThis remains disallowed by policy even if authorization is provided.`;
    const outcome = { ok: true, lastText };
    expect(detectRefusal(outcome)).toEqual({ source: "text", reason: lastText });
    expect(excerpt(outcome)).toHaveLength(240);
    expect(excerpt(outcome)).not.toContain("even if authorization");
  });
});

describe("executor refusal normalization", () => {
  it("preserves Claude no-fallback evidence and session even without a result", () => {
    const state = foldMessage(EMPTY_FOLD, {
      type: "system", subtype: "model_refusal_no_fallback", session_id: "session-refused",
      api_refusal_category: "cyber", api_refusal_explanation: "Provider blocked the operation.", content: "Blocked.",
    } as never);
    const outcome = outcomeFromFold(state, 0, false);
    expect(outcome).toMatchObject({ ok: false, sessionId: "session-refused", refusal: { source: "provider", reason: expect.stringContaining("Provider blocked the operation.") } });
    expect(classifyFailure(outcome)).toBe("refusal");
  });

  it("recognizes Claude's top-level assistant refusal stop reason", () => {
    const message = { type: "assistant", session_id: "session-1", parent_tool_use_id: null, message: { stop_reason: "refusal", content: [{ type: "text", text: "Blocked." }] } };
    expect(outcomeFromFold(foldMessage(EMPTY_FOLD, message as never), 0, false)).toMatchObject({ sessionId: "session-1", refusal: { source: "provider" } });
    expect(foldMessage(EMPTY_FOLD, { ...message, parent_tool_use_id: "subagent-call" } as never).refusal).toBeNull();
  });

  it("catches Claude text refusal in success results and retains the resume handle", () => {
    const result = { type: "result", subtype: "success", is_error: false, result: "I cannot assist with that request.", session_id: "session-2", usage: {} };
    const outcome = outcomeFromFold(foldMessage(EMPTY_FOLD, result as never), 0, false);
    expect(outcome).toMatchObject({ ok: false, exitCode: 0, sessionId: "session-2", lastText: result.result, refusal: { source: "text" } });
  });

  it("uses Claude's final result rather than an earlier assistant message", () => {
    let state = foldMessage(EMPTY_FOLD, { type: "assistant", message: { content: [{ type: "text", text: "I can't help with the old request." }] } } as never);
    state = foldMessage(state, { type: "result", subtype: "success", is_error: false, result: "The requested analysis is complete.", usage: {} } as never);
    expect(outcomeFromFold(state, 0, false)).toMatchObject({ ok: true });
  });

  it("maps Codex cyberPolicy errors from both documented protocol locations", () => {
    const error = { message: "Provider blocked the request.", codexErrorInfo: "cyberPolicy", additionalDetails: null };
    const notified = applyNotification(EMPTY_TURN, "error", { error, willRetry: false, threadId: "t", turnId: "turn" });
    const completed = applyNotification(EMPTY_TURN, "turn/completed", { turn: { id: "turn", status: "failed", error } });
    for (const state of [notified, completed]) {
      expect(outcomeFromTurn(state, null)).toMatchObject({ ok: false, refusal: { source: "provider", reason: expect.stringContaining("cyberPolicy") } });
    }
  });

  it("does not guess a refusal from untyped Codex metadata or tool output", () => {
    let state = applyNotification(EMPTY_TURN, "turn/moderationMetadata", { metadata: { refusal: true } });
    state = applyNotification(state, "item/completed", { item: { type: "commandExecution", aggregatedOutput: 'I cannot help; codexErrorInfo="cyberPolicy"' } });
    state = applyNotification(state, "item/completed", { item: { type: "agentMessage", text: "Finished successfully.", phase: "final_answer" } });
    state = applyNotification(state, "turn/completed", { turn: { status: "completed", error: null } });
    expect(outcomeFromTurn(state, null)).toMatchObject({ ok: true });
    expect(outcomeFromTurn(state, null).refusal).toBeUndefined();
  });

  it("checks the final Codex reply even when earlier commentary was successful", () => {
    let state = applyNotification(EMPTY_TURN, "item/completed", { item: { type: "agentMessage", text: "I will inspect the task.", phase: "commentary" } });
    state = applyNotification(state, "item/completed", { item: { type: "agentMessage", text: "I can't assist with this request.", phase: "final_answer" } });
    state = applyNotification(state, "turn/completed", { turn: { status: "completed", error: null } });
    expect(outcomeFromTurn(state, null)).toMatchObject({ ok: false, lastText: "I can't assist with this request.", refusal: { source: "text" } });
  });

  it("preserves indented code in Codex's final reply", () => {
    let state = applyNotification(EMPTY_TURN, "item/completed", { item: { type: "agentMessage", text: "    I cannot assist with this request.", phase: "final_answer" } });
    state = applyNotification(state, "turn/completed", { turn: { status: "completed", error: null } });
    expect(classifyFailure(outcomeFromTurn(state, null))).toBeNull();
  });

  it("catches a zero-exit OpenCode refusal while preserving its session", () => {
    const summary = summarizeRun(JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "抱歉，我无法协助完成这个操作。" } }));
    expect(outcomeFromRun(summary, 0, "", false)).toMatchObject({ ok: false, exitCode: 0, sessionId: "ses_1", refusal: { source: "text" } });
    const quoted = summarizeRun(JSON.stringify({ type: "text", part: { text: "    I cannot help with that request." } }));
    expect(classifyFailure(outcomeFromRun(quoted, 0, "", false))).toBeNull();
  });
});
