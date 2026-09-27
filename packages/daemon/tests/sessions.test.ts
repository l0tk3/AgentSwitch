/** Watching the Mac's own coding sessions (docs/control-v0.md §3, 2026-09-27): Claude Code, Codex and OpenCode, read-only,
 *  newest first, the user's own only; the assistant sees folder, title and when, with anything credential-like masked. */

import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountSessions } from "../src/api/sessions.js";
import type { ApiDeps } from "../src/api/shared.js";
import { RATE_LIMIT_PROBE_PROMPT } from "../src/core/probes.js";
import { folderLines, sessionsNear } from "../src/sessions/folders.js";
import { SessionMonitor, type SessionSources } from "../src/sessions/monitor.js";
import { maskSecrets, type SessionSummary } from "../src/sessions/types.js";

const NOW = Date.parse("2026-09-27T10:00:00Z");
const line = (o: unknown) => JSON.stringify(o);

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-sessions-")));
  const data = join(root, "AgentSwitch");
  const repo = "/Users/u/code/site";
  const claudeDir = join(root, "claude", "-Users-u-code-site");
  mkdirSync(claudeDir, { recursive: true });
  const claudeFile = join(claudeDir, "c1.jsonl");
  writeFileSync(claudeFile, [
    line({ type: "permission-mode", permissionMode: "default", sessionId: "c1" }),
    line({ type: "user", isMeta: true, cwd: repo, message: { role: "user", content: "<local-command-caveat>ignore</local-command-caveat>" }, timestamp: "2026-09-27T09:58:00Z" }),
    line({ type: "user", cwd: repo, gitBranch: "main", message: { role: "user", content: "修一下登录页 key=sk-ant-abcdefghijklmnop" }, timestamp: "2026-09-27T09:58:10Z" }),
    line({ type: "assistant", cwd: repo, message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "先看表单。" }, { type: "tool_use", name: "Read", input: { file_path: "src/login.ts" } }] }, timestamp: "2026-09-27T09:59:30Z" }),
    line({ type: "assistant", isSidechain: true, cwd: repo, message: { role: "assistant", content: [{ type: "text", text: "sub-agent chatter" }] }, timestamp: "2026-09-27T09:59:40Z" }),
  ].join("\n") + "\n");
  const probeDir = join(root, "claude", "-tmp-probe");
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(join(probeDir, "p1.jsonl"), line({ type: "user", cwd: "/tmp/probe", message: { role: "user", content: "probe" }, timestamp: "2026-09-27T09:59:00Z" }) + "\n");
  const codexDir = join(root, "codex", "2026", "09", "26");
  mkdirSync(codexDir, { recursive: true });
  const codexFile = join(codexDir, "rollout-2026-09-26T20-00-00-x1.jsonl");
  writeFileSync(codexFile, [
    line({ timestamp: "2026-09-26T12:00:00Z", type: "session_meta", payload: { id: "x1", cwd: "/Users/u/code/api", originator: "Codex Desktop", source: "vscode" } }),
    line({ timestamp: "2026-09-26T12:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } }),
    line({ timestamp: "2026-09-26T12:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# Files mentioned by the user:\n\n## a.md: /x/a.md\n\n## My request:\n跑一下测试\n" }] } }),
    line({ timestamp: "2026-09-26T12:00:03Z", type: "turn_context", payload: { model: "gpt-6-luna" } }),
    line({ timestamp: "2026-09-26T12:00:04Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["npm", "test"] }) } }),
    line({ timestamp: "2026-09-26T12:01:00Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "测试全部通过。" }] } }),
  ].join("\n") + "\n");
  utimesSync(codexFile, new Date("2026-09-26T12:01:00Z"), new Date("2026-09-26T12:01:00Z"));
  utimesSync(claudeFile, new Date("2026-09-27T09:59:40Z"), new Date("2026-09-27T09:59:40Z"));
  const dbPath = join(root, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, model TEXT, time_updated INTEGER)");
  db.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)").run("o1", null, "/Users/u/notes", "整理笔记", JSON.stringify({ id: "deepseek-flash" }), Date.parse("2026-09-25T08:00:00Z"));
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)").run("o2", "o1", "/Users/u/notes", "child", null, Date.parse("2026-09-25T08:00:01Z"));
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)").run("o3", null, join(data, "work", "abc"), "AgentSwitch's own", null, Date.parse("2026-09-27T09:00:00Z"));
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)").run("m1", "o1", "user", 1, 1, JSON.stringify({ text: "把笔记按月分好\n\nUser environment context (maintained by the user…)" }));
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)").run("m2", "o1", "assistant", 2, 2, JSON.stringify({ content: [{ type: "text", text: "分好了，一共 12 个月。" }] }));
  db.close();
  const sources: SessionSources = { claudeProjects: join(root, "claude"), codexSessions: join(root, "codex"), opencodeDb: dbPath, excluded: ["/tmp/", data] };
  return { sources, repo, data };
}

