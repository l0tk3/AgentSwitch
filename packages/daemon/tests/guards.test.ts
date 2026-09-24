import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import { echoExecutor } from "../src/executors/echo.js";
import { Decision } from "../src/router/decision.js";
import { extensionsSection, memorySection, recordSection, systemPrompt } from "../src/router/prompt.js";
import { kindOf, route } from "../src/router/route.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { validateDecision, type Context } from "../src/router/validate.js";
import type { RecordRow } from "../src/router/record.js";
import type { Summarizer } from "../src/threads/summary.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();
const base: Context = { targets, quota: {}, lowConfidenceTarget: { harness: "claude-code", model: "claude-sonnet-4-6" } };
const d = (over: Record<string, unknown> = {}) => Decision.parse({ harness: "codex", model: "gpt-6-astra", effort: "high", brief: "x", confidence: 0.9, ...over });
const opus = { harness: "claude-code", model: "claude-opus-5" };
const strike = (i: number, over: Partial<RecordRow> = {}): RecordRow => ({ taskId: `s${i}`, ts: Date.now() - 1000 + i, kind: "code-multifile", harness: "codex", model: "gpt-6-astra", status: "failed", failureKind: "refusal", ms: 1, tokens: 0, approvals: 0, handedOff: false, pinned: false, userHandoff: false, rating: null, ...over });

describe("track-record guards in validateDecision", () => {
  it("a demoted primary is tried after the fallbacks (and before router.default); effort is dropped with it", () => {
    const v = validateDecision(d({ fallbacks: [opus] }), { ...base, guards: { demoted: [{ harness: "codex", model: "gpt-6-astra" }], overridden: [] } });
    expect(v).toMatchObject({ ok: true, harness: "claude-code", model: "claude-opus-5", chosen: "fallback", effort: null });
    expect(v.notes[0]).toContain("demoted");
    const noFallback = validateDecision(d(), { ...base, guards: { demoted: [{ harness: "codex", model: "gpt-6-astra" }], overridden: [] } });
    expect(noFallback).toMatchObject({ ok: true, harness: "codex", model: "gpt-6-astra", chosen: "fallback" });
  });

  it("an overridden primary passes, with a note when the router gave no reason", () => {
    const guards = { demoted: [], overridden: [{ harness: "codex", model: "gpt-6-astra" }] };
    expect(validateDecision(d({ reason: "" }), { ...base, guards }).notes[0]).toContain("gave no reason");
    expect(validateDecision(d({ reason: "astra has the best record on this repo" }), { ...base, guards }).notes).toEqual([]);
  });

  it("route(): three refusals on the same kind demote the router's pick; kindOf falls back to the coarse class", async () => {
    const records = [strike(1), strike(2), strike(3)];
    const router = echoRouter([decisionJson({ harness: "codex", model: "gpt-6-astra", effort: "high", kind: "code-multifile", fallbacks: [opus] })]);
    const r = await route({ task: "refactor the parser", cwd: "/tmp" }, { targets, router, quota: {}, records });
    expect(r.verdict).toMatchObject({ ok: true, harness: "claude-code", model: "claude-opus-5", chosen: "fallback" });
    expect(router.calls[0]!.system).toContain("Track record, last 30 days");
    expect(router.calls[0]!.system).toContain("code-multifile: codex/gpt-6-astra 3 runs 0 ok");
    expect(kindOf("fix the bug in x.ts", null)).toBe("code");
    expect(kindOf("open the website and log in", null)).toBe("browser");
    expect(kindOf("x", d({ kind: "translate" }))).toBe("translate");
  });
});

describe("prompt sections", () => {
  it("memory, record and extensions appear only when present; the shape asks for kind", () => {
    expect(memorySection(undefined)).toBe("");
    expect(memorySection({ text: "- fact", warnings: [], source: null })).toContain("Learned facts");
    expect(recordSection("")).toBe("");
    expect(extensionsSection({ mcp: [], skills: [] })).toBe("");
    const ext = extensionsSection({ mcp: [{ name: "github", note: "issues and PRs", harnesses: ["claude-code"] }], skills: [{ name: "deploy", description: "ship it", harnesses: ["claude-code", "codex"] }] });
    expect(ext).toContain("- mcp github: issues and PRs (claude-code)");
    expect(ext).toContain("- skill deploy: ship it (claude-code, codex)");
    const p = systemPrompt(targets, { memory: { text: "- tests take 4 min", warnings: [], source: null }, record: "chat: x 1 runs 1 ok", extensions: { mcp: [], skills: [] } });
    expect(p).toContain('"kind": "code-multifile"');
    expect(p).toContain("tests take 4 min");
    expect(p).toContain("chat: x 1 runs 1 ok");
    expect(systemPrompt(targets)).not.toContain("Learned facts");
  });

  it("real work goes to the preferred models; cheap ones only for small, low-risk jobs", () => {
    const p = systemPrompt(targets);
    expect(p).toMatch(/marked "preferred".*most trusted.*real work/s);
    expect(p).not.toContain("Prefer the cheapest model that is clearly enough");
  });

  it("an earlier task's provider block or refusal does not decide a new task", () => {
    const p = systemPrompt(targets);
    expect(p).toMatch(/new task is the user's own request.*blocked by a provider's safety\s+classifier.*not a reason to stop, refuse or pick a different harness or model/s);
    expect(p).toMatch(/never say this task was blocked unless its own step results show it/);
  });

  it("a question for a credential invites the plain value: answers are sealed before anything stores them", () => {
    expect(systemPrompt(targets)).toMatch(/asks for a credential.*type it as is.*seals answers.*never ask for the enc:v1: form/s);
  });
});

