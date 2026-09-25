/** The assistant speaks up on its own (assistant-v0 step 3): a task's end with its spoken script, a question or approval
 *  still open after a moment, and a watched task's progress at its interval. Built from the store, no model call. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantLog } from "../src/assistant/log.js";
import { Reporter } from "../src/assistant/reports.js";
import { Bus } from "../src/engine/bus.js";
import { Store } from "../src/engine/store.js";
import type { TaskEventType } from "../src/engine/types.js";

const open: { stop(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.stop(); });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function build(opts: { summaryWaitMs?: number; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-reports-"));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(dir, "threads") });
  const log = new AssistantLog(":memory:", opts.now);
  const bus = new Bus();
  const reporter = new Reporter({ log, store, bus, summaryWaitMs: opts.summaryWaitMs ?? 1000, needsYouGraceMs: 20, tickMs: 60_000, ...(opts.now ? { now: opts.now } : {}) });
  reporter.start();
  open.push({ stop: () => { reporter.stop(); store.close(); log.close(); } });
  const emit = (taskId: string, type: TaskEventType, payload: Record<string, unknown> = {}) => bus.publish(store.appendEvent(taskId, type, payload));
  const notices = () => log.recent(50).filter((m) => m.role === "assistant");
  return { store, log, bus, reporter, emit, notices };
}

describe("assistant reports", () => {
  it("a finished task is reported with its spoken script once the summary is in, under its thread's title", async () => {
    const f = build();
    const thread = f.store.createThread("/w", "整理下载目录");
    const t = f.store.createTask({ task: "整理下载目录", cwd: "/w" });
    f.store.updateTask(t.id, { threadId: thread.id, status: "done", result: "整理好了 42 个文件", speech: "下载目录整理好了，一共四十二个文件。" });
    f.emit(t.id, "done");
    expect(f.notices()).toEqual([]);   // waits for the summary: the script comes with it
    f.emit(t.id, "summary", { ok: true });
    expect(f.notices()).toMatchObject([{ kind: "notice", taskIds: [t.id], text: "「整理下载目录」完成了：下载目录整理好了，一共四十二个文件。" }]);
  });

  it("without a summary the report still goes, after the wait, with what there is", async () => {
    const f = build({ summaryWaitMs: 20 });
    const t = f.store.createTask({ task: "登录 x.com 看通知 enc:v1:" + "T".repeat(40), cwd: "/w" });
    f.store.updateTask(t.id, { status: "failed", error: "gate proxy unreachable" });
    f.emit(t.id, "failed");
    await wait(60);
    expect(f.notices()).toMatchObject([{ kind: "notice", text: "「登录 x.com 看通知 🔒」失败了：gate proxy unreachable" }]);   // no half ciphertext
  });

  it("a cancelled task is not reported, and its watch goes", async () => {
    const f = build({ summaryWaitMs: 20 });
    const t = f.store.createTask({ task: "慢慢跑", cwd: "/w" });
    f.log.setWatch(t.id, 60_000);
    f.store.updateTask(t.id, { status: "cancelled" });
    f.emit(t.id, "cancelled");
    await wait(60);
    expect(f.notices()).toEqual([]);
    expect(f.log.watches()).toEqual([]);
  });

  it("a question still open after the grace is reported; one the supervisor settled at once is not", async () => {
    const f = build();
    const t = f.store.createTask({ task: "填表", cwd: "/w" });
    f.store.updateTask(t.id, { status: "waiting_approval" });
    const settled = f.store.createApproval(t.id, "Bash: ls /tmp", "{}");
    f.emit(t.id, "approval_request", { approvalId: settled.id, kind: "approval" });
    f.store.resolveApproval(settled.id, "allowed");
    const asked = f.store.createApproval(t.id, "验证码是多少？", "{}", "question");
    f.emit(t.id, "approval_request", { approvalId: asked.id, kind: "question" });
    await wait(60);
    expect(f.notices()).toMatchObject([{ kind: "notice", taskIds: [t.id], text: "「填表」需要你回答：验证码是多少？" }]);
  });

  it("a watched task gets a progress line when due, with what it waits for or last said; an ended one drops its watch", () => {
    let now = Date.parse("2026-09-25T10:00:00Z");
    const f = build({ now: () => now });
    const t = f.store.createTask({ task: "跑一遍全部测试", cwd: "/w" });
    f.store.updateTask(t.id, { status: "running" });
    f.store.appendEvent(t.id, "dispatched", { harness: "claude-code", model: "claude-opus-5-5" });
    f.store.appendEvent(t.id, "text", { text: "单元测试过了，正在跑端到端" });
    f.log.setWatch(t.id, 10 * 60_000);
    f.reporter.tick();
    expect(f.notices()).toEqual([]);   // not due yet
    now += 10 * 60_000;
    f.reporter.tick();
    const [line] = f.notices();
    expect(line).toMatchObject({ kind: "progress", taskIds: [t.id] });
    expect(line!.text).toMatch(/^「跑一遍全部测试」还在进行（\d+ 分钟），刚才说：单元测试过了，正在跑端到端$/);
    now += 5 * 60_000;
    f.reporter.tick();
    expect(f.notices()).toHaveLength(1);   // the next one is ten minutes after the last
    f.store.updateTask(t.id, { status: "done" });
    now += 10 * 60_000;
    f.reporter.tick();
    expect(f.notices()).toHaveLength(1);
    expect(f.log.watches()).toEqual([]);
  });

  it("watches survive a restart: they live in the conversation's database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentswitch-watch-")), "assistant.db");
    const first = new AssistantLog(path, () => 1000);
    first.setWatch("t1", 60_000);
    first.close();
    const again = new AssistantLog(path);
    expect(again.watches()).toEqual([{ taskId: "t1", everyMs: 60_000, nextAt: 61_000 }]);
    again.close();
  });
});
