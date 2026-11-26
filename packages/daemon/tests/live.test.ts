/** The Mac's Live Activity: the rows it shows — terminals at work and waiting, the waiting first — what each waits for
 *  in a form the card can answer, and the turns that ended in the last minute. */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveSnapshot, toolPhrase, toolWord } from "../src/api/live.js";
import type { TerminalHost, TerminalInfo, TurnEnd } from "../src/terminals/host.js";

function terminal(over: Partial<TerminalInfo>): TerminalInfo {
  return {
    id: "t1", harness: "claude-code", cwd: join(homedir(), "Projects/web"), workdir: join(homedir(), "Projects/web"), model: null, modelNow: null, modeNow: null, suggestion: null, meter: null, sets: true, daybreak: null, effort: null, mode: "manual", name: "fix-login", customName: false,
    title: "", status: "working", pid: 1, cols: 80, rows: 24, createdAt: 0, lastOutputAt: 0, exitCode: null, agentSessionId: null,
    resumedFrom: null, forked: false, hooks: true, permissions: [], activity: null, progress: null, subagents: [], statusSince: 0, sent: [], choices: null, notices: [], profile: null, device: null, seq: 0, ...over,
  };
}
const host = (list: TerminalInfo[], turns: Record<string, TurnEnd> = {}) =>
  ({ list: () => list, lastTurn: (id: string) => turns[id] ?? null }) as unknown as TerminalHost;

describe("live snapshot", () => {
  it("lists terminals at work and waiting, the waiting first, then the newest, with counts", () => {
    const t0 = Date.parse("2026-09-29T10:00:00Z");
    const waiting = terminal({ id: "k1", status: "waiting", permissions: [{ id: "p1", tool: "Bash", summary: "Bash: npm test", input: { command: "npm test" }, at: t0 + 2_000 }] });
    const snap = liveSnapshot(host([terminal({ id: "k0", status: "working", statusSince: t0 + 9_000 }), waiting, terminal({ id: "k2", status: "idle" }), terminal({ id: "k3", status: "exited", permissions: waiting.permissions })]), t0 + 10_000);

    expect(snap.rows.map((r) => r.id)).toEqual(["k1", "k0"]);
    // Three terminals open (at work, waiting, idle); the exited one is not: the Mac stays awake while one is open.
    expect(snap).toMatchObject({ running: 1, waiting: 1, open: 3, ended: [], now: t0 + 10_000 });
    expect(snap.rows[0]).toMatchObject({
      kind: "terminal", title: "fix-login", step: "Bash: npm test", model: "Claude Code", agent: "claude-code", startedAt: t0 + 2_000, needsYou: true,
      ask: { kind: "permission", id: "p1", tool: "Bash", target: "npm test", where: "~/Projects/web" },
    });
    // No terminals at all: the same keys, empty (the apps decode them).
    expect(liveSnapshot(undefined, 5)).toEqual({ rows: [], running: 0, waiting: 0, ended: [], open: 0, now: 5 });
  });

  it("a terminal at work is a row in progress (2026-09-30): what it is using, since this turn began; a ciphertext is a lock", () => {
    const t0 = Date.parse("2026-09-29T10:00:00Z");
    const snap = liveSnapshot(host([
      terminal({ id: "k1", name: "fix-login", status: "working", statusSince: t0 + 3_000, activity: { tool: "Bash", target: "/bin/zsh -lc 'npm test'" } }),
      terminal({ id: "k2", name: "api-refactor", harness: "codex", status: "working", statusSince: t0 - 60_000, activity: null }),
      terminal({ id: "k3", status: "idle", activity: { tool: "Read", target: "/w/a.ts" } }),
      terminal({ id: "k4", status: "working", statusSince: t0 - 90_000, activity: { tool: "Bash", target: `echo enc:v1:${"A".repeat(40)}` } }),
    ]), t0 + 5_000);
    expect(snap).toMatchObject({ running: 3, waiting: 0 });
    expect(snap.rows.map((r) => r.id)).toEqual(["k1", "k2", "k4"]);
    expect(snap.rows[0]).toMatchObject({ kind: "terminal", title: "fix-login", step: "运行 npm test", model: "Claude Code", agent: "claude-code", startedAt: t0 + 3_000, needsYou: false, ask: null });
    expect(snap.rows[1]).toMatchObject({ step: "进行中", model: "Codex", agent: "codex" });
    expect(snap.rows[2]).toMatchObject({ step: "运行 echo 🔒" });
  });

  it("a waiting terminal without a request (a form on its screen) asks to be opened", () => {
    const snap = liveSnapshot(host([terminal({ status: "waiting", lastOutputAt: 42 })]), 100);
    expect(snap.rows).toMatchObject([{ kind: "terminal", step: "等你处理", startedAt: 42, ask: null, needsYou: true }]);
  });

  it("a terminal's question (AskUserQuestion) is said as the question, and opens the terminal: no allow / deny (2026-10-01)", () => {
    const questions = [{ question: "日期格式化用哪个库？", header: "Library", multiSelect: false, options: [{ label: "date-fns", description: "" }, { label: "Luxon", description: "" }] }];
    const ask = { id: "p1", tool: "AskUserQuestion", summary: "日期格式化用哪个库？", input: { questions }, at: 7, questions };
    const snap = liveSnapshot(host([terminal({ status: "waiting", permissions: [ask] })]), 100);
    expect(snap.rows).toMatchObject([{ kind: "terminal", step: "日期格式化用哪个库？", needsYou: true,
      ask: { kind: "question", id: "p1", questionId: "", text: "日期格式化用哪个库？", options: ["date-fns", "Luxon"], answerable: false } }]);
  });

  // 2026-09-30, user: 遇到报错、任务完成之类的也要提示；不然报错静默消失都不知道.
  it("a terminal's turn is a result too: its last answer when done, what went wrong when not", () => {
    const t0 = Date.parse("2026-09-30T10:00:00Z");
    const term = (id: string, name: string): TerminalInfo => ({ id, name, harness: "claude-code", cwd: "/w", status: "idle", permissions: [] }) as unknown as TerminalInfo;
    const terminals = host([term("a1", "修登录超时"), term("b2", "整理日志"), term("c3", "旧的")], {
      a1: { at: t0 + 20_000, ok: true, line: "改好了：连接池上限从 2 调到 20，测试全部通过。" },
      b2: { at: t0 + 30_000, ok: false, line: "rate_limit: You have hit your limit" },
      c3: { at: t0 - 90_000, ok: false, line: "进程退出（代码 1）" },
    });
    const snap = liveSnapshot(terminals, t0 + 40_000);
    expect(snap.rows).toEqual([]);
    expect(snap.ended).toEqual([
      { kind: "terminal", id: "b2", title: "整理日志", line: "rate_limit: You have hit your limit", ok: false, at: t0 + 30_000 },
      { kind: "terminal", id: "a1", title: "修登录超时", line: "改好了：连接池上限从 2 调到 20，测试全部通过。", ok: true, at: t0 + 20_000 },
    ]);
  });
});

