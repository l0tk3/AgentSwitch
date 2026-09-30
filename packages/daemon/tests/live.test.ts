/** The Mac's Live Activity (assistant-v0 §4): the rows it shows — tasks in progress and terminals waiting, the waiting
 *  first — what each waits for in a form the card can answer, and the tasks that ended in the last minute. */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveSnapshot, plainLine, splitAction, toolLine } from "../src/api/live.js";
import { encodeEvidence } from "../src/core/questions.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { LEGEND_HEADER } from "../src/secrets/sealer.js";
import type { TerminalHost, TerminalInfo, TurnEnd } from "../src/terminals/host.js";

const open: Store[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); });

function build() {
  let now = Date.parse("2026-09-29T10:00:00Z");
  const store = new Store({ dbPath: ":memory:", threadsDir: join(mkdtempSync(join(tmpdir(), "agentswitch-live-")), "threads"), now: () => now });
  open.push(store);
  return { store, at: (ms: number) => { now = ms; }, now: () => now };
}

function terminal(over: Partial<TerminalInfo>): TerminalInfo {
  return {
    id: "t1", harness: "claude-code", cwd: join(homedir(), "Projects/web"), model: null, mode: "manual", name: "fix-login", customName: false,
    title: "", status: "working", pid: 1, cols: 80, rows: 24, createdAt: 0, lastOutputAt: 0, exitCode: null, agentSessionId: null,
    resumedFrom: null, forked: false, hooks: true, permissions: [], activity: null, subagents: [], statusSince: 0, seq: 0, ...over,
  };
}
const host = (list: TerminalInfo[], turns: Record<string, TurnEnd> = {}) =>
  ({ list: () => list, lastTurn: (id: string) => turns[id] ?? null }) as unknown as TerminalHost;
const event = (type: TaskEvent["type"], payload: Record<string, unknown>): TaskEvent => ({ taskId: "x", seq: 1, ts: 0, type, payload });

