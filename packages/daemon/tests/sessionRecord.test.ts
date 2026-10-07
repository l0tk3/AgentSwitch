/** A session's record for the simple view (docs/simple-view-v0.md §2–§4, 2026-10-07): what was said and each run of work
 *  as its steps, read from the agent's own file; what a run changed; pages; the routes. The files here are written in
 *  a temporary folder: no test reads the user's own sessions. */

import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountSessions } from "../src/api/sessions.js";
import type { ApiDeps } from "../src/api/shared.js";
import { watchRecord } from "../src/api/terminals.js";
import { SessionMonitor, type SessionSources } from "../src/sessions/monitor.js";
import { DIFF_LINES, OUTPUT_CHARS, readChanges, readRecord, recordFromMessages, shortPath, TEXT_CHARS, unifiedHunks, type RecordItem } from "../src/sessions/record.js";
import type { TerminalHost } from "../src/terminals/host.js";

const REPO = "/Users/u/code/site";
const line = (o: unknown) => JSON.stringify(o);
const at = (s: number) => new Date(Date.parse("2026-10-07T02:00:00Z") + s * 1000).toISOString();

/** Claude Code's lines, as it writes them: one block a line, a tool's result in the next user line. */
const c = {
  user: (s: number, text: string | unknown[], more: object = {}) => line({ type: "user", cwd: REPO, timestamp: at(s), message: { role: "user", content: text }, ...more }),
  text: (s: number, text: string, usage: object = {}) => line({ type: "assistant", cwd: REPO, timestamp: at(s), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], usage } }),
  think: (s: number, thinking: string) => line({ type: "assistant", cwd: REPO, timestamp: at(s), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking }] } }),
  tool: (s: number, id: string, name: string, input: object, more: object = {}) => line({ type: "assistant", cwd: REPO, timestamp: at(s), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] }, ...more }),
  result: (s: number, id: string, toolUseResult: unknown, more: object = {}) => line({ type: "user", cwd: REPO, timestamp: at(s), toolUseResult, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...more }] } }),
};

function claudeFile(lines: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-record-")));
  const path = join(dir, "s1.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const turn = [
  line({ type: "permission-mode", permissionMode: "acceptEdits", sessionId: "s1" }),
  c.user(0, "delete 应该标红才对"),
  c.think(1, ""),   // thinking the model kept to itself: nothing to show
  c.think(2, "The delete button uses the system style.\nLook for the shared one."),
  c.tool(3, "t1", "Read", { file_path: `${REPO}/Sources/AgentsView.swift` }),
  c.result(4, "t1", { type: "text", file: {} }),
  c.tool(5, "t2", "Grep", { pattern: "SettingsDeleteButton", path: REPO }),
  c.result(6, "t2", { numFiles: 3 }),
  c.tool(7, "t3", "Bash", { command: "swift build -c release\n  2>&1 | tail -3", description: "Build" }),
  c.result(40, "t3", { stdout: "Compiling…\nBuild complete! (31.20s)\n", stderr: "", interrupted: false }),
  c.tool(41, "t4", "Edit", { file_path: `${REPO}/Sources/AgentsView.swift`, old_string: "a", new_string: "b" }),
  c.result(42, "t4", { filePath: `${REPO}/Sources/AgentsView.swift`, structuredPatch: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [" row {", "-  Button(role: .destructive)", "+  SettingsDeleteButton()", "+    .disabled(busy)", " }"] }] }),
  c.tool(43, "t5", "Write", { file_path: `${REPO}/notes.md`, content: "one\ntwo\n" }),
  c.result(44, "t5", { type: "create", filePath: `${REPO}/notes.md`, content: "one\ntwo\n", structuredPatch: [], originalFile: null }),
  c.tool(45, "t6", "mcp__browser__browser_navigate", { url: "http://127.0.0.1:8765/" }),
  c.result(46, "t6", "Error: page crashed", { is_error: true, content: "Error: page crashed" }),
  c.tool(47, "t7", "TodoWrite", { todos: [{ content: "找出所有用到的地方", status: "completed" }, { content: "删除按钮标红", status: "in_progress", activeForm: "正在把删除按钮标红" }, { content: "重新构建", status: "pending" }] }),
  c.result(48, "t7", { oldTodos: [], newTodos: [] }),
  line({ type: "assistant", isSidechain: true, cwd: REPO, timestamp: at(49), message: { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "Bash", input: { command: "a sub-agent's own" } }] } }),
  // Claude Code writes the level a turn ran at on its lines.
  line({ type: "assistant", cwd: REPO, timestamp: at(72), effort: "xhigh", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "改好了：换成应用里已有的红字删除按钮。" }],
    usage: { input_tokens: 12, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 4000, output_tokens: 300 } } }),
];