describe("the Mac's coding sessions", () => {
  it("lists the user's own sessions from all three, newest first, typed prompts as titles, probes and our own left out", () => {
    const { sources, repo } = fixture();
    const list = new SessionMonitor(sources, () => NOW).list();
    expect(list.map((s) => [s.harness, s.id, s.cwd])).toEqual([
      ["claude-code", "c1", repo], ["codex", "x1", "/Users/u/code/api"], ["opencode", "o1", "/Users/u/notes"],
    ]);
    expect(list[0]).toMatchObject({ title: "修一下登录页 key=sk-ant-abcdefghijklmnop", lastText: "先看表单。", active: true, branch: "main", model: "claude-opus-5-5" });
    expect(list[1]).toMatchObject({ title: "跑一下测试", lastText: "测试全部通过。", active: false, origin: "desktop", model: "gpt-6-luna" });
    expect(list[2]).toMatchObject({ title: "整理笔记", lastText: "分好了，一共 12 个月。", model: "deepseek-flash" });
  });

  it("opens one session: prompts, replies and one line per tool call, sub-agents and injected context left out", () => {
    const { sources } = fixture();
    const m = new SessionMonitor(sources, () => NOW);
    expect(m.read("claude-code", "c1")!.messages.map((x) => [x.role, x.tool ?? "", x.text])).toEqual([
      ["user", "", "修一下登录页 key=sk-ant-abcdefghijklmnop"], ["assistant", "", "先看表单。"], ["tool", "Read", "src/login.ts"],
    ]);
    expect(m.read("codex", "x1")!.messages.map((x) => [x.role, x.text])).toEqual([["user", "跑一下测试"], ["tool", "npm test"], ["assistant", "测试全部通过。"]]);
    expect(m.read("opencode", "o1")!.messages.map((x) => [x.role, x.text])).toEqual([["user", "把笔记按月分好"], ["assistant", "分好了，一共 12 个月。"]]);
    expect(m.read("opencode", "o3")).toBeNull();
  });

  it("the routes serve the list and a session", async () => {
    const { sources } = fixture();
    const monitor = new SessionMonitor(sources, () => NOW);
    const app = new Hono();
    mountSessions(app, { sessions: monitor } as unknown as ApiDeps);
    expect(((await (await app.request("/sessions?limit=2")).json()) as { sessions: unknown[] }).sessions).toHaveLength(2);
    expect((await app.request("/sessions/codex/x1")).status).toBe(200);
    expect((await app.request("/sessions/vim/x1")).status).toBe(404);
  });

  it("a folder that is itself excluded (e.g. /private/tmp) is left out, not only folders under it", () => {
    const { sources } = fixture();
    const dir = join(sources.claudeProjects, "-private-tmp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "t1.jsonl"), line({ type: "user", cwd: "/private/tmp", message: { role: "user", content: "scratch" }, timestamp: "2026-09-27T09:59:50Z" }) + "\n");
    const list = new SessionMonitor({ ...sources, excluded: [...sources.excluded, "/private/tmp/"] }, () => NOW).list();
    expect(list.map((s) => s.cwd)).not.toContain("/private/tmp");
  });

  it("AgentSwitch's own quota probes are not the user's sessions, wherever they ran", () => {
    const { sources, repo } = fixture();
    const dir = join(sources.claudeProjects, "-Users-u-code-site");
    writeFileSync(join(dir, "probe.jsonl"), line({ type: "user", cwd: repo, message: { role: "user", content: RATE_LIMIT_PROBE_PROMPT }, timestamp: "2026-09-27T09:59:00Z" }) + "\n");
    expect(new SessionMonitor(sources, () => NOW).list().map((x) => x.id)).not.toContain("probe");
  });

  it("AgentSwitch's own OpenCode calls and executor sessions share the user's database but are not listed", () => {
    const { sources } = fixture();
    const dbPath = join(dirname(sources.opencodeDb), "with-agent.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, model TEXT, agent TEXT, time_updated INTEGER)");
    db.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
    const add = db.prepare("INSERT INTO session_v2 VALUES (?, NULL, ?, ?, NULL, ?, ?)");
    add.run("mine", "/Users/u/notes", "整理笔记", "build", 3);
    add.run("mine-old", "/Users/u/notes", "更早的", null, 2);
    add.run("router-call", "/Users/u/code/site", "路由", "dispatcher", 4);
    add.run("sealer-call", "/Users/u/code/site", "加密", "sealer", 5);
    add.run("executor-run", "/Users/u/code/site", "AgentSwitch 派的任务", "build", 6);
    add.run("in-work-root", "/Users/u/AgentSwitch/2026-09-27-0123abcd", "问个问题", "build", 7);
    db.close();
    const m = new SessionMonitor({ ...sources, opencodeDb: dbPath, ownIds: () => new Set(["executor-run"]), ownFolders: () => ["/Users/u/AgentSwitch"] }, () => NOW);
    expect(m.list().filter((x) => x.harness === "opencode").map((x) => x.id)).toEqual(["mine", "mine-old"]);
  });

  it("our own and temporary sessions do not use up the scan: older sessions of the user's still show", () => {
    const { sources, repo } = fixture();
    for (let i = 0; i < 5; i++) {
      const dir = join(sources.claudeProjects, `-tmp-probe-${i}`);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `p${i}.jsonl`);
      writeFileSync(file, line({ type: "user", cwd: `/tmp/probe-${i}`, message: { role: "user", content: "probe" }, timestamp: "2026-09-27T09:59:59Z" }) + "\n");
      utimesSync(file, new Date("2026-09-27T09:59:59Z"), new Date("2026-09-27T09:59:59Z"));   // newer than the user's session
    }
    const list = new SessionMonitor({ ...sources, scanFiles: 2 }, () => NOW).list();
    expect(list.map((s) => s.cwd)).toContain(repo);
  });
});