describe("Engine: records and memory", () => {
  it("writes a record per finished task, marks user handoffs, appends the summarizer's facts to MEMORY.md, and the router sees both", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-rec-"));
    const memoryPath = join(home, "MEMORY.md");
    const store = new Store({ dbPath: ":memory:", threadsDir: join(home, "threads") });
    const bus = new Bus();
    const router = echoRouter([
      decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, kind: "code-small" }),
      decisionJson({ harness: "claude-code", model: "claude-sonnet-4-6", effort: null, kind: "code-small" }),
      decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, kind: "chat" }),
    ]);
    const summarizer: Summarizer = async (input) => ({ summary: { title: "T", goal: "g", progress: "p", files: [], unresolved: [], decisions: [], facts: input.status === "done" ? ["this repo's tests take four minutes", "password: plaintextsecret"] : [], spoken: "" }, error: null, ms: 1 });
    const engine = new Engine({ store, bus, executors: Object.keys(targets.harnesses).map((h) => echoExecutor(h)), targets, router, quota: () => ({}), approvalTimeoutMs: 200, retryBackoffMs: 1, summarizer, memoryPath, extensionsSummary: () => ({ mcp: [{ name: "github", note: "", harnesses: ["codex"] }], skills: [] }) });
    const a = engine.submit({ task: "small fix", cwd: "/tmp" });
    await engine.idle();
    const [rec] = store.recordsSince(0);
    expect(rec).toMatchObject({ taskId: a.id, kind: "code-small", harness: "codex", model: "gpt-5.5", status: "done", failureKind: null, pinned: false, userHandoff: false });
    const mem = readFileSync(memoryPath, "utf8");
    expect(mem).toContain("- this repo's tests take four minutes (task " + a.id);
    expect(mem).not.toContain("plaintextsecret");
    const b = engine.handoff(a.id)!;
    await engine.idle();
    expect(store.recordsSince(0).find((r) => r.taskId === a.id)!.userHandoff).toBe(true);
    expect(store.recordsSince(0).find((r) => r.taskId === b.id)).toMatchObject({ harness: "claude-code", kind: "code-small" });
    const sys = router.calls[1]!.system;
    expect(sys).toContain("Learned facts");
    expect(sys).toContain("tests take four minutes");
    expect(sys).toContain("code-small: codex/gpt-5.5 1 runs 1 ok");
    expect(sys).toContain("- mcp github (codex)");
    const c = engine.submit({ task: "say hi", cwd: "/tmp", pin: { harness: "codex", model: "gpt-5.5" } });   // pin: kind from the coarse classifier
    await engine.idle();
    expect(store.recordsSince(0).find((r) => r.taskId === c.id)).toMatchObject({ pinned: true, kind: "chat" });   // no decision → classify()
    writeFileSync(memoryPath, "");
  });
});

describe("kept browser logins in the guidance", () => {
  it("the router files a same-site follow-up into its thread; executors check the session before logging in", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    expect(systemPrompt(realTargets())).toMatch(/Browser logins are kept between tasks.*same thread|thread, and its brief should say to check first/s);
    const guide = readFileSync(resolve(import.meta.dirname, "..", "config", "EXECUTOR.md"), "utf8");
    expect(guide).toMatch(/Browser logins are kept\..*check whether you are already signed in.*Never sign out, clear cookies/s);
  });
});

describe("thread assignment guidance (2026-09-24: four follow-ups were filed into four new threads)", () => {
  it("follow-ups and references to earlier findings join the thread; a different cwd is no reason to start a new one", async () => {
    const { threadsSection } = await import("../src/router/prompt.js");
    const text = threadsSection([{ id: "a414b6b6", title: "macOS 长期项目目录定位", cwd: "/w/1", goal: "找长期项目目录", progress: "在 ~/Desktop/WorkSpace", lastTarget: null, lastActivity: Date.now() }]);
    expect(text).toMatch(/follow-up.*next step.*what an earlier task found/s);
    expect(text).toMatch(/minutes after.*same subject.*continues it/s);
    expect(text).toMatch(/working directories\s+differ.*not a reason/s);
  });
});