const kinds = (items: readonly RecordItem[]) => items.map((it) => it.type);

describe("a Claude Code session's record", () => {
  it("is what was said, and the work between as one run with its steps: what each read, searched, ran, edited", () => {
    const record = readRecord("claude-code", claudeFile(turn))!;
    expect(kinds(record.items)).toEqual(["user", "work", "answer"]);
    const [said, work, answer] = record.items;
    expect(said).toMatchObject({ type: "user", text: "delete 应该标红才对" });
    expect(answer).toMatchObject({ type: "answer", text: "改好了：换成应用里已有的红字删除按钮。" });
    if (work?.type !== "work") throw new Error("no work");
    // From its first step to the answer after it.
    expect(work.secs).toBe(70);
    expect(work.steps).toEqual([
      { kind: "think", text: "The delete button uses the system style." },
      { kind: "read", text: "Sources/AgentsView.swift" },
      { kind: "search", text: "SettingsDeleteButton" },
      { kind: "run", text: "swift build -c release ⏎ 2>&1 | tail -3", out: "Compiling…\nBuild complete! (31.20s)" },
      { kind: "edit", text: "Sources/AgentsView.swift", added: 2, removed: 1 },
      { kind: "write", text: "notes.md", added: 2, removed: 0 },
      { kind: "tool", tool: "browser · navigate", text: "http://127.0.0.1:8765/", failed: true, out: "Error: page crashed" },
      { kind: "todo", text: "正在把删除按钮标红" },
    ]);
    // The session's latest: its own list of tasks, how full its context is, the mode it last named.
    expect(record.plan).toEqual([{ text: "找出所有用到的地方", state: "done" }, { text: "删除按钮标红", state: "doing" }, { text: "重新构建", state: "todo" }]);
    expect(record.usage).toEqual({ model: "claude-opus-5-5", used: 124_012, effort: "xhigh" });
    expect(record.mode).toBe("acceptEdits");
    expect(record.more).toBe(false);
  });

  it("a run of work still going ends at its last result; a message typed meanwhile is queued until it is read", () => {
    const path = claudeFile([
      c.user(0, "跑一下测试"),
      c.tool(1, "t1", "Bash", { command: "npm test" }),
      c.result(9, "t1", { stdout: "ok", stderr: "" }),
      c.tool(10, "t2", "Bash", { command: "npm run build" }),
      line({ type: "queue-operation", operation: "enqueue", content: "顺便把版本号也改了", timestamp: at(12) }),
      line({ type: "queue-operation", operation: "enqueue", content: "<task-notification>done</task-notification>", timestamp: at(13) }),
    ]);
    const open = readRecord("claude-code", path)!;
    expect(kinds(open.items)).toEqual(["user", "work", "user"]);
    expect(open.items[1]).toMatchObject({ secs: 9, steps: [{ kind: "run", text: "npm test", out: "ok" }, { kind: "run", text: "npm run build" }] });
    expect(open.items[2]).toMatchObject({ text: "顺便把版本号也改了", queued: true });

    // Taken in mid-turn: Claude Code writes it as an attachment, with the pictures that came with it.
    appendFileSync(path, [
      line({ type: "queue-operation", operation: "remove", content: "顺便把版本号也改了", reason: "absorbed_mid_turn", timestamp: at(14) }),
      line({ type: "attachment", cwd: REPO, timestamp: at(14), attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, prompt: [{ type: "image", source: {} }, { type: "text", text: "顺便把版本号也改了" }] } }),
      line({ type: "attachment", cwd: REPO, timestamp: at(15), attachment: { type: "queued_command", commandMode: "task-notification", prompt: "<task-notification>x</task-notification>" } }),
      c.text(20, "好，一起改。"),
    ].join("\n") + "\n");
    const read = readRecord("claude-code", path)!;
    expect(kinds(read.items)).toEqual(["user", "work", "user", "answer"]);
    expect(read.items[2]).toEqual({ type: "user", id: read.items[2]!.id, ts: Date.parse(at(14)), text: "顺便把版本号也改了", images: 1 });
    expect(read.rev).not.toBe(open.rev);
  });

  it("leaves out what the harness put in the user's turn, and says when it was interrupted or compacted", () => {
    const record = readRecord("claude-code", claudeFile([
      c.user(0, "<local-command-caveat>ignore</local-command-caveat>", { isMeta: true }),
      c.user(1, "This session is being continued from a previous conversation…", { isCompactSummary: true }),
      line({ type: "system", subtype: "compact_boundary", timestamp: at(1), content: "Conversation compacted" }),
      c.user(2, [{ type: "image", source: {} }]),
      c.tool(3, "t1", "Bash", { command: "sleep 100" }),
      c.user(5, [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
      c.text(6, "第一段。"),
      c.text(7, "第二段。"),
    ]))!;
    expect(record.items.map((it) => (it.type === "work" ? "work" : `${it.type}:${it.text}`))).toEqual(["note:Compacted", "user:", "work", "note:Interrupted", "answer:第一段。\n\n第二段。"]);
    expect(record.items[1]).toMatchObject({ images: 1 });
  });

  it("clips a very long answer and a command's output to its end", () => {
    const record = readRecord("claude-code", claudeFile([
      c.user(0, "go"),
      c.tool(1, "t1", "Bash", { command: "cat big.log" }),
      c.result(2, "t1", { stdout: Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"), stderr: "" }),
      c.text(3, "x".repeat(TEXT_CHARS + 50)),
    ]))!;
    const [, work, answer] = record.items;
    if (work?.type !== "work" || answer?.type !== "answer") throw new Error("shape");
    expect(work.steps[0]!.out!.length).toBeLessThanOrEqual(OUTPUT_CHARS + 1);
    expect(work.steps[0]!.out!.startsWith("…")).toBe(true);
    expect(work.steps[0]!.out!.endsWith("line 399")).toBe(true);
    expect(answer.text.length).toBe(TEXT_CHARS);
    expect(answer.clipped).toBe(true);
  });

  it("pages back: the last items first, then the ones before the cursor, none twice and none lost", () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) lines.push(c.user(i * 10, `问 ${i}`), c.tool(i * 10 + 1, `t${i}`, "Bash", { command: `echo ${i}` }), c.result(i * 10 + 2, `t${i}`, { stdout: String(i), stderr: "" }), c.text(i * 10 + 3, `答 ${i}`));
    const path = claudeFile(lines);
    const last = readRecord("claude-code", path, { limit: 9 })!;
    expect(last.items).toHaveLength(9);
    expect(last.more).toBe(true);
    expect(last.items[0]).toMatchObject({ type: "user", text: "问 9" });
    const before = readRecord("claude-code", path, { limit: 100, before: last.cursor })!;
    expect(before.items).toHaveLength(27);
    expect(before.more).toBe(false);
    expect(before.items[26]).toMatchObject({ type: "answer", text: "答 8" });
    // An earlier page is the record only: the plan, the usage and the mode are the session's latest.
    expect(before.usage).toBeNull();
    const ids = [...before.items, ...last.items].map((it) => it.id);
    expect(new Set(ids).size).toBe(36);
  });
});

describe("what a session changed", () => {
  it("one run of work by its id, and the last turn without one: file by file, hunks in the order they were made", () => {
    const path = claudeFile([...turn, c.user(100, "再把说明也改了"), c.tool(101, "t9", "Edit", { file_path: `${REPO}/README.md` }),
      c.result(102, "t9", { filePath: `${REPO}/README.md`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }] })]);
    const record = readRecord("claude-code", path)!;
    const first = record.items.find((it) => it.type === "work")!;
    expect(readChanges("claude-code", path, { work: first.id })).toEqual([
      { path: "Sources/AgentsView.swift", added: 2, removed: 1, hunks: [{ header: "@@ -10,3 +10,4 @@", lines: [" row {", "-  Button(role: .destructive)", "+  SettingsDeleteButton()", "+    .disabled(busy)", " }"] }] },
      { path: "notes.md", added: 2, removed: 0, hunks: [{ header: "", lines: ["+one", "+two"] }] },
    ]);
    expect(readChanges("claude-code", path)).toEqual([{ path: "README.md", added: 1, removed: 1, hunks: [{ header: "@@ -1,1 +1,1 @@", lines: ["-old", "+new"] }] }]);
    // Not a run of work, not a line's start, past the end.
    expect(readChanges("claude-code", path, { work: record.items[0]!.id })).toBeNull();
    expect(readChanges("claude-code", path, { work: String(Number(first.id) + 3) })).toBeNull();
    expect(readChanges("claude-code", path, { work: "99999999" })).toBeNull();
  });

  it("a very long change is cut, and says so", () => {
    const path = claudeFile([c.user(0, "go"), c.tool(1, "t1", "Write", { file_path: `${REPO}/big.txt` }),
      c.result(2, "t1", { type: "create", filePath: `${REPO}/big.txt`, content: Array.from({ length: DIFF_LINES + 20 }, (_, i) => `l${i}`).join("\n"), structuredPatch: [] })]);
    const [file] = readChanges("claude-code", path)!;
    expect(file).toMatchObject({ path: "big.txt", added: DIFF_LINES + 20, clipped: true });
    expect(file!.hunks[0]!.lines).toHaveLength(DIFF_LINES);
  });

  it("reads a unified diff's hunks and writes paths as the screens do", () => {
    expect(unifiedHunks("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9 +9 @@\n-d\n+e\n")).toEqual([
      { header: "@@ -1,2 +1,2 @@", lines: [" a", "-b", "+c"] }, { header: "@@ -9 +9 @@", lines: ["-d", "+e"] },
    ]);
    expect(shortPath("/Users/u/code/site/src/a.ts", "/Users/u/code/site", "/Users/u")).toBe("src/a.ts");
    expect(shortPath("/Users/u/notes/a.md", "/Users/u/code/site", "/Users/u")).toBe("~/notes/a.md");
    expect(shortPath("/etc/hosts", "/Users/u/code/site", "/Users/u")).toBe("/etc/hosts");
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const API = "/Users/u/code/api";
const x = {
  item: (s: number, item: object, secs = 1) => line({ timestamp: at(s + secs), type: "event_msg", payload: { type: "item_completed", turn_id: "t", started_at_ms: Date.parse(at(s)), completed_at_ms: Date.parse(at(s + secs)), item } }),
};
const rollout = [
  line({ timestamp: at(0), type: "session_meta", payload: { id: "x1", cwd: API, originator: "codex_cli_rs" } }),
  line({ timestamp: at(0), type: "turn_context", payload: { cwd: API, model: "gpt-6-luna", effort: "high", approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } } }),
  x.item(1, { type: "UserMessage", id: "u1", content: [{ type: "text", text: "<environment_context>cwd</environment_context>" }] }),
  x.item(2, { type: "UserMessage", id: "u2", content: [{ type: "text", text: "# Files mentioned by the user:\n\n## a.md: /x/a.md\n\n## My request for Codex:\n把重试次数改成 3" }] }),
  x.item(3, { type: "Reasoning", id: "r1", summary_text: ["**Looking at the retry helper**"], raw_content: [] }),
  x.item(4, { type: "Reasoning", id: "r2", summary_text: [], raw_content: [] }),
  x.item(5, { type: "CommandExecution", id: "c1", command: ["/bin/zsh", "-lc", "sed -n 1,80p src/retry.ts && rg -n retries src"], cwd: API, exit_code: 0, status: "completed", aggregated_output: "…",
    parsed_cmd: [{ type: "read", cmd: "sed -n 1,80p src/retry.ts", name: "retry.ts", path: `${API}/src/retry.ts` }, { type: "search", cmd: "rg -n retries src", query: "retries", path: "src" }] }),
  x.item(6, { type: "AgentMessage", id: "a1", phase: "commentary", content: [{ type: "Text", text: "重试次数写在 `src/retry.ts` 里，我来改。" }] }),
  x.item(8, { type: "FileChange", id: "f1", status: "completed", changes: {
    [`${API}/src/retry.ts`]: { type: "update", unified_diff: "@@ -3,1 +3,1 @@\n-const RETRIES = 5;\n+const RETRIES = 3;\n", move_path: null },
    [`${API}/CHANGES.md`]: { type: "add", content: "retries: 5 → 3\n" },
  } }),
  x.item(9, { type: "CommandExecution", id: "c2", command: ["/bin/zsh", "-lc", "npm test"], cwd: API, exit_code: 1, status: "failed", aggregated_output: "1 failed\n", parsed_cmd: [{ type: "unknown", cmd: "npm test" }] }, 20),
  x.item(30, { type: "McpToolCall", id: "m1", server: "cua_repl", tool: "js", arguments: { code: "…", title: "打开对比页" }, status: "completed" }),
  x.item(31, { type: "Extension", id: "e1", kind: "web.search", query: "node retry backoff", action: { type: "search" } }),
  x.item(32, { type: "Extension", id: "e2", kind: "clock.sleep", durationMs: 2000 }),
  x.item(33, { type: "SubAgentActivity", id: "s1", kind: "started", agent_thread_id: "th", agent_path: "root/reviewer" }),
  line({ timestamp: at(34), type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "改重试次数", status: "completed" }, { step: "跑测试", status: "in_progress" }] }) } }),
  line({ timestamp: at(35), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 51_000 }, model_context_window: 272_000 } } }),
  x.item(36, { type: "AgentMessage", id: "a2", phase: "final_answer", content: [{ type: "Text", text: "改成 3 了，但有一个测试没过。" }] }),
  line({ timestamp: at(40), type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } }),
];