describe("what the models see of the sessions", () => {
  const s = (harness: SessionSummary["harness"], id: string, cwd: string, title: string, minutesAgo: number): SessionSummary =>
    ({ harness, id, cwd, title, lastText: "", updatedAt: NOW - minutesAgo * 60_000, active: minutesAgo < 1 });
  const sessions = [
    s("claude-code", "c1", "/Users/u/code/site", "修一下登录页 key=sk-ant-abcdefghijklmnop", 0),
    s("codex", "x1", "/Users/u/code/site", "跑一下测试", 1320),
    s("claude-code", "c2", "/Users/u/code/site", "older one", 2000),
    s("opencode", "o1", "/Users/u/notes", "整理笔记", 3000),
    s("codex", "x2", "/Users/u/code/site/packages/api", "api 的接口", 60),
  ];

  it("the assistant sees one line per folder: when, which executors and each one's latest title, secrets masked", () => {
    const lines = folderLines(sessions, NOW);
    expect(lines.split("\n")).toEqual([
      "- /Users/u/code/site · running now · Claude Code 2 (latest just now: \"修一下登录页 key=🔒\"), Codex 1 (latest 22 h ago: \"跑一下测试\")",
      "- /Users/u/code/site/packages/api · 1 h ago · Codex 1 (latest 1 h ago: \"api 的接口\")",
      "- /Users/u/notes · 2 d ago · OpenCode 1 (latest 2 d ago: \"整理笔记\")",
    ]);
    expect(folderLines([], NOW)).toBe("(none)");
    expect(folderLines(sessions, NOW, 1).split("\n")).toHaveLength(1);
  });

  it("the router sees the user's sessions in the task's folder, its subfolders and the folder it sits in", () => {
    expect(sessionsNear(sessions, "/Users/u/code/site", NOW)).toBe([
      "- /Users/u/code/site · running now · Claude Code 2 (latest just now: \"修一下登录页 key=🔒\"), Codex 1 (latest 22 h ago: \"跑一下测试\")",
      "- /Users/u/code/site/packages/api · 1 h ago · Codex 1 (latest 1 h ago: \"api 的接口\")",
    ].join("\n"));
    expect(sessionsNear(sessions, "/Users/u/code/site/packages/api/src", NOW)).toContain("/Users/u/code/site ·");
    expect(sessionsNear(sessions, "/Users/u/code/sitemap", NOW)).toBeNull();
    expect(sessionsNear(sessions, "/Users/u/elsewhere", NOW)).toBeNull();
  });

  it("the home folder is not offered as a place to work, nor counted as the folder a project sits in", () => {
    const home = [...sessions, s("claude-code", "h1", "/Users/u", "你好", 10)];
    expect(folderLines(home, NOW, 20, ["/Users/u"])).not.toContain("- /Users/u ·");
    expect(sessionsNear(home, "/Users/u/notes", NOW, ["/Users/u"])).not.toContain("- /Users/u ·");
  });

  it("paths stay readable while tokens, email addresses and user@host are masked", () => {
    expect(maskSecrets("用 maute.tarantino\\@gmail.com 登录，再 ssh root@38.47.102.122")).toBe("用 🔒 登录，再 ssh 🔒");
    expect(maskSecrets("/Users/l07k3/Downloads/917/baseline.xlsx 首页的公式")).toBe("/Users/l07k3/Downloads/917/baseline.xlsx 首页的公式");
    expect(maskSecrets("token Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA== end")).toBe("token 🔒 end");
    expect(maskSecrets("ab3/Kx9Qm2Lp8Zt4Wv6Yr1Ns5Hd7Fg0Jc2Bn4Mx8Pq")).toBe("🔒");
  });
});