describe("live snapshot", () => {
  it("lists tasks in progress and terminals waiting, the waiting first, then the newest, with counts", () => {
    const f = build();
    const t0 = Date.parse("2026-09-29T10:00:00Z");
    const old = f.store.createTask({ task: "修 AgentSwitch 的 bug", cwd: "/w" });
    f.store.updateTask(old.id, { status: "running", model: "claude-opus-5-5" });
    f.store.appendEvent(old.id, "dispatched", { model: "claude-opus-5-5" });
    f.store.appendEvent(old.id, "tool_call", { tool: "Bash", input: { command: "/bin/zsh -lc 'npx vitest run'" } });
    f.store.appendEvent(old.id, "tool_result", { ok: true, output: "passed" });
    f.at(t0 + 5_000);
    const fresh = f.store.createTask({ task: "总结一下这周的提交", cwd: "/w" });
    f.store.updateTask(fresh.id, { status: "routing" });
    f.at(t0 + 9_000);
    const asks = f.store.createTask({ task: "登录财务平台", cwd: join(homedir(), "work") });
    f.store.updateTask(asks.id, { status: "waiting_approval", model: "claude-sonnet-4-6" });
    const approval = f.store.createApproval(asks.id, "Bash: rm -rf build", "{}");
    f.store.updateTask(f.store.createTask({ task: "早就做完了", cwd: "/w" }).id, { status: "done" });

    const waiting = terminal({ id: "k1", status: "waiting", permissions: [{ id: "p1", tool: "Bash", summary: "Bash: npm test", input: { command: "npm test" }, at: t0 + 2_000 }] });
    const snap = liveSnapshot(f.store, host([waiting, terminal({ id: "k2", status: "idle" }), terminal({ id: "k3", status: "exited", permissions: waiting.permissions })]), t0 + 10_000);

    expect(snap.rows.map((r) => r.id)).toEqual([asks.id, "k1", fresh.id, old.id]);
    // Two terminals open (waiting, idle); the exited one is not: the Mac stays awake while one is open.
    expect(snap).toMatchObject({ running: 2, waiting: 2, open: 2 });
    expect(snap.rows[0]).toMatchObject({
      kind: "task", title: "登录财务平台", step: "Bash: rm -rf build", model: "Sonnet 4.6", needsYou: true,
      ask: { kind: "approval", id: approval.id, tool: "Bash", target: "rm -rf build", where: "~/work" },
    });
    expect(snap.rows[1]).toMatchObject({
      kind: "terminal", title: "fix-login", step: "Bash: npm test", model: "Claude Code", agent: "claude-code", startedAt: t0 + 2_000, needsYou: true,
      ask: { kind: "permission", id: "p1", tool: "Bash", target: "npm test", where: "~/Projects/web" },
    });
    expect(snap.rows[2]).toMatchObject({ title: "总结一下这周的提交", step: "选择模型", model: null, needsYou: false, ask: null });
    expect(snap.rows[3]).toMatchObject({ step: "运行 npx vitest run", model: "Opus 5.5" });
  });

  it("an approval of a tool by name alone is said as people say it, with what it works on from its input", () => {
    const f = build();
    const t = f.store.createTask({ task: "登录 x.com 发一条动态", cwd: "/w" });
    f.store.updateTask(t.id, { status: "waiting_approval" });
    f.store.createApproval(t.id, "mcp__playwright__browser_click", JSON.stringify({ element: "发布按钮", ref: "e42" }));
    expect(liveSnapshot(f.store, undefined, f.now()).rows[0]?.ask).toMatchObject({ kind: "approval", tool: "浏览器 · 点击", target: "发布按钮", where: "/w" });
  });

  it("a question with options is answerable on the card; several questions, a free answer or a secret one is not", () => {
    const f = build();
    const ask = (questions: object[]) => {
      const t = f.store.createTask({ task: "清理旧构建", cwd: "/w" });
      f.store.updateTask(t.id, { status: "waiting_approval" });
      const evidence = encodeEvidence({ source: "executor", questions: questions.map((q, i) => ({ id: `q${i}`, header: "", text: "要删掉吗？", options: [], multi: false, secret: false, ...q })) });
      f.store.createApproval(t.id, "要删掉吗？", evidence, "question");
      return t.id;
    };
    const one = ask([{ options: [{ label: "删掉", description: "" }, { label: "保留", description: "" }] }]);
    const free = ask([{}]);
    const secret = ask([{ options: [{ label: "a", description: "" }], secret: true }]);
    const multi = ask([{ options: [{ label: "a", description: "" }], multi: true }]);
    const rows = new Map(liveSnapshot(f.store, undefined, f.now()).rows.map((r) => [r.id, r]));
    expect(rows.get(one)).toMatchObject({ step: "要删掉吗？", ask: { kind: "question", questionId: "q0", text: "要删掉吗？", options: ["删掉", "保留"], answerable: true } });
    for (const id of [free, secret, multi]) expect(rows.get(id)?.ask).toMatchObject({ kind: "question", answerable: false });
  });

  it("a thread's first task goes by the thread's title, a later one by its own request; ciphertexts are locks", () => {
    const f = build();
    const thread = f.store.createThread("/w", "整理下载目录");
    const first = f.store.createTask({ task: "整理下载目录，重复的放一起", cwd: "/w", threadId: thread.id });
    f.at(f.now() + 1_000);
    const later = f.store.createTask({ task: `把结果发给我 enc:v1:${"T".repeat(40)}\n\n${LEGEND_HEADER}\n- password`, cwd: "/w", threadId: thread.id });
    for (const t of [first, later]) f.store.updateTask(t.id, { status: "running" });
    const titles = new Map(liveSnapshot(f.store, undefined, f.now()).rows.map((r) => [r.id, r.title]));
    expect(titles.get(first.id)).toBe("整理下载目录");
    expect(titles.get(later.id)).toBe("把结果发给我 🔒");
  });

  it("a terminal at work is a row in progress too (2026-09-30): what it is using, since this turn began", () => {
    const f = build();
    const t0 = f.now();
    const t = f.store.createTask({ task: "整理下载目录", cwd: "/w" });
    f.store.updateTask(t.id, { status: "running" });
    const snap = liveSnapshot(f.store, host([
      terminal({ id: "k1", name: "fix-login", status: "working", statusSince: t0 + 3_000, activity: { tool: "Bash", target: "/bin/zsh -lc 'npm test'" } }),
      terminal({ id: "k2", name: "api-refactor", harness: "codex", status: "working", statusSince: t0 - 60_000, activity: null }),
      terminal({ id: "k3", status: "idle", activity: { tool: "Read", target: "/w/a.ts" } }),
    ]), t0 + 5_000);
    expect(snap).toMatchObject({ running: 3, waiting: 0 });
    expect(snap.rows.map((r) => r.id)).toEqual(["k1", t.id, "k2"]);
    expect(snap.rows[0]).toMatchObject({ kind: "terminal", title: "fix-login", step: "运行 npm test", model: "Claude Code", agent: "claude-code", startedAt: t0 + 3_000, needsYou: false, ask: null });
    expect(snap.rows[2]).toMatchObject({ step: "进行中", model: "Codex", agent: "codex" });
  });

  it("a waiting terminal without a request (a form on its screen) asks to be opened", () => {
    const f = build();
    const snap = liveSnapshot(f.store, host([terminal({ status: "waiting", lastOutputAt: 42 })]), f.now());
    expect(snap.rows).toMatchObject([{ kind: "terminal", step: "等你处理", startedAt: 42, ask: null, needsYou: true }]);
  });

  it("tasks that ended in the last minute, the latest first, with what they came to; not a cancelled one, not an old one opened again", () => {
    const f = build();
    const t0 = f.now();
    const end = (task: string, status: "done" | "failed" | "cancelled", patch: Record<string, string>) => {
      const t = f.store.createTask({ task, cwd: "/w" });
      f.store.updateTask(t.id, { status, ...patch });
      if (status !== "cancelled") f.store.appendEvent(t.id, status, {});
      return t.id;
    };
    const old = end("很早以前", "done", { result: "ok" });
    f.at(t0 + 30_000);
    const done = end("整理下载目录", "done", { result: "**42** files, see https://x.example", spoken: "下载目录整理好了，一共四十二个文件。" });
    f.at(t0 + 40_000);
    const failed = end("登录财务平台", "failed", { error: "gate proxy unreachable" });
    end("不要了", "cancelled", {});
    f.at(t0 + 70_000);
    f.store.updateTask(old, { rating: 1 });   // touched again: updated, but it ended 70 s ago

    const snap = liveSnapshot(f.store, undefined, t0 + 70_000);
    expect(snap.rows).toEqual([]);
    expect(snap.ended).toEqual([
      { kind: "task", id: failed, taskId: failed, title: "登录财务平台", line: "gate proxy unreachable", ok: false, at: t0 + 40_000 },
      { kind: "task", id: done, taskId: done, title: "整理下载目录", line: "下载目录整理好了，一共四十二个文件。", ok: true, at: t0 + 30_000 },
    ]);
    expect(liveSnapshot(f.store, undefined, t0 + 95_000).ended.map((e) => e.taskId)).toEqual([failed]);
  });

  // 2026-09-30, user: 遇到报错、任务完成之类的也要提示；不然报错静默消失都不知道.
  it("a terminal's turn is a result too: its last answer when done, what went wrong when not", () => {
    const f = build();
    const t0 = Date.parse("2026-09-30T10:00:00Z");
    const term = (id: string, name: string): TerminalInfo => ({ id, name, harness: "claude-code", cwd: "/w", status: "idle", permissions: [] }) as unknown as TerminalInfo;
    const terminals = host([term("a1", "修登录超时"), term("b2", "整理日志"), term("c3", "旧的")], {
      a1: { at: t0 + 20_000, ok: true, line: "改好了：连接池上限从 2 调到 20，测试全部通过。" },
      b2: { at: t0 + 30_000, ok: false, line: "rate_limit: You have hit your limit" },
      c3: { at: t0 - 90_000, ok: false, line: "进程退出（代码 1）" },
    });
    const snap = liveSnapshot(f.store, terminals, t0 + 40_000);
    expect(snap.rows).toEqual([]);
    expect(snap.ended).toEqual([
      { kind: "terminal", id: "b2", title: "整理日志", line: "rate_limit: You have hit your limit", ok: false, at: t0 + 30_000 },
      { kind: "terminal", id: "a1", title: "修登录超时", line: "改好了：连接池上限从 2 调到 20，测试全部通过。", ok: true, at: t0 + 20_000 },
    ]);
  });
});