function codexFile(lines: string[]): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-record-"))), "2026", "10", "07");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-2026-10-07T10-00-00-x1.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("a Codex session's record", () => {
  it("is its thread's items: what a command was for when it only looked, each file of a change, the plan and the usage", () => {
    const path = codexFile(rollout);
    const record = readRecord("codex", path, { cwd: API })!;
    expect(kinds(record.items)).toEqual(["user", "work", "answer", "work", "answer", "note"]);
    expect(record.items[0]).toMatchObject({ text: "把重试次数改成 3" });
    expect(record.items[1]).toMatchObject({ steps: [{ kind: "think", text: "Looking at the retry helper" }, { kind: "read", text: "src/retry.ts" }, { kind: "search", text: "retries · src" }] });
    // From its first step's start (0:08) to the end of the answer after it (0:37).
    expect(record.items[3]).toMatchObject({ secs: 29, steps: [
      { kind: "edit", text: "src/retry.ts", added: 1, removed: 1 },
      { kind: "write", text: "CHANGES.md", added: 1, removed: 0 },
      { kind: "run", text: "npm test", out: "1 failed", failed: true },
      { kind: "tool", tool: "cua_repl · js", text: "打开对比页" },
      { kind: "web", text: "node retry backoff" },
      { kind: "agent", text: "reviewer" },
    ] });
    expect(record.items[5]).toMatchObject({ type: "note", text: "Interrupted" });
    expect(record.plan).toEqual([{ text: "改重试次数", state: "done" }, { text: "跑测试", state: "doing" }]);
    expect(record.usage).toEqual({ model: "gpt-6-luna", effort: "high", used: 51_000, window: 272_000 });
    expect(record.mode).toBe("on-request");
    expect(readChanges("codex", path, { cwd: API })).toEqual([
      { path: "src/retry.ts", added: 1, removed: 1, hunks: [{ header: "@@ -3,1 +3,1 @@", lines: ["-const RETRIES = 5;", "+const RETRIES = 3;"] }] },
      { path: "CHANGES.md", added: 1, removed: 0, hunks: [{ header: "", lines: ["+retries: 5 → 3"] }] },
    ]);
    // By the run's id, with only the session's folder to go by (the lines before it are not read again).
    expect(readChanges("codex", path, { work: record.items[3]!.id, cwd: API })!.map((f) => f.path)).toEqual(["src/retry.ts", "CHANGES.md"]);
  });

  it("an older rollout carries no items: no record from the file, and the coarse one stands in", () => {
    const path = codexFile([
      line({ timestamp: at(0), type: "session_meta", payload: { id: "x1", cwd: API } }),
      line({ timestamp: at(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "跑测试" }] } }),
      line({ timestamp: at(2), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["npm", "test"] }) } }),
    ]);
    expect(readRecord("codex", path)).toBeNull();
    const coarse = recordFromMessages([{ role: "user", text: "跑测试", ts: 1 }, { role: "tool", tool: "shell", text: "npm test", ts: 2 }, { role: "tool", tool: "cua", text: "click", ts: 3 }, { role: "assistant", text: "通过了。", ts: 4 }], "r1");
    expect(kinds(coarse.items)).toEqual(["user", "work", "answer"]);
    expect(coarse.items[1]).toMatchObject({ steps: [{ kind: "run", text: "npm test" }, { kind: "tool", tool: "cua", text: "click" }] });
    expect(coarse).toMatchObject({ rev: "r1", more: false, plan: [], usage: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

function monitored() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-record-")));
  const claudeDir = join(root, "claude", "-Users-u-code-site");
  mkdirSync(claudeDir, { recursive: true });
  const claudePath = join(claudeDir, "c1.jsonl");
  writeFileSync(claudePath, turn.join("\n") + "\n");
  const piDir = join(root, "pi", "--Users-u-code-site--");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, "2026-10-07T02-00-00-000Z_p1.jsonl"), [
    line({ type: "session", version: 3, id: "p1", timestamp: at(0), cwd: REPO }),
    line({ type: "message", id: "a", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "看看目录" }] } }),
    line({ type: "message", id: "b", timestamp: at(2), message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "ls" } }, { type: "text", text: "有三个文件。" }] } }),
  ].join("\n") + "\n");
  const sources: SessionSources = { claudeProjects: join(root, "claude"), codexSessions: join(root, "codex"), piSessions: join(root, "pi"), opencodeDb: join(root, "none.db"), excluded: [] };
  const monitor = new SessionMonitor(sources, () => Date.parse(at(100)));
  const app = new Hono();
  mountSessions(app, { sessions: monitor } as unknown as ApiDeps);
  return { monitor, app, claudePath };
}

