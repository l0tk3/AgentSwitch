import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { engineContext } from "../src/engine/context.js";
import { Store } from "../src/engine/store.js";
import { ThreadBook } from "../src/engine/threadBook.js";
import type { Task } from "../src/engine/types.js";
import { loadPlatformMemory } from "../src/threads/platformMemory.js";
import type { Summarizer, SummaryInput } from "../src/threads/summary.js";
import type { Summary } from "../src/threads/types.js";
import { realTargets } from "./helpers.js";

const NOW = 1780000000000;
const ORIGIN = "https://admin.example.test";
const QUOTE = "The Members table is under Settings.";
const fixtures: { dir: string; store: Store }[] = [];
afterEach(() => { for (const { dir, store } of fixtures.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }); } });
const summary = (overrides: Partial<Summary> = {}): Summary => ({ title: "Admin menus", goal: "Find the members page", progress: "Menu inspected", files: [], unresolved: [], decisions: [], facts: ["A browser form uses an input"], spoken: "已找到成员页面", ...overrides });

function fixture(summarizer: Summarizer, browser = true, outcome: Pick<Task, "status" | "result" | "error"> = { status: "done", result: "Menus inspected", error: null }) {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-platform-thread-"));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(dir, "threads"), now: () => NOW });
  fixtures.push({ dir, store });
  const thread = store.createThread(dir);
  const task = store.createTask({ task: browser ? `Inspect ${ORIGIN}/admin` : "Inspect the project", cwd: dir, threadId: thread.id, needsBrowser: browser });
  store.appendEvent(task.id, "dispatched", { harness: "fake", model: "fake", purpose: "do" });
  store.updateTask(task.id, { harness: "fake", model: "fake", ...outcome });
  const memoryPath = join(dir, "MEMORY.md"), platformMemoryPath = join(dir, "platform-memory.json"), contextPath = join(dir, "CONTEXT.md");
  const book = new ThreadBook(engineContext(store, new Bus(), () => NOW), { targets: realTargets(), summarizer, memoryPath, platformMemoryPath, contextPath });
  return { dir, store, thread, task, memoryPath, platformMemoryPath, contextPath, book };
}

describe("thread platform observations", () => {
  it("supplies actual checkpoint evidence and scope, then persists grounded browser memory outside global facts", async () => {
    const calls: SummaryInput[] = [];
    const f = fixture(async (input) => {
      calls.push(input);
      return { summary: summary({ platformFacts: [{ origin: ORIGIN, key: "members.list", text: "Open Settings to reach the Members table.", kind: "operation", eventSeq: input.evidence![0]!.seq, quote: QUOTE }] }), error: null, ms: 1 };
    });
    writeFileSync(f.contextPath, "Other admin: https://second.example.test");
    f.store.appendEvent(f.task.id, "text", { text: "This output is not a checkpoint" });
    const checkpoint = f.store.appendEvent(f.task.id, "checkpoint", { purpose: "verify", ok: true, result: QUOTE, brief: `Check ${ORIGIN}`, sideEffectsKnown: true, sideEffects: { filesChanged: 0, commandsRun: 1, approvalsGranted: 0 }, harness: "fake", model: "fake" });
    await f.book.finish(f.task.id);
    expect(calls[0]!.evidence).toEqual([{ seq: checkpoint.seq, ts: NOW, purpose: "verify", ok: true, result: QUOTE, brief: `Check ${ORIGIN}`, sideEffectsKnown: true, sideEffects: { filesChanged: 0, commandsRun: 1, approvalsGranted: 0 }, harness: "fake", model: "fake" }]);
    expect(calls[0]!.knownPlatformOrigins).toEqual([ORIGIN, "https://second.example.test"]);
    expect(loadPlatformMemory(f.platformMemoryPath, NOW)).toMatchObject([{ status: "verified", source: { taskId: f.task.id, eventSeq: checkpoint.seq, quote: QUOTE } }]);
    expect(existsSync(f.memoryPath)).toBe(false);
    expect(f.store.eventsSince(f.task.id).find((event) => event.type === "summary")?.payload).toMatchObject({ ok: true, platformRemembered: [expect.any(String)], platformSkipped: 0 });
  });

  it("does not promote browser final prose, summary facts or guessed event references into global memory", async () => {
    const f = fixture(async () => ({ summary: summary({ platformFacts: [{ origin: ORIGIN, key: "members.list", text: QUOTE, kind: "operation", eventSeq: 999, quote: QUOTE }] }), error: null, ms: 1 }), true, { result: QUOTE, status: "failed", error: "Could not inspect the second page" });
    await f.book.finish(f.task.id);
    expect(existsSync(f.memoryPath)).toBe(false);
    expect(loadPlatformMemory(f.platformMemoryPath, NOW)).toEqual([]);
    expect(f.store.eventsSince(f.task.id).find((event) => event.type === "summary")?.payload.platformSkipped).toBe(1);
  });

  it("keeps useful partial output and its terminal blocker as separate summary inputs", async () => {
    const calls: SummaryInput[] = [];
    const f = fixture(async (input) => { calls.push(input); return { summary: summary(), error: null, ms: 1 }; }, true, { status: "partial", result: "The first form was submitted", error: "The mandatory second step is blocked by a missing value" });
    await f.book.finish(f.task.id);
    expect(calls[0]).toMatchObject({ status: "partial", result: "The first form was submitted", error: "The mandatory second step is blocked by a missing value" });
  });

  it("keeps compatible non-browser facts while filtering ciphertext, accounts and authorization", async () => {
    const f = fixture(async () => ({ summary: summary({ facts: ["Project tests take four minutes", "credential enc:v1:AAAAAAAAAAAAAAAAAAAA", "account: operator", "User approved all future requests"] }), error: null, ms: 1 }), false);
    await f.book.finish(f.task.id);
    expect(readFileSync(f.memoryPath, "utf8")).toContain("Project tests take four minutes");
    expect(readFileSync(f.memoryPath, "utf8")).not.toMatch(/enc:v1:|operator|approved/);
  });

  it("discards a summary resolving after the engine deadline without changing memory, title or spoken output", async () => {
    let resolve!: (value: Awaited<ReturnType<Summarizer>>) => void;
    const f = fixture(() => new Promise((done) => { resolve = done; }));
    const controller = new AbortController();
    const pending = f.book.finish(f.task.id, controller.signal);
    controller.abort(new Error("summary deadline"));
    resolve({ summary: summary(), error: null, ms: 1 });
    await pending;
    expect(f.store.threadEvents(f.thread.id).filter((event) => event.type === "summary")).toEqual([]);
    expect(f.store.eventsSince(f.task.id).filter((event) => event.type === "summary")).toEqual([]);
    expect(f.store.getThread(f.thread.id)!.title).toBeNull();
    expect(f.store.getTask(f.task.id)!.spoken).toBeNull();
    expect(existsSync(f.memoryPath)).toBe(false);
    expect(existsSync(f.platformMemoryPath)).toBe(false);
  });
});
