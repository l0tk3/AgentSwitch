import { describe, expect, it } from "vitest";
import { parseSummary, renderSummary, routerSummarizer, summaryMessage, SUMMARY_SYSTEM } from "../src/threads/summary.js";
import type { Router } from "../src/router/routers/types.js";

const good = { title: "Fix login form", goal: "Make the React login work", progress: "Form found; submit still fails", files: ["src/login.tsx"], unresolved: ["submit returns 400"], decisions: ["use secret_fill for the password box"], facts: ["core login form is React"] };

describe("summary", () => {
  it("parses a JSON object even when wrapped in prose, applies defaults", () => {
    const r = parseSummary(`Sure! ${JSON.stringify({ title: "T", goal: "G" })} done`);
    expect(r).toEqual({ ok: true, summary: { title: "T", goal: "G", progress: "", files: [], unresolved: [], decisions: [], facts: [] } });
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