describe("the record over the API", () => {
  it("serves a session's record and its changes; unchanged, the record is not sent again", async () => {
    const { app } = monitored();
    const res = await app.request("/sessions/claude-code/c1/record");
    expect(res.status).toBe(200);
    const body = await res.json() as { session: { id: string; cwd: string }; items: RecordItem[]; rev: string; plan: unknown[] };
    expect(body.session).toMatchObject({ id: "c1", cwd: REPO });
    expect(kinds(body.items)).toEqual(["user", "work", "answer"]);
    expect(body.plan).toHaveLength(3);
    const again = await app.request("/sessions/claude-code/c1/record", { headers: { "if-none-match": res.headers.get("etag")! } });
    expect(again.status).toBe(304);

    const work = body.items[1]!.id;
    const changed = await (await app.request(`/sessions/claude-code/c1/changes?work=${work}`)).json() as { files: { path: string }[] };
    expect(changed.files.map((f) => f.path)).toEqual(["Sources/AgentsView.swift", "notes.md"]);
    expect((await (await app.request("/sessions/claude-code/c1/changes")).json() as { files: unknown[] }).files).toHaveLength(2);

    expect((await app.request("/sessions/claude-code/c1/record?before=abc")).status).toBe(400);
    expect((await app.request("/sessions/claude-code/c1/changes?work=../x")).status).toBe(400);
    expect((await app.request("/sessions/claude-code/nope/record")).status).toBe(404);
    expect((await app.request("/sessions/vim/c1/record")).status).toBe(404);
  });

  it("an agent read coarsely still has a record (one line per tool), and no changes", async () => {
    const { app } = monitored();
    const body = await (await app.request("/sessions/pi/p1/record")).json() as { items: RecordItem[] };
    expect(kinds(body.items)).toEqual(["user", "work", "answer"]);
    expect(body.items[1]).toMatchObject({ steps: [{ kind: "run", text: "ls" }] });
    expect((await app.request("/sessions/pi/p1/changes")).status).toBe(404);
  });
});

