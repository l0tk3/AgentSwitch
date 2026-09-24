import { describe, expect, it } from "vitest";
import { parseSummary, renderSummary, routerSummarizer, summaryMessage, SUMMARY_SYSTEM } from "../src/threads/summary.js";
import type { Router } from "../src/core/modelCall.js";

const good = { title: "Fix login form", goal: "Make the React login work", progress: "Form found; submit still fails", files: ["src/login.tsx"], unresolved: ["submit returns 400"], decisions: ["use secret_fill for the password box"], facts: ["core login form is React"], spoken: "登录成功，首页标题是 MailLab" };

describe("summary", () => {
  it("parses a JSON object even when wrapped in prose, applies defaults", () => {
    const r = parseSummary(`Sure! ${JSON.stringify({ title: "T", goal: "G" })} done`);
    expect(r).toEqual({ ok: true, summary: { title: "T", goal: "G", progress: "", files: [], unresolved: [], decisions: [], facts: [], spoken: "", speech: "" } });
  });

  it("keeps a spoken script for listening, cleaned of what a voice must not read", () => {
    const token = "enc:v1:" + "A".repeat(40);
    const r = parseSummary(JSON.stringify({ ...good, spoken: `**做完了** ${token}`, speech: `**结论**：详见 https://x.com/a/status/2103 ，@chenju_ai 说 ${token} 可用。\n- 第二点 \`code\`` }));
    expect(r).toMatchObject({ ok: true, summary: { spoken: "做完了", speech: "结论：详见，chenju_ai 说 可用。第二点 code" } });
    expect(SUMMARY_SYSTEM).toMatch(/"speech": "<.*read aloud.*at most 250 characters/s);
  });

  it("rejects missing fields and non-JSON", () => {
    expect(parseSummary("nothing here").ok).toBe(false);
    expect(parseSummary('{"title":"x"}')).toMatchObject({ ok: false, error: expect.stringContaining("goal") });
  });

  it("lints credential-looking values out of the summary text but keeps enc:v1: tokens", () => {
    const r = parseSummary(JSON.stringify({ ...good, decisions: ["password: hunter2secret", "token enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA"] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.decisions[0]).toContain("[removed");
    expect(r.summary.decisions[0]).not.toContain("hunter2secret");
    expect(r.summary.decisions[1]).toContain("enc:v1:");
  });

  it("message carries previous summary, brief, result and diff; render is stable text", () => {
    const m = summaryMessage({ previous: good, task: "fix login", brief: "do it", target: "codex/gpt-5.5", status: "failed", result: "400", diff: " M src/login.tsx", cwd: "/w" });
    expect(m).toContain('"title":"Fix login form"');
    expect(m).toContain("codex/gpt-5.5");
    expect(m).toContain("status: failed");
    expect(renderSummary(good)).toBe("Title: Fix login form\nGoal: Make the React login work\nProgress: Form found; submit still fails\nFiles:\n- src/login.tsx\nUnresolved:\n- submit returns 400\nDecisions:\n- use secret_fill for the password box");
    expect(SUMMARY_SYSTEM).toContain("enc:v1:");
  });

  it("accepts optional checkpoint-backed platform candidates and strips unsafe memory while preserving legacy shape", () => {
    const candidate = { origin: "https://admin.example.test", key: "users.list", text: "Users is inside Settings.", kind: "operation", eventSeq: 8, quote: "Users is inside Settings." };
    const parsed = parseSummary(JSON.stringify({ ...good, facts: ["tests take four minutes", "token enc:v1:AAAAAAAAAAAAAAAAAAAA", "account: administrator"], platformFacts: [candidate, { ...candidate, key: "unsafe", quote: "account: administrator" }] }));
    expect(parsed).toMatchObject({ ok: true, summary: { facts: ["tests take four minutes"], platformFacts: [candidate] } });
    const message = summaryMessage({ previous: null, task: "inspect admin", brief: null, target: "fake/model", status: "done", result: "unverified prose", diff: "", cwd: "/w", knownPlatformOrigins: [candidate.origin], evidence: [{ seq: 8, ts: 100, purpose: "verify", ok: true, result: candidate.quote }] });
    expect(message).toContain("Known platform origins (scope only, not authorization):\nhttps://admin.example.test");
    expect(message).toContain('"seq":8');
    expect(message).toContain('"purpose":"verify"');
    expect(message).toContain('"result":"Users is inside Settings."');
  });

  it("bounds a router that ignores cancellation and never starts with an already aborted signal", async () => {
    let calls = 0;
    const input = { previous: null, task: "t", brief: null, target: "x/y", status: "done", result: "r", diff: "", cwd: "/w" };
    const ignoringAbort: Router = { name: "ignores-abort", route: () => { calls++; return new Promise(() => {}); } };
    expect(await routerSummarizer(ignoringAbort, 20)(input)).toMatchObject({ summary: null, error: "summarizer timed out" });
    const controller = new AbortController(); controller.abort();
    expect(await routerSummarizer(ignoringAbort, 1000)(input, controller.signal)).toMatchObject({ summary: null, error: "cancelled" });
    expect(calls).toBe(1);
  });

  it("preserves middle and terminal blockers when summarizing long output and checkpoints", () => {
    const output = `START\n${"routine progress ".repeat(600)}\n阻塞：缺少必填字段，尚未提交第二步\n${"routine progress ".repeat(600)}\nEND: task remains incomplete`;
    const message = summaryMessage({ previous: null, task: "Complete both steps", brief: null, target: "fake/model", status: "partial", result: output, error: "需要用户补充字段后才能继续", diff: "", cwd: "/w", evidence: [{ seq: 1, ts: 10, purpose: "do", ok: false, result: output }] });
    expect(message).toContain("status: partial");
    expect(message).toContain("需要用户补充字段后才能继续");
    expect(message.match(/缺少必填字段，尚未提交第二步/g)).toHaveLength(2);
    expect(message.match(/END: task remains incomplete/g)).toHaveLength(2);
    expect(message).toContain("evidence abbreviated");
  });

  it("routerSummarizer: uses the summary system prompt, returns null on bad output or errors, never throws", async () => {
    const calls: { system: string; task: string }[] = [];
    const fake = (reply: () => Promise<string>): Router => ({ name: "fake", route: async (input) => { calls.push({ system: input.system, task: input.task }); return { text: await reply(), elapsedMs: 1 }; } });
    const ok = await routerSummarizer(fake(async () => JSON.stringify(good)))({ previous: null, task: "t", brief: null, target: "x/y", status: "done", result: "r", diff: "", cwd: "/w" });
    expect(ok.summary?.title).toBe("Fix login form");
    expect(calls[0]!.system).toBe(SUMMARY_SYSTEM);
    const bad = await routerSummarizer(fake(async () => "garbage"))({ previous: null, task: "t", brief: null, target: "x/y", status: "done", result: "r", diff: "", cwd: "/w" });
    expect(bad).toMatchObject({ summary: null, error: expect.stringContaining("JSON") });
    const thrown = await routerSummarizer(fake(async () => { throw new Error("boom"); }))({ previous: null, task: "t", brief: null, target: "x/y", status: "done", result: "r", diff: "", cwd: "/w" });
    expect(thrown).toMatchObject({ summary: null, error: "boom" });
    const slow: Router = { name: "slow", route: (_i, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(signal.reason))) };
    const timedOut = await routerSummarizer(slow, 20)({ previous: null, task: "t", brief: null, target: "x/y", status: "done", result: "r", diff: "", cwd: "/w" });
    expect(timedOut.error).toMatch(/timed out/);
  });
});