describe("live lines", () => {
  it("says a tool and what it works on as people say it", () => {
    expect(toolPhrase("Bash", "/bin/zsh -lc 'git log -n 3'")).toBe("运行 git log -n 3");
    expect(toolPhrase("mcp__playwright__browser_click", "发布按钮")).toBe("浏览器 · 点击 发布按钮");
    expect(toolPhrase("Read", "/w/a.ts")).toBe("读取 /w/a.ts");
    expect(toolPhrase("mcp__secret-gate__secret_fill", "")).toBe("填入密文");
    expect(toolPhrase("linear.create_issue", "")).toBe("linear · create_issue");
  });

  it("says in one word what each is doing, as the phone's compact island does (the menu bar's capsule, 2026-10-03)", () => {
    expect(["Bash", "commandExecution", "MultiEdit", "Grep", "WebFetch", "Task", "TodoWrite", "AskUserQuestion"].map(toolWord))
      .toEqual(["Run", "Run", "Edit", "Search", "Web", "Agents", "Plan", "Answer"]);
    expect(toolWord("mcp__playwright__browser_click")).toBe("Web");
    expect(toolWord("browser_navigate")).toBe("Web");
    expect(toolWord("mcp__secret-gate__secret_fill")).toBe("Sealed");
    expect(toolWord("Compact")).toBe("Compact");   // not a tool: a terminal whose agent compacts its context
    expect(toolPhrase("Compact", "")).toBe("压缩上下文");
    expect(toolWord("linear.create_issue")).toBe("Tool");

    const question = [{ question: "用哪个库？", header: "", multiSelect: false, options: [] }];
    const snap = liveSnapshot(host([
      terminal({ id: "k1", status: "working", activity: { tool: "Edit", target: "/w/a.ts" } }),
      terminal({ id: "k2", status: "working", activity: null }),
      terminal({ id: "k3", status: "waiting", permissions: [{ id: "p1", tool: "Bash", summary: "Bash: npm test", input: { command: "npm test" }, at: 1 }] }),
      terminal({ id: "k4", status: "waiting", permissions: [{ id: "p2", tool: "AskUserQuestion", summary: "用哪个库？", input: { questions: question }, at: 2, questions: question }] }),
    ]), 100);
    const doing = new Map(snap.rows.map((r) => [r.id, r.doing]));
    expect(["k1", "k2", "k3", "k4"].map((id) => doing.get(id))).toEqual(["Edit", "Think", "Allow?", "Answer"]);
  });
});