describe("live lines", () => {
  it("says a tool call as people say it", () => {
    expect(toolLine({ tool: "commandExecution", command: "/bin/zsh -lc 'git log -n 3'" })).toBe("运行 git log -n 3");
    expect(toolLine({ tool: "mcp__playwright__browser_click", input: { element: "发布按钮" } })).toBe("浏览器 · 点击 发布按钮");
    expect(toolLine({ tool: "Read", input: { file_path: "/w/a.ts" } })).toBe("读取 /w/a.ts");
    expect(toolLine({ tool: "mcp__secret-gate__secret_fill" })).toBe("填入密文");
    expect(toolLine({ tool: "linear.create_issue" })).toBe("linear · create_issue");
  });

  it("says the steps that mean something and skips the rest", () => {
    expect(plainLine(event("text", { text: "先看一下目录结构\n然后……" }))).toBe("先看一下目录结构");
    expect(plainLine(event("dispatched", { model: "deepseek/deepseek-flash" }))).toBe("已交给 DeepSeek Flash");
    expect(plainLine(event("routed", { verdict: { model: "claude-opus-5-5" } }))).toBe("已选定 Opus 5.5");
    expect(plainLine(event("step", { action: "dispatch", n: 2, target: { model: "claude-opus-5-5" } }))).toBe("第 2 步：交由 Opus 5.5 执行");
    expect(plainLine(event("tool_call", { tool: "Bash", denied: true }))).toBeNull();
    expect(plainLine(event("tool_result", { ok: true }))).toBeNull();
  });

  it("splits an approval into its tool and what it works on", () => {
    expect(splitAction("Bash: npm test")).toEqual({ tool: "Bash", target: "npm test" });
    expect(splitAction("item/commandExecution/requestApproval: rm -rf build")).toEqual({ tool: "Bash", target: "rm -rf build" });
    expect(splitAction("applyPatchApproval: file changes")).toEqual({ tool: "Edit", target: "file changes" });
    expect(splitAction("Edit")).toEqual({ tool: "Edit", target: "" });
  });
});