describe("the session of a terminal of ours, wherever it runs (2026-10-07: a terminal under /tmp had no record)", () => {
  it("is read by its id though the list leaves its folder out; anyone else's unlisted session is not", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-record-")));
    const scratch = "/private/tmp/scratch/project";
    const dir = join(root, "claude", "-private-tmp-scratch-project");
    mkdirSync(dir, { recursive: true });
    const lines = turn.map((l) => l.split(REPO).join(scratch));
    writeFileSync(join(dir, "s9.jsonl"), lines.join("\n") + "\n");
    const sources: SessionSources = { claudeProjects: join(root, "claude"), codexSessions: join(root, "codex"), opencodeDb: join(root, "none.db"), excluded: ["/private/tmp"] };
    const monitor = new SessionMonitor(sources, () => Date.parse(at(100)));
    expect(monitor.list()).toEqual([]);
    expect(monitor.record("claude-code", "s9")).toBeNull();
    const own = monitor.record("claude-code", "s9", {}, true)!;
    expect(own.session).toMatchObject({ id: "s9", cwd: scratch });
    expect(kinds(own.record.items)).toEqual(["user", "work", "answer"]);
    expect(monitor.changes("claude-code", "s9", undefined, true)!.map((f) => f.path)).toEqual(["Sources/AgentsView.swift", "notes.md"]);
    expect(monitor.changes("claude-code", "s9")).toBeNull();
    expect(monitor.locate("claude-code", "s9")).toBe(join(dir, "s9.jsonl"));
    expect(monitor.locate("claude-code", "../s9")).toBeNull();
    expect(monitor.locate("claude-code", "nope")).toBeNull();

    // Over the API: the session of a terminal the service runs, and no other.
    const app = new Hono();
    let running: { agentSessionId: string | null }[] = [];
    mountSessions(app, { sessions: monitor, terminals: { host: { list: () => running } } } as unknown as ApiDeps);
    expect((await app.request("/sessions/claude-code/s9/record")).status).toBe(404);
    running = [{ agentSessionId: "s9" }];
    expect((await app.request("/sessions/claude-code/s9/record")).status).toBe(200);
    expect((await app.request("/sessions/claude-code/s9/changes")).status).toBe(200);
  });
});

describe("a terminal's record, watched", () => {
  it("says the record's version at once and again each time the agent writes; a terminal with no session yet waits for one", async () => {
    const { monitor, claudePath } = monitored();
    let session: string | null = null;
    const host = { get: () => ({ harness: "claude-code", agentSessionId: session }) } as unknown as TerminalHost;
    const revs: string[] = [];
    const stop = watchRecord(host, monitor, "t1", (rev) => revs.push(rev), 10);
    try {
      await new Promise((r) => setTimeout(r, 40));
      expect(revs).toEqual([]);
      session = "c1";
      await until(() => revs.length === 1);
      appendFileSync(claudePath, c.user(200, "再来") + "\n");
      await until(() => revs.length === 2);
      expect(revs[1]).not.toBe(revs[0]);
      await new Promise((r) => setTimeout(r, 40));
      expect(revs).toHaveLength(2);
    } finally { stop(); }
  });
});

async function until(ok: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
