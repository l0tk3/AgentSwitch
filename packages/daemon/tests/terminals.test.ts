/** AgentSwitch's terminals (docs/terminal-v0.md): a fake agent in a real pseudo-terminal, the host's screen and replay,
 *  and the whole path over real HTTP — start, stream, reply, a permission request through the real hook command
 *  answered from the API, audit, delete. No model is called. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { remoteAllowed } from "../src/remote/routes.js";
import { markRemote } from "../src/core/caller.js";
import { folderFiles, matchFiles } from "../src/terminals/files.js";
import { answerText, askQuestions, checkPicks, cleanTitle, meaningfulTitle, permissionSummary, piTool, safeCut, TerminalHost, terminalName, type Launcher, type TerminalEvent, compactingOnScreen, workingOnScreen, choicesOnScreen, printedSince, commandRows, inputEmpty, screenRows, modeOnScreen, suggestionOnScreen, type ScreenRow } from "../src/terminals/host.js";
import { DEFAULT_STYLE, parseItermFont, styleFromItermProfile } from "../src/terminals/style.js";
import { keySequence, replyBytes } from "../src/terminals/keys.js";
import type { Sealer } from "../src/secrets/sealer.js";
import { agentLauncher, claudeHookSettings, CODEX_ATTENTION, HOOK_SCRIPT, withoutParentSession } from "../src/terminals/launch.js";
import { deleteTranscript } from "../src/terminals/transcripts.js";
import { elsewhereCheck, type ElsewhereCheck, type Proc } from "../src/terminals/elsewhere.js";
import { TARGETS_PATH } from "./helpers.js";
import { holdsReply } from "../src/api/terminals.js";
import type { RecordItem } from "../src/sessions/record.js";

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

const fakeLauncher = (url: () => string, hooks: boolean): Launcher => (req) => ({
  file: process.execPath,
  args: [FAKE],
  env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: url(), AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken },
  hooks,
});

/** Waits on something that has to be asked for (`until` takes a plain predicate: a promise would always pass). */
async function untilAsked(get: () => Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await get())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function until<T>(get: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const text = (events: TerminalEvent[]): string => events.map((e) => (e.type === "snapshot" || e.type === "output" ? e.data : "")).join("");

describe("terminal host", () => {
  it("follows the program's screen and mouse modes for the wheel", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", false) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir(), cols: 80, rows: 20 });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    await until(() => text(events).includes("fake agent ready"));
    expect(host.keyContext(info.id)).toMatchObject({ mouse: "none", sgrMouse: false, alternate: false });
    host.write(info.id, "fullscreen\r");
    await until(() => text(events).includes("fullscreen on"));
    expect(host.keyContext(info.id)).toMatchObject({ mouse: "any", sgrMouse: true, alternate: true, cols: 80, rows: 20 });
    expect(keySequence("wheel-up", host.keyContext(info.id))).toBe("\x1b[<64;41;11M");
    // A screen attaching now (the desktop window opening, or switching to this terminal) is put in the same modes,
    // the mouse's SGR reporting included (the serializer alone drops it).
    const late: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => late.push(e));
    expect(late[0]?.type).toBe("snapshot");
    expect(text(late)).toContain("\x1b[?1003h");
    expect(text(late)).toContain("\x1b[?1006h");
    host.write(info.id, "normal\r");
    await until(() => text(events).includes("normal again"));
    expect(host.keyContext(info.id)).toMatchObject({ mouse: "none", sgrMouse: false, alternate: false });
    const after: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => after.push(e));
    expect(text(after)).not.toContain("\x1b[?1006h");
  });

  it("follows the kitty keyboard protocol for Shift+Enter: CSI 13;2u while it is on, a line feed otherwise", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", false) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir(), cols: 80, rows: 20 });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    await until(() => text(events).includes("fake agent ready"));
    expect(keySequence("shift-enter", host.keyContext(info.id))).toBe("\n");
    host.write(info.id, "kitty\r");
    await until(() => text(events).includes("kitty on"));
    expect(host.keyContext(info.id).kittyKeys).toBe(true);
    expect(keySequence("shift-enter", host.keyContext(info.id))).toBe("\x1b[13;2u");
    // A screen attaching now learns it from the snapshot (the Mac's native screen encodes its keys by it).
    const late: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => late.push(e));
    expect(text(late)).toContain("\x1b[>7u");
    host.write(info.id, "nokitty\r");
    await until(() => text(events).includes("kitty off"));
    expect(keySequence("shift-enter", host.keyContext(info.id))).toBe("\n");
  });

  it("runs a program in a pseudo-terminal: output, title, replies, status by activity, replay, snapshot, exit", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", false), idleAfterMs: 150 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir(), cols: 80, rows: 20 });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    await until(() => text(events).includes("fake agent ready"));
    await until(() => host.get(info.id)!.title === "fake agent");
    expect(host.get(info.id)!.name).toBe("fake agent");
    expect(events).toContainEqual({ type: "name", name: "fake agent" });
    expect(host.rename(info.id, "  my   work ").name).toBe("my work");
    expect(host.rename(info.id, "")).toMatchObject({ name: "fake agent", customName: false });

    // A reply answered at once (an echo, a redraw for what was sent) is not work; output going on is.
    await until(() => host.get(info.id)!.status === "idle");   // its start-up output was its own
    const sent = events.length;
    host.write(info.id, replyBytes("hello there", host.bracketedPaste(info.id), true));
    await until(() => text(events).includes("got: hello there"));
    expect(events.slice(sent).some((e) => e.type === "status" && e.status === "working")).toBe(false);
    host.write(info.id, "\x1b[<35;10;5M\r");   // a mouse move over a screen that tracks it (the fake reads lines)
    host.resize(info.id, 81, 20);
    await new Promise((r) => setTimeout(r, 200));
    expect(host.get(info.id)!.status).toBe("idle");
    host.write(info.id, "work\r");
    await until(() => host.get(info.id)!.status === "working");
    await until(() => text(events).includes("work done"));
    await until(() => host.get(info.id)!.status === "idle");

    // A screen that saw everything up to `seq` gets only what came after; a new one gets a snapshot first.
    const seq = host.get(info.id)!.seq;
    host.write(info.id, "again\r");
    await until(() => host.get(info.id)!.seq > seq && text(events).includes("got: again"));
    const replay: TerminalEvent[] = [];
    host.subscribe(info.id, seq, (e) => replay.push(e))();
    expect(replay[0]?.type).toBe("output");
    expect(text(replay)).toContain("got: again");
    expect(text(replay)).not.toContain("hello there");
    await new Promise((r) => setTimeout(r, 50));   // the headless terminal parses asynchronously
    const late: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => late.push(e))();
    expect(late[0]?.type).toBe("snapshot");
    expect(text(late)).toContain("got: hello there");

    host.resize(info.id, 100, 30);
    expect(host.get(info.id)).toMatchObject({ cols: 100, rows: 30 });

    host.write(info.id, "exit\r");
    await until(() => events.find((e) => e.type === "exit"));
    expect(host.get(info.id)).toMatchObject({ status: "exited", exitCode: 3 });
    expect(() => host.write(info.id, "x")).toThrow(/ended/);

    host.remove(info.id);
    expect(events.at(-1)).toEqual({ type: "removed" });
    expect(host.get(info.id)).toBeNull();
  });

  it("waits while Codex says something on its screen waits for you (its notification: an app's form is no hook)", async () => {
    for (const hooks of [false, true]) {
      let token = "";
      const launcher: Launcher = (req) => { token = req.hookToken; return fakeLauncher(() => "http://127.0.0.1:9", hooks)(req); };
      const host = new TerminalHost({ launcher, idleAfterMs: 150 });
      closers.push(() => host.closeAll());
      const info = await host.spawn({ harness: "codex", cwd: tmpdir() });
      await until(() => host.get(info.id)!.title === "fake agent");
      host.write(info.id, "form\r");
      await until(() => host.get(info.id)!.status === "waiting");
      await new Promise((r) => setTimeout(r, 400));   // it redraws and blinks while it waits, the idle time runs out: still waiting
      expect(host.get(info.id)).toMatchObject({ status: "waiting", title: "查看进程 | Codex" });   // the marker is not in the name
      if (hooks) await host.hook(info.id, token, { event: "PostToolUse", payload: { tool_name: "mcp__computer_use__open", tool_input: {} } });
      else host.write(info.id, "answered\r");
      await until(() => host.get(info.id)!.status === "working");
      if (!hooks) await until(() => host.get(info.id)!.status === "idle");
      else host.write(info.id, "answered\r");
    }
  });

  it("a permission request whose hook goes away (answered in the terminal) leaves the screens", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    const gone = new AbortController();
    const answer = host.hook(info.id, token, { event: "PermissionRequest", payload: { tool_name: "Write", tool_input: { file_path: "/tmp/x" } } }, gone.signal);
    expect(host.get(info.id)).toMatchObject({ status: "waiting", permissions: [{ tool: "Write", summary: "Write: /tmp/x" }] });
    gone.abort();
    expect(await answer).toBeNull();
    expect(host.get(info.id)).toMatchObject({ status: "working", permissions: [] });
    expect(events.some((e) => e.type === "permission_resolved" && e.decision === null)).toBe(true);
  });

  it("a turn-end notice from another thread of the same Codex is not this terminal's, once its hooks have named its session", async () => {
    // Seen 2026-10-07 on Codex 0.162 with a real login: beside the thread its TUI shows it runs an ephemeral helper
    // with no record, whose own `notify` named itself — the terminal then followed a session that has no file and
    // was at rest in the middle of its turn.
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const hook = (event: string, payload: Record<string, unknown>) => host.hook(info.id, token, { event, payload });
    await hook("SessionStart", { session_id: "thread-main", transcript_path: "/x/rollout-thread-main.jsonl" });
    await hook("UserPromptSubmit", { session_id: "thread-main", prompt: "go" });
    expect(host.get(info.id)).toMatchObject({ status: "working", agentSessionId: "thread-main" });
    await hook("CodexNotify", { type: "agent-turn-complete", "thread-id": "thread-helper", "last-assistant-message": "noted" });
    expect(host.get(info.id)).toMatchObject({ status: "working", agentSessionId: "thread-main" });
    // Its own thread's notice still ends the turn.
    await hook("CodexNotify", { type: "agent-turn-complete", "thread-id": "thread-main", "last-assistant-message": "done" });
    expect(host.get(info.id)).toMatchObject({ status: "idle", agentSessionId: "thread-main" });
    // Without the hooks the notice is all there is: followed, as before.
    const plain = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", false) });
    closers.push(() => plain.closeAll());
    const bare = await plain.spawn({ harness: "codex", cwd: tmpdir() });
    const bareToken = (plain as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(bare.id)!.hookToken;
    await plain.hook(bare.id, bareToken, { event: "CodexNotify", payload: { type: "agent-turn-complete", "thread-id": "thread-a" } });
    await plain.hook(bare.id, bareToken, { event: "CodexNotify", payload: { type: "agent-turn-complete", "thread-id": "thread-b" } });
    expect(plain.get(bare.id)!.agentSessionId).toBe("thread-b");
  });

  it("follows Claude Code's sub-agents: named by what each was sent to do, what it does now, gone when it stops (2026-09-30)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const hook = (event: string, payload: Record<string, unknown>) => host.hook(info.id, token, { event, payload });
    await hook("PreToolUse", { tool_name: "Agent", tool_input: { description: "查连接池", subagent_type: "Explore", prompt: "…" } });
    await hook("PreToolUse", { tool_name: "Agent", tool_input: { description: "审查改动", subagent_type: "code-reviewer", prompt: "…" } });
    // They start in any order: each takes the call of its kind.
    await hook("SubagentStart", { agent_id: "a1", agent_type: "code-reviewer" });
    await hook("SubagentStart", { agent_id: "a2", agent_type: "Explore" });
    await hook("PreToolUse", { agent_id: "a1", agent_type: "code-reviewer", tool_name: "Bash", tool_input: { command: "git diff" } });
    expect(host.get(info.id)!.subagents).toMatchObject([
      { id: "a1", type: "code-reviewer", name: "审查改动", activity: { tool: "Bash", target: "git diff" } },
      { id: "a2", type: "Explore", name: "查连接池", activity: null },
    ]);
    await hook("SubagentStop", { agent_id: "a1", agent_type: "code-reviewer" });
    // One not seen starting (the service came up after) is taken in by its kind at its first tool call.
    await hook("PreToolUse", { agent_id: "a3", agent_type: "general-purpose", tool_name: "Read", tool_input: { file_path: "/w/pool.ts" } });
    expect(host.get(info.id)!.subagents.map((a) => [a.id, a.name])).toEqual([["a2", "查连接池"], ["a3", "general-purpose"]]);
    await hook("Stop", { last_assistant_message: "好了" });
    expect(host.get(info.id)!.subagents).toEqual([]);
    // Where the agent works now comes with its hook calls (the window's title): it follows a `cd`.
    expect(host.get(info.id)!.workdir).toBe(info.cwd);
    await hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "cd docs" }, cwd: "/w/AgentSwitch/docs" });
    expect(host.get(info.id)!.workdir).toBe("/w/AgentSwitch/docs");
    await hook("PostToolUse", { tool_name: "Bash", tool_input: {}, cwd: "relative/not/taken" });
    expect(host.get(info.id)!.workdir).toBe("/w/AgentSwitch/docs");
    expect(claudeHookSettings("hook").hooks).toMatchObject({ SubagentStart: expect.any(Array), SubagentStop: expect.any(Array) });
  });

  it("a screen that (re)connects gets every request waiting, whole: one answered while it was away is gone", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const ask = (file: string) => host.hook(info.id, token, { event: "PermissionRequest", payload: { tool_name: "Write", tool_input: { file_path: file } } });
    void ask("/tmp/a");
    void ask("/tmp/b");
    const [first, second] = host.get(info.id)!.permissions;
    // The phone saw both, went to the background; the Mac answered the first.
    expect(host.decide(info.id, first!.id, "allow")).toBe(true);
    const back: TerminalEvent[] = [];
    host.subscribe(info.id, host.get(info.id)!.seq, (e) => back.push(e))();
    const whole = back.find((e) => e.type === "permissions");
    expect(whole).toEqual({ type: "permissions", requests: [second] });
    expect(host.decide(info.id, first!.id, "deny")).toBe(false);   // what the phone's stale card would get: 404
  });

  // 2026-10-01, user: 如果agent给一个选择题也会出这个allow deny，这样不太对吧？能不能hook的更精细，直接用这个框来选agent给的选项.
  it("an AskUserQuestion is a question to answer, not allow / deny: its answers go back in updatedInput as Claude Code's dialog gives them", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const input = { questions: [
      { question: "日期格式化用哪个库？", header: "Library", multiSelect: false, options: [{ label: "date-fns", description: "体积小" }, { label: "Luxon", description: "自带时区" }] },
      { question: "发布前跑哪些检查？", header: "Checks", multiSelect: true, options: [{ label: "单元测试", description: "" }, { label: "Lint, 格式", description: "" }] },
    ], metadata: { source: "x" } };
    const ask = () => host.hook(info.id, token, { event: "PermissionRequest", payload: { tool_name: "AskUserQuestion", tool_input: input } });
    const first = ask();
    const [request] = host.get(info.id)!.permissions;
    expect(request).toMatchObject({ tool: "AskUserQuestion", summary: "日期格式化用哪个库？ · 发布前跑哪些检查？", questions: [
      { question: "日期格式化用哪个库？", header: "Library", multiSelect: false, options: [{ label: "date-fns", description: "体积小" }, { label: "Luxon", description: "自带时区" }] },
      { question: "发布前跑哪些检查？", header: "Checks", multiSelect: true },
    ] });
    // An allow alone answers nothing (Claude Code drops it and its dialog waits): refused, the request stays.
    expect(() => host.decide(info.id, request!.id, "allow")).toThrow(/提问/);
    expect(() => host.decide(info.id, request!.id, "allow", { "日期格式化用哪个库？": { labels: ["Moment"] } })).toThrow(/not an option/);
    expect(() => host.decide(info.id, request!.id, "allow", { "日期格式化用哪个库？": { labels: ["date-fns"], other: "都行" } })).toThrow(/one answer only/);
    expect(() => host.decide(info.id, request!.id, "allow", { "用什么数据库？": { labels: ["date-fns"] } })).toThrow(/not a question/);
    expect(() => host.decide(info.id, request!.id, "deny", { "日期格式化用哪个库？": { labels: ["date-fns"] } })).toThrow(/go with allow/);
    expect(host.get(info.id)!.permissions).toHaveLength(1);
    expect(host.decide(info.id, request!.id, "allow", {
      "日期格式化用哪个库？": { labels: ["date-fns"] },
      "发布前跑哪些检查？": { labels: ["单元测试", "Lint, 格式"], other: "跑一遍 e2e" },
    })).toBe(true);
    expect(await first).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: {
      ...input, answers: { "日期格式化用哪个库？": "date-fns", "发布前跑哪些检查？": '单元测试, "Lint, 格式", 跑一遍 e2e' },
    } } } });
    // Other's words alone for one that takes one; deny stays open to a question (esc in the terminal).
    const second = ask();
    const again = host.get(info.id)!.permissions[0]!;
    host.decide(info.id, again.id, "allow", { "日期格式化用哪个库？": { other: "  先用原生 Intl  " } });
    expect(((await second) as any).hookSpecificOutput.decision.updatedInput.answers).toEqual({ "日期格式化用哪个库？": "先用原生 Intl" });
    const third = ask();
    host.decide(info.id, host.get(info.id)!.permissions[0]!.id, "deny");
    expect(((await third) as any).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "在 AgentSwitch 上被拒绝。" });
    // Answers go to a question only; any other request is allow / deny as before.
    const write = host.hook(info.id, token, { event: "PermissionRequest", payload: { tool_name: "Write", tool_input: { file_path: "/tmp/x" } } });
    const plain = host.get(info.id)!.permissions[0]!;
    expect(plain.questions).toBeUndefined();
    expect(() => host.decide(info.id, plain.id, "allow", { x: { labels: ["y"] } })).toThrow(/not a question/);
    host.decide(info.id, plain.id, "allow");
    expect(await write).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  });

  it("reads an AskUserQuestion's questions only when it can draw them, and writes answers as Claude Code does", () => {
    const q = (over: Record<string, unknown> = {}) => ({ question: "哪个？", header: "H", options: [{ label: "a", description: "" }, { label: "b" }], ...over });
    expect(askQuestions("AskUserQuestion", { questions: [q()] })).toEqual([{ question: "哪个？", header: "H", multiSelect: false, options: [{ label: "a", description: "" }, { label: "b", description: "" }] }]);
    expect(askQuestions("Bash", { questions: [q()] })).toBeNull();
    expect(askQuestions("AskUserQuestion", { questions: [] })).toBeNull();
    expect(askQuestions("AskUserQuestion", { questions: [q({ question: "" })] })).toBeNull();
    expect(askQuestions("AskUserQuestion", { questions: [q({ options: [{ label: "a" }, { label: "a" }] })] })).toBeNull();
    expect(askQuestions("AskUserQuestion", { questions: [q(), q()] })).toBeNull();                       // the same question twice
    expect(askQuestions("AskUserQuestion", { questions: [q({ options: [{ description: "no label" }] })] })).toBeNull();
    // One that takes words only (no options): Other alone answers it.
    const words = askQuestions("AskUserQuestion", { questions: [q({ options: undefined })] })!;
    expect(words[0]!.options).toEqual([]);
    expect(checkPicks(words, { "哪个？": { labels: ["a"] } })).toMatch(/not an option/);
    expect(checkPicks(words, { "哪个？": { other: "随便" } })).toBeNull();
    expect(checkPicks(words, {})).toBe("no answers");
    expect(checkPicks(words, { "哪个？": { other: "   " } })).toMatch(/no answer/);
    expect(checkPicks(askQuestions("AskUserQuestion", { questions: [q({ multiSelect: true })] })!, { "哪个？": { labels: ["a", "a"] } })).toMatch(/twice/);
    expect(answerText({ labels: ["a"] })).toBe("a");
    expect(answerText({ labels: ["a", 'say "hi"'], other: "c" })).toBe('a, "say \\"hi\\"", c');
    expect(permissionSummary("AskUserQuestion", { questions: [q({ question: "第一\n行" })] })).toBe("第一 行");
  });

  it("the size belongs to the screen that set it last; a claim at the same size changes only the owner", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    const resizes = () => events.filter((e) => e.type === "resize");
    expect(resizes().at(-1)).toMatchObject({ by: null });   // each connection says who has it
    host.resize(info.id, 120, 40, "mac-1");
    host.resize(info.id, 120, 40, "mac-1");                 // nothing new
    host.resize(info.id, 120, 40, "phone-1");               // the phone takes it at the same size
    host.resize(info.id, 50, 30, "phone-1");
    expect(resizes().slice(1)).toEqual([
      { type: "resize", cols: 120, rows: 40, by: "mac-1" },
      { type: "resize", cols: 120, rows: 40, by: "phone-1" },
      { type: "resize", cols: 50, rows: 30, by: "phone-1" },
    ]);
    const late: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => late.push(e))();
    expect(late.find((e) => e.type === "resize")).toEqual({ type: "resize", cols: 50, rows: 30, by: "phone-1" });
  });

  it("the size goes back when its owner stops following (the phone went to the background)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), sizeReleaseMs: 0 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const mac: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => mac.push(e), "mac-1");
    const phoneA = host.subscribe(info.id, null, () => undefined, "phone-1");
    const phoneB = host.subscribe(info.id, null, () => undefined, "phone-1");   // a reconnect overlapping the old stream
    host.resize(info.id, 50, 30, "phone-1");
    phoneA();
    expect(host.get(info.id)).toMatchObject({ cols: 50, rows: 30 });
    expect(mac.filter((e) => e.type === "resize").at(-1)).toMatchObject({ by: "phone-1" });
    phoneB();
    expect(mac.filter((e) => e.type === "resize").at(-1)).toEqual({ type: "resize", cols: 50, rows: 30, by: null });
    // A screen that never owned it leaves quietly.
    const count = mac.length;
    host.subscribe(info.id, null, () => undefined, "web-1")();
    expect(mac.length).toBe(count);
  });

  it("a screen that comes back within the grace keeps the size (a reconnect is not leaving)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), sizeReleaseMs: 60 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const mac: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => mac.push(e), "mac-1");
    host.subscribe(info.id, null, () => undefined, "phone-1")();
    host.resize(info.id, 50, 30, "phone-1");
    host.subscribe(info.id, null, () => undefined, "phone-1")();   // dropped at once
    const back = host.subscribe(info.id, null, () => undefined, "phone-1");
    await new Promise((r) => setTimeout(r, 120));
    expect(mac.filter((e) => e.type === "resize").at(-1)).toMatchObject({ by: "phone-1" });
    back();
    await new Promise((r) => setTimeout(r, 120));
    expect(mac.filter((e) => e.type === "resize").at(-1)).toMatchObject({ by: null });
  });

  it("remembers how the last turn ended: Stop is done, StopFailure is not, a start-up idle or a repeated Stop is no turn", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const hook = (event: string, payload: Record<string, unknown> = {}) => host.hook(info.id, token, { event, payload });
    await hook("SessionStart");
    await hook("Stop");
    expect(host.lastTurn(info.id)).toBeNull();
    await hook("UserPromptSubmit");
    await hook("Stop", { last_assistant_message: "改好了，\n测试都通过。" });
    expect(host.lastTurn(info.id)).toMatchObject({ ok: true, line: "改好了， 测试都通过。" });
    await hook("UserPromptSubmit");
    await hook("StopFailure", { error: "rate_limit", error_details: "You have hit your limit" });
    expect(host.lastTurn(info.id)).toMatchObject({ ok: false, line: "rate_limit: You have hit your limit" });
    await hook("Stop");   // after the failure: no turn was running
    expect(host.lastTurn(info.id)).toMatchObject({ ok: false });
    expect(host.get(info.id)!.status).toBe("idle");
  });

  it("reads Claude Code's compacting line off its screen, and nothing that only mentions it (2026-10-07)", () => {
    // As 2.1.292 draws it (scripts/claude_compact_probe.ts; the user's screenshot): a glyph that turns, the words, a clock.
    expect(compactingOnScreen(["❯ /compact", "✻ Compacting conversation… (1s)", "────", "❯ "])).toBe(true);
    expect(compactingOnScreen(["· Compacting conversation… (1m 5s · ↓ 3.3k tokens)", "  └ Tip: Use /btw to ask a quick side question"])).toBe(true);
    expect(compactingOnScreen(["✢ Compacting conversation…"])).toBe(true);
    // Said in an answer, quoted in a list, the command itself, what it prints when done: not it.
    expect(compactingOnScreen(["⏺ Compacting conversation… is what its screen says meanwhile."])).toBe(false);
    expect(compactingOnScreen(["  - `Compacting conversation… (1m 5s · ↓ 3.3k tokens)`"])).toBe(false);
    expect(compactingOnScreen(["❯ /compact", "  ⎿  Compacted (ctrl+o to see full summary)", "✻ Thinking… (3s)"])).toBe(false);
    expect(compactingOnScreen(["✻ Compacting conversation… (1s) and more after it"])).toBe(false);
    // The line itself quoted in an answer (indented under its bullet, or right after it) or typed into the input.
    expect(compactingOnScreen(["⏺ Its screen says:", "  ✻ Compacting conversation… (1s)"])).toBe(false);
    expect(compactingOnScreen(["⏺ Compacting conversation… (1s)"])).toBe(false);
    expect(compactingOnScreen(["❯ Compacting conversation…"])).toBe(false);
    // A narrow screen cuts the clock short.
    expect(compactingOnScreen(["✻ Compacting conversation… (1m 5s · ↓ 3.3k tok"])).toBe(true);
    expect(compactingOnScreen([])).toBe(false);
  });

  it("reads the turn's tokens off Claude Code's working line (rows seen on 2.1.293, 2026-10-08)", () => {
    expect(workingOnScreen(["✻ Hashing… (4s · ↓ 25 tokens · thought for 2s)"])).toEqual({ tokens: 25, way: "down" });
    expect(workingOnScreen(["· Hashing… (running Stop hook · 9s · ↓ 1.3k tokens)"])).toEqual({ tokens: 1300, way: "down" });
    expect(workingOnScreen(["✢ Beboppin'… (11s · ↓ 1.1k tokens · thought for 7s)", "────", "❯ "])).toEqual({ tokens: 1100, way: "down" });
    expect(workingOnScreen(["✶ Sending… (3s · ↑ 12.5k tokens)"])).toEqual({ tokens: 12500, way: "up" });
    expect(workingOnScreen(["✻ Pondering… (2h 3m 5s · ↓ 1.2m tokens)"])).toEqual({ tokens: 1_200_000, way: "down" });
    expect(workingOnScreen(["✻ Pondering… (1s · ↓ 1 token)"])).toEqual({ tokens: 1, way: "down" });
    // No count yet, or not its working line at all.
    expect(workingOnScreen(["✽ Hashing… (2s · thinking)"])).toBeNull();
    expect(workingOnScreen(["✽ Smooshing… (running UserPromptSubmit hook · 0s)"])).toBeNull();
    expect(workingOnScreen(["✽ Smooshing…"])).toBeNull();
    expect(workingOnScreen(["✻ Crunched for 9s · done 9:12 AM"])).toBeNull();
    expect(workingOnScreen([])).toBeNull();
    // The line quoted in an answer or typed by you is not it: those rows begin otherwise.
    expect(workingOnScreen(["  ✻ Hashing… (4s · ↓ 25 tokens)"])).toBeNull();
    expect(workingOnScreen(["⏺ ✻ Hashing… (4s · ↓ 25 tokens)"])).toBeNull();
    expect(workingOnScreen(["❯ ✻ Hashing… (4s · ↓ 25 tokens)"])).toBeNull();
    // The lowest such row is the live one.
    expect(workingOnScreen(["✻ Old… (4s · ↓ 25 tokens)", "text", "✶ New… (9s · ↓ 300 tokens)"])).toEqual({ tokens: 300, way: "down" });
  });

  it("tells the screens how far a Claude Code turn has come: the count on its working line, gone when it rests (2026-10-08)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), progressLookMs: 30 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const hook = (event: string, payload: Record<string, unknown> = {}) => host.hook(info.id, token, { event, payload });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    const told = () => events.flatMap((e) => (e.type === "progress" ? [e.progress?.tokens ?? null] : []));
    await until(() => host.get(info.id)!.title === "fake agent");
    await hook("SessionStart", { source: "startup" });
    expect(host.get(info.id)!.progress).toBeNull();
    // At rest its screen is not read for it (a line left over from before says nothing of now).
    host.write(info.id, "working 999\r");
    await new Promise((r) => setTimeout(r, 150));
    expect(host.get(info.id)!.progress).toBeNull();
    await hook("UserPromptSubmit");
    host.write(info.id, "working 25\r");
    await until(() => host.get(info.id)!.progress?.tokens === 25);
    host.write(info.id, "working 1.3k\r");
    await until(() => host.get(info.id)!.progress?.tokens === 1300);
    expect(host.get(info.id)!.progress).toEqual({ tokens: 1300, way: "down" });
    expect(told()).toEqual([25, 1300]);   // told when it moved, not with every redraw
    // A tool call leaves it standing; the turn's end takes it away.
    await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(host.get(info.id)!.progress).toEqual({ tokens: 1300, way: "down" });
    await hook("Stop");
    expect(host.get(info.id)).toMatchObject({ status: "idle", progress: null });
    expect(told()).toEqual([25, 1300, null]);
    // The next turn starts from nothing, whatever is still on its screen.
    await hook("UserPromptSubmit");
    expect(host.get(info.id)!.progress).toBeNull();
  });

  it("a request is answered by its own tool call ending, not by another call of the same tool (2026-10-08)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const hook = (event: string, payload: Record<string, unknown> = {}) => host.hook(info.id, token, { event, payload });
    const pending = () => host.get(info.id)!.permissions.map((p) => p.summary);
    await until(() => host.get(info.id)!.title === "fake agent");
    await hook("UserPromptSubmit");
    // Two commands at once, as Claude Code's hooks say them (2.1.293: an id on PreToolUse and PostToolUse, none on
    // PermissionRequest): one runs by itself, the other has to be asked about.
    await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_ls", tool_input: { command: "ls" } });
    await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_rm", tool_input: { command: "rm -rf build" } });
    const asked = hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" } });
    await until(() => pending().length === 1);
    // The other command ends, and a sub-agent's of the same tool: the request is still the user's to answer.
    await hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_ls", tool_input: { command: "ls" } });
    await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_sub", agent_id: "a1", agent_type: "Explore", tool_input: { command: "rg x" } });
    await hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_sub", agent_id: "a1", agent_type: "Explore", tool_input: { command: "rg x" } });
    expect(pending()).toEqual(["Bash: rm -rf build"]);
    expect(host.get(info.id)!.status).toBe("waiting");
    // Its own call ends (answered in the terminal itself, even with the command changed there): now it is gone.
    await hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_rm", tool_input: { command: "rm -rf ./build" } });
    expect(pending()).toEqual([]);
    expect(await asked).toBeNull();
    // Two requests for the same command, each for its own call: the first call ending leaves the second's.
    await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_a", tool_input: { command: "make" } });
    const first = hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "make" } });
    await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "toolu_b", tool_input: { command: "make" } });
    const second = hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "make" } });
    await until(() => pending().length === 2);
    const ids = host.get(info.id)!.permissions.map((p) => p.id);
    await hook("PostToolUse", { tool_name: "Bash", tool_use_id: "toolu_a", tool_input: { command: "make" } });
    expect(host.get(info.id)!.permissions.map((p) => p.id)).toEqual([ids[1]]);
    await hook("Stop");
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    // An agent whose hooks give no ids: as before, by what the request was for, else by being the only one of its tool.
    await hook("UserPromptSubmit");
    const plain = hook("PermissionRequest", { tool_name: "Edit", tool_input: { file_path: "/w/a.ts" } });
    await until(() => pending().length === 1);
    await hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: "/w/other.ts" } });
    expect(pending()).toEqual([]);
    expect(await plain).toBeNull();
  });

  it("reads a list to choose from off the agent's screen: numbered rows with the selection's mark (2026-10-08)", () => {
    // Codex's `/model`, as its screen draws it.
    expect(choicesOnScreen(["• Working", "", "  Select Model and Effort", "› 1. gpt-6-sol (current)   Frontier model", "  2. gpt-6-luna            Fast and light", "  3. gpt-5.6-codex", "", "  Press enter to confirm or esc to go back"])).toEqual({
      title: "Select Model and Effort", selected: 0,
      options: [{ label: "gpt-6-sol (current)", detail: "Frontier model" }, { label: "gpt-6-luna", detail: "Fast and light" }, { label: "gpt-5.6-codex" }],
    });
    // Claude Code's question in its box, the mark on the second row; a row's second line continues it.
    expect(choicesOnScreen(["│ Do you trust the files in this folder?   │", "│   1. Yes, proceed                        │", "│ ❯ 2. No, exit                            │", "│      (nothing is run)                    │"]))
      .toMatchObject({ title: "Do you trust the files in this folder?", selected: 1, options: [{ label: "Yes, proceed" }, { label: "No, exit" }] });
    // As Codex 0.162's own snapshots draw them: the title two rows up, a row's words wrapped onto the next; and a
    // list of one row, known by the line under it.
    expect(choicesOnScreen(["  Select Model and Effort", "", "", "› 1. gpt-5.1-codex (current)  Optimized for Codex. Balance of reasoning quality", "                              and coding ability.", "  2. gpt-5.1-codex-mini       Optimized for Codex. Cheaper, faster, but less", "                              capable."]))
      .toMatchObject({ title: "Select Model and Effort", selected: 0, options: [{ label: "gpt-5.1-codex (current)" }, { label: "gpt-5.1-codex-mini" }] });
    expect(choicesOnScreen(["  Select Reasoning Level for GPT-5.5", "", "", "› 1. More reasoning…  Ultra consumes usage limits faster", "", "  enter select · esc back"]))
      .toEqual({ title: "Select Reasoning Level for GPT-5.5", selected: 0, options: [{ label: "More reasoning…", detail: "Ultra consumes usage limits faster" }] });
    // A numbered list in an answer has no mark; one row is no list; numbers out of order are not one list.
    expect(choicesOnScreen(["Here is the plan:", "1. Read the file", "2. Change it", "3. Run the tests"])).toBeNull();
    expect(choicesOnScreen(["❯ 1. only one"])).toBeNull();
    expect(choicesOnScreen(["› 1. a", "  3. c"])).toBeNull();
    expect(choicesOnScreen(["› 1. a", "› 2. b"])).toBeNull();
    expect(choicesOnScreen([])).toBeNull();
  });

  it("offers the list on the agent's screen to the screens and takes a row as the terminal would: arrows, then enter (2026-10-08)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), choiceLookMs: 30 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir() });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    await until(() => host.get(info.id)!.title === "fake agent");
    expect(host.get(info.id)!.choices).toBeNull();
    host.write(info.id, "menu\r");
    await until(() => host.get(info.id)!.choices !== null);
    expect(host.get(info.id)!.choices).toMatchObject({ title: "Select Model and Effort", selected: 0, options: [{ label: "gpt-6-sol (current)" }, { label: "gpt-6-luna", detail: "Fast and light" }, { label: "gpt-5.6-codex" }] });
    expect(events.some((e) => e.type === "choices" && e.choices?.options.length === 3)).toBe(true);
    // What the screen had is no longer there: refused, nothing typed.
    expect(() => host.choose(info.id, 1, "something else")).toThrow(/no longer shows/);
    expect(() => host.choose(info.id, 9, "gpt-6-luna")).toThrow(/no longer shows/);
    host.choose(info.id, 2, "gpt-5.6-codex");
    await until(() => text(events).includes("Model changed to gpt-5.6-codex"));
    await until(() => host.get(info.id)!.choices === null);
    expect(events.filter((e) => e.type === "choices").pop()).toEqual({ type: "choices", choices: null });
    expect(() => host.choose(info.id, 0, "gpt-6-sol (current)")).toThrow(/no longer shows/);
  });

  it("says what the agent's screen printed for a command: the new lines above its input line (2026-10-08)", () => {
    const before = ["› 你好", "", "• 你好！有什么我可以帮你处理的？", "", "› Ask Codex to do anything", "  GPT-6-Sol high · ~/w"];
    expect(printedSince(before, ["› 你好", "", "• 你好！有什么我可以帮你处理的？", "", "• Daybreak off. Applies to new turns.", "", "› Ask Codex to do anything", "  GPT-6-Sol high · ~/w"]))
      .toBe("Daybreak off. Applies to new turns.");
    // Claude Code: the echo of what was typed is not it; its answer under it is.
    expect(printedSince(["❯ ", "────"], ["❯ /model opus", "  ⎿  Set model to Opus 5.5", "────────", "❯ ", "────────"])).toBe("Set model to Opus 5.5");
    expect(printedSince(before, before)).toBe("");
    // What changed under the input line (its status row) is not something said.
    expect(printedSince(before, [...before.slice(0, 5), "  GPT-6-Luna low · ~/w"])).toBe("");
  });

  it("tells the record's screens what a command printed on the agent's screen (2026-10-08)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir() });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    await until(() => host.get(info.id)!.title === "fake agent");
    await new Promise((r) => setTimeout(r, 200));
    host.commanded(info.id);
    host.write(info.id, "/daybreak\r");
    await until(() => host.get(info.id)!.notices.length === 1, 4000);
    expect(host.get(info.id)!.notices[0]!.text).toContain("Daybreak on. Applies to new turns.");
    expect(events.filter((e) => e.type === "notices")).toHaveLength(1);
  });

  it("reads an agent's own list of commands off its screen, and whether its input is empty (2026-10-08)", () => {
    // Codex 0.162's own snapshot of the list, above its input; Claude Code's, below it.
    expect(commandRows(["› /model     choose what model and reasoning effort to use", "  /memories  configure memory use and generation", "  /mcp       list MCP tools; use /mcp verbose or /mcp login <name>", "", "› /m", "", "  gpt-test default · /tmp/project"]))
      .toEqual([{ name: "model", description: "choose what model and reasoning effort to use" }, { name: "memories", description: "configure memory use and generation" }, { name: "mcp", description: "list MCP tools; use /mcp verbose or /mcp login <name>" }]);
    expect(commandRows(["❯ /", "────", "  /add-dir          Add a new working directory", "  /prompts:fix      Fix it"]).map((c) => c.name)).toEqual(["add-dir", "prompts:fix"]);
    expect(commandRows(["• see /usr/local/bin  for more", "text /model  x"])).toEqual([]);
    const row = (text: string, dimFrom = Infinity) => ({ text, dim: [...text].map((_, i) => i >= dimFrom) });
    expect(inputEmpty([row("• hello"), row("› Ask Codex to do anything", 2), row("  GPT-6-Sol high")])).toBe(true);
    expect(inputEmpty([row("❯ "), row("────")])).toBe(true);
    expect(inputEmpty([row("› half a thought")])).toBe(false);
    expect(inputEmpty([row("no input line here")])).toBe(false);
  });

  it("learns an agent's own commands from a terminal running it: types `/`, walks its list, takes the `/` out (2026-10-08)", async () => {
    const launcher = fakeLauncher(() => "http://127.0.0.1:9", true);
    const host = new TerminalHost({ launcher: (req) => { const plan = launcher(req); return { ...plan, env: { ...plan.env, FAKE_SLASH: "1" } }; } });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    await until(() => host.get(info.id)!.title === "fake agent");
    expect(host.commandsOf(info.id)).toBeNull();
    // Its input is not on the screen yet: nothing is typed, nothing learned.
    await host.learnCommands(info.id);
    expect(host.commandsOf(info.id)).toBeNull();
    // At work: not now either.
    host.write(info.id, "raw\r");   // keys reach it one by one, as they reach a real agent
    await new Promise((r) => setTimeout(r, 100));
    host.write(info.id, "suggest try this\r");   // draws an input line with only its dim words in it
    await new Promise((r) => setTimeout(r, 150));
    await host.hook(info.id, token, { event: "UserPromptSubmit", payload: {} });
    await host.learnCommands(info.id);
    expect(host.commandsOf(info.id)).toBeNull();
    await host.hook(info.id, token, { event: "Stop", payload: {} });
    await host.learnCommands(info.id);
    expect(host.commandsOf(info.id)!.map((c) => c.name).sort()).toEqual(["compact", "daybreak", "diff", "model", "new", "quit", "status"]);
    expect(host.commandsOf(info.id)!.find((c) => c.name === "daybreak")!.description).toBe("turn Daybreak on or off");
    // The `/` is out of its input again, and another terminal of the same program has the list without being read.
    await until(() => inputEmpty(screenRows((host as unknown as { sessions: Map<string, { term: Parameters<typeof screenRows>[0] }> }).sessions.get(info.id)!.term, 30)));
    const other = await host.spawn({ harness: "codex", cwd: tmpdir() });
    expect(host.commandsOf(other.id)!.length).toBe(7);
  }, 20_000);

  it("keeps a reply a screen sent until the agent's record holds it, or it turns out not to have been a message (2026-10-08)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), sentRestMs: 120 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const hook = (event: string, payload: Record<string, unknown> = {}) => host.hook(info.id, token, { event, payload });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    const sent = () => host.get(info.id)!.sent.map((r) => r.text);
    await until(() => host.get(info.id)!.title === "fake agent");
    await hook("SessionStart", { source: "startup" });
    // Sent, and its turn begins: shown from the moment it was sent, through the turn, until the record has it.
    host.replied(info.id, "  把重试次数改成 3 \n", 0);
    expect(sent()).toEqual(["把重试次数改成 3"]);
    expect(events.filter((e) => e.type === "sent").pop()).toMatchObject({ replies: [{ text: "把重试次数改成 3", files: 0 }] });
    await hook("UserPromptSubmit");
    await new Promise((r) => setTimeout(r, 300));
    expect(sent()).toEqual(["把重试次数改成 3"]);   // at work: not given up
    // One more while it works (it waits its turn), then the record holds the first.
    host.replied(info.id, "顺便跑一下测试", 1);
    const [first, second] = host.get(info.id)!.sent;
    host.confirmSent(info.id, [first!.id]);
    expect(sent()).toEqual(["顺便跑一下测试"]);
    host.confirmSent(info.id, ["nope"]);
    expect(events.filter((e) => e.type === "sent")).toHaveLength(3);   // nothing told for nothing changed
    // The turn ends and the next begins at once with what waited: kept across the moment at rest.
    await hook("Stop");
    await new Promise((r) => setTimeout(r, 40));
    await hook("UserPromptSubmit");
    await new Promise((r) => setTimeout(r, 300));
    expect(sent()).toEqual(["顺便跑一下测试"]);
    host.confirmSent(info.id, [second!.id]);
    expect(sent()).toEqual([]);
    // The agent's own commands are not messages; nor is what was typed while it rests and began no turn (an answer
    // to a question on its own screen): that one leaves after a moment.
    await hook("Stop");
    host.replied(info.id, "/model opus");
    host.replied(info.id, "!ls");
    host.replied(info.id, "   ");
    expect(sent()).toEqual([]);
    host.replied(info.id, "2");
    expect(sent()).toEqual(["2"]);
    await until(() => sent().length === 0);
    expect(events.filter((e) => e.type === "sent").pop()).toEqual({ type: "sent", replies: [] });
    // No more than a few are kept.
    await hook("UserPromptSubmit");
    for (let i = 0; i < 9; i++) host.replied(info.id, `message ${i}`);
    expect(sent()).toEqual(["message 3", "message 4", "message 5", "message 6", "message 7", "message 8"]);
  });

  it("is at work on Compact while Claude Code's screen says it compacts, and what it was before afterwards (2026-10-07)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), compactLookMs: 40 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const hook = (event: string, payload: Record<string, unknown> = {}) => host.hook(info.id, token, { event, payload });
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => events.push(e));
    const now = () => { const t = host.get(info.id)!; return [t.status, t.activity?.tool ?? null]; };
    const is = (status: string, tool: string | null) => until(() => now()[0] === status && now()[1] === tool);
    await until(() => host.get(info.id)!.title === "fake agent");
    await hook("SessionStart", { source: "startup" });
    // You asked for it at rest (`/compact` is a local command: no hook says it began).
    host.write(info.id, "compacting\r");
    await is("working", "Compact");
    expect(host.get(info.id)!.activity).toEqual({ tool: "Compact", target: "" });
    expect(events.some((e) => e.type === "activity" && e.activity?.tool === "Compact")).toBe(true);
    // Done: the SessionStart that follows a compaction says so at once, before its line has left the screen.
    await hook("SessionStart", { source: "compact" });
    expect(now()).toEqual(["idle", null]);
    host.write(info.id, "compacted\r");
    await new Promise((r) => setTimeout(r, 250));
    expect(now()).toEqual(["idle", null]);
    expect(host.lastTurn(info.id)).toBeNull();   // not a turn: nothing to report
    // Cancelled or failed, no hook says anything: its line leaving the screen does.
    await new Promise((r) => setTimeout(r, 1500));   // (the line of the one before is believed again after a moment)
    host.write(info.id, "compacting\r");
    await is("working", "Compact");
    host.write(info.id, "compacted\r");
    await is("idle", null);
    expect(host.lastTurn(info.id)).toBeNull();
    // Its context fills up in the middle of a turn: at work before, at work after, its sub-agents kept — the
    // SessionStart that follows a compaction no longer puts a working terminal at rest.
    await hook("UserPromptSubmit");
    await hook("SubagentStart", { agent_id: "a1", agent_type: "Explore" });
    await hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } });
    host.write(info.id, "compacting\r");
    await is("working", "Compact");
    await hook("SubagentStop", { agent_id: "a9", agent_type: "summary" });   // a helper of its own stops meanwhile: not the end
    expect(now()).toEqual(["working", "Compact"]);
    await hook("SessionStart", { source: "compact" });
    expect(now()).toEqual(["working", null]);
    expect(host.get(info.id)!.subagents.map((a) => a.id)).toEqual(["a1"]);
    host.write(info.id, "compacted\r");
    await hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/w/a.ts" } });
    expect(now()).toEqual(["working", "Read"]);
    await hook("Stop", { last_assistant_message: "好了" });
    expect(now()).toEqual(["idle", null]);
    expect(host.lastTurn(info.id)).toMatchObject({ ok: true, line: "好了" });
    // No hook is added for it: Claude Code prints a hook's command into the terminal after every compaction.
    expect(Object.keys(claudeHookSettings("hook").hooks as object)).not.toContain("PreCompact");
    // Another agent's screen is not read for Claude Code's words.
    const other = await host.spawn({ harness: "codex", cwd: tmpdir() });
    await until(() => host.get(other.id)!.title === "fake agent");
    const otherToken = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(other.id)!.hookToken;
    await host.hook(other.id, otherToken, { event: "Stop", payload: {} });
    host.write(other.id, "compacting\r");
    await new Promise((r) => setTimeout(r, 300));
    expect(host.get(other.id)!.activity).toBeNull();
  });

  it("turns Codex's Daybreak switch by its own command and follows it: read from its companion, typed only when it stands otherwise (2026-10-07)", async () => {
    // The fake agent flips on `/daybreak` and says how it stands, as Codex's TUI does; the companion here answers
    // what the TUI would have saved on its server — the last such line.
    let said = "";
    const stands = () => { const all = [...said.matchAll(/Daybreak (on|off)\. Applies/g)]; return all.length ? all.at(-1)![1] === "on" : false; };
    const asked: (string | null | undefined)[] = [];
    const plan = fakeLauncher(() => "http://127.0.0.1:9", true);
    const launcher: Launcher = (req) => ({ ...plan(req), ...(req.harness === "codex" ? { companion: {
      start: async () => ({ args: plan(req).args, env: plan(req).env }), attach: () => undefined, stop: () => undefined, reportsStatus: false,
      daybreak: async (session?: string | null) => { asked.push(session); return stands(); },
    } } : {}) });
    const host = new TerminalHost({ launcher, daybreakWaitMs: 1500 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir() });
    expect(info.daybreak).toBe(false);   // read as it starts
    const events: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => { events.push(e); if (e.type === "output" || e.type === "snapshot") said += e.data; });
    await until(() => host.get(info.id)!.title === "fake agent");
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    await host.hook(info.id, token, { event: "SessionStart", payload: { session_id: "th1" } });
    const typed = () => [...said.matchAll(/Daybreak (on|off)\. Applies/g)].length;
    // On: its command typed once, its companion asked (of the session its hooks named) until it says so.
    expect(await host.askDaybreak(info.id, true)).toBe(true);
    expect(typed()).toBe(1);
    expect(asked.at(-1)).toBe("th1");
    expect(host.get(info.id)!.daybreak).toBe(true);
    expect(events.filter((e) => e.type === "daybreak")).toEqual([{ type: "daybreak", on: true }]);
    // Already so: nothing typed (the command only flips).
    expect(await host.askDaybreak(info.id, true)).toBe(true);
    expect(typed()).toBe(1);
    // Turned in the terminal itself: its screen names the switch, the companion is asked, the screens are told.
    host.write(info.id, "/daybreak\r");
    await until(() => host.get(info.id)!.daybreak === false);
    expect(events.filter((e) => e.type === "daybreak").at(-1)).toEqual({ type: "daybreak", on: false });
    // While it works too (Codex takes the command then; it holds from the next turn).
    await host.hook(info.id, token, { event: "UserPromptSubmit", payload: {} });
    expect(await host.askDaybreak(info.id, true)).toBe(true);
    // Not while something waits for an answer: the keys would go there.
    const gone = new AbortController();
    const card = host.hook(info.id, token, { event: "PermissionRequest", payload: { tool_name: "Bash", tool_input: { command: "ls" } } }, gone.signal);
    await expect(host.askDaybreak(info.id, false)).rejects.toMatchObject({ code: "busy" });
    gone.abort(); await card;
    // A terminal without the switch: no such thing to turn, and its info says none.
    const plain = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    expect(plain.daybreak).toBeNull();
    await expect(host.askDaybreak(plain.id, true)).rejects.toMatchObject({ code: "invalid" });
  });

  it("Codex that does not turn its Daybreak switch is said so, and what its companion says stands", async () => {
    const plan = fakeLauncher(() => "http://127.0.0.1:9", true);
    const launcher: Launcher = (req) => ({ ...plan(req), companion: { start: async () => ({ args: plan(req).args, env: plan(req).env }), attach: () => undefined, stop: () => undefined, reportsStatus: false, daybreak: async () => false } });
    const host = new TerminalHost({ launcher, daybreakWaitMs: 600 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir() });
    await expect(host.askDaybreak(info.id, true)).rejects.toThrow(/did not turn it/);
    expect(host.get(info.id)!.daybreak).toBe(false);
  });

  it("a program that ends on an error by itself is a failed turn; one the service ended is not", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), killGraceMs: 200 });
    closers.push(() => host.closeAll());
    const crashed = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    host.write(crashed.id, "exit\r");   // the fake agent exits with code 3
    await until(() => host.get(crashed.id)!.status === "exited");
    expect(host.lastTurn(crashed.id)).toMatchObject({ ok: false, line: "进程退出（代码 3）" });
    const closed = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    await host.stopped(closed.id);
    expect(host.get(closed.id)!.status).toBe("exited");
    expect(host.lastTurn(closed.id)).toBeNull();
  });

  it("a permission request answered in the terminal leaves the screens once the tool runs or the turn ends", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const ask = (file: string) => host.hook(info.id, token, { event: "PermissionRequest", payload: { tool_name: "Write", tool_input: { file_path: file } } });
    const first = ask("/tmp/a");
    const second = ask("/tmp/b");
    expect(host.get(info.id)!.permissions).toHaveLength(2);
    await host.hook(info.id, token, { event: "PostToolUse", payload: { tool_name: "Write", tool_input: { file_path: "/tmp/b" }, tool_response: {} } });
    expect(await second).toBeNull();
    expect(host.get(info.id)!.permissions.map((p) => p.summary)).toEqual(["Write: /tmp/a"]);
    await host.hook(info.id, token, { event: "Stop", payload: {} });
    expect(await first).toBeNull();
    expect(host.get(info.id)).toMatchObject({ status: "idle", permissions: [] });
  });

  it("remembers the tool it is using and since when it works, for the Live Activity; idle forgets the tool", async () => {
    let now = 1_000;
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), now: () => now });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    now = 5_000;
    await host.hook(info.id, token, { event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "npm   test" } } });
    expect(host.get(info.id)).toMatchObject({ status: "working", statusSince: 5_000, activity: { tool: "Bash", target: "npm test" } });
    now = 6_000;
    await host.hook(info.id, token, { event: "PreToolUse", payload: { tool_name: "Edit", tool_input: { file_path: "/w/a.ts", old_string: "x" } } });
    expect(host.get(info.id)).toMatchObject({ statusSince: 5_000, activity: { tool: "Edit", target: "/w/a.ts" } });
    expect(host.get(info.id)!.activity).not.toHaveProperty("note");
    // What the agent says the command is for, in its own words (2026-10-07: its own app says that, not the command):
    // one line, with the activity.
    await host.hook(info.id, token, { event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "cat > x <<'EOF'\n…", description: "Write the patch\n  and run it" } } });
    expect(host.get(info.id)!.activity).toEqual({ tool: "Bash", target: "cat > x <<'EOF' …", note: "Write the patch and run it" });
    now = 9_000;
    await host.hook(info.id, token, { event: "Stop", payload: {} });
    expect(host.get(info.id)).toMatchObject({ status: "idle", statusSince: 9_000, activity: null });
  });

  it("keeps the protected paths closed in every permission mode (PreToolUse)", async () => {
    const floor = (tool: string, input: Record<string, unknown>) => (tool === "Bash" && String(input.command).includes("local-token") ? "denied by AgentSwitch" : null);
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), floor });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir(), mode: "bypass" });
    expect(host.get(info.id)!.mode).toBe("bypass");
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    expect(await host.hook(info.id, token, { event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "cat ~/x/local-token" } } }))
      .toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "denied by AgentSwitch" } });
    expect(await host.hook(info.id, token, { event: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "ls" } } })).toBeNull();
    expect(host.get(info.id)!.status).toBe("working");
  });

  it("owns only the session it started: a fork's new one, never the original or one `/resume`d inside it", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const tokenOf = (id: string) => (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(id)!.hookToken;
    const report = (id: string, session: string) => host.hook(id, tokenOf(id), { event: "SessionStart", payload: { session_id: session } });
    const fresh = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    await report(fresh.id, "new-1");
    await report(fresh.id, "someone-elses");   // `/resume someone-elses` typed inside it
    expect(host.get(fresh.id)!.agentSessionId).toBe("someone-elses");
    expect(host.ownSession(fresh.id)).toBe("new-1");
    const fork = await host.spawn({ harness: "claude-code", cwd: tmpdir(), resume: "orig", fork: true });
    await report(fork.id, "orig");
    expect(host.ownSession(fork.id)).toBeNull();
    await report(fork.id, "fork-1");
    expect(host.ownSession(fork.id)).toBe("fork-1");
    const same = await host.spawn({ harness: "claude-code", cwd: tmpdir(), resume: "orig" });
    await report(same.id, "orig");
    expect(host.ownSession(same.id)).toBeNull();
  });

  it("refuses a hook call with the wrong token, and a launcher that cannot start the agent", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    await expect(host.hook(info.id, "not-the-token", { event: "Stop", payload: {} })).rejects.toThrow(/hook token/);
    const broken = new TerminalHost({ launcher: () => { throw new Error("codex is not installed on this Mac"); } });
    await expect(broken.spawn({ harness: "codex", cwd: tmpdir() })).rejects.toThrow(/not installed/);
  });
});

describe("terminals over HTTP", () => {
  async function start(elsewhere?: ElsewhereCheck, sealer?: Sealer) {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-terminals-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-terminal-cwd-"));
    let base = "";
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const daemon = buildDaemon(cfg, { terminalLauncher: fakeLauncher(() => base, true), ...(elsewhere ? { terminalElsewhere: elsewhere } : {}), ...(sealer ? { sealer } : {}) });
    const token = ensureLocalToken(home);
    const port = await new Promise<number>((done) => {
      const server = listenLocal(daemon, 0, (info: AddressInfo) => done(info.port), new LocalAuth(token));
      closers.push(() => { server.close(); daemon.close(); });
    });
    daemon.setLocalPort(port);
    base = `http://127.0.0.1:${port}`;
    const call = async (method: string, path: string, body?: unknown, auth = true) => {
      const res = await fetch(base + path, { method, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    return { home, cwd, base, token, call, daemon };
  }

  /** The SSE stream read into `events` until `stop()`. */
  function follow(base: string, token: string, id: string, query = "") {
    const events: { event: string; data: any }[] = [];
    const ctl = new AbortController();
    void (async () => {
      const res = await fetch(`${base}/terminals/${id}/stream${query}`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    })().catch(() => undefined);
    closers.push(() => ctl.abort());
    return events;
  }

  it("a screen that shows the record, not the terminal, gets no screen content and is told what the agent is doing (simple-view-v0 §4)", async () => {
    const { cwd, base, token, call } = await start();
    const id = (await call("POST", "/terminals", { harness: "claude-code", cwd })).json.terminal.id as string;
    const terminal = follow(base, token, id);
    const record = follow(base, token, id, "?view=record");
    await until(() => terminal.some((e) => e.event === "snapshot"));
    // At once: what it is doing now (nothing yet), its status, the requests waiting.
    await until(() => record.some((e) => e.event === "activity") && record.some((e) => e.event === "permissions"));
    expect(record.find((e) => e.event === "activity")!.data).toMatchObject({ activity: null, subagents: [] });

    expect((await call("POST", `/terminals/${id}/input`, { text: "tool" })).status).toBe(200);
    await until(() => record.some((e) => e.event === "activity" && e.data.activity?.tool === "Bash"));
    expect(record.findLast((e) => e.event === "activity")!.data.activity).toEqual({ tool: "Bash", target: "npm test" });
    expect(record.some((e) => e.event === "status" && e.data.status === "working")).toBe(true);
    await until(() => terminal.some((e) => e.event === "output" && String(e.data.data).includes("tool used")));
    // Neither sees the other's: no screen for the record, no `activity` for a terminal's screen (older apps do not know it).
    expect(record.some((e) => e.event === "snapshot" || e.event === "output")).toBe(false);
    expect(terminal.some((e) => e.event === "activity" || e.event === "record")).toBe(false);
    // It draws no terminal, so it never owns the size.
    expect((await call("GET", `/terminals/${id}`)).json.terminal.sizedBy ?? null).toBeNull();
  });

  it("Claude Code's prompt suggestion is read off its screen while it rests: dim words in its empty input", async () => {
    // 2026-10-07, user: 有的时候cli会进行回复预测，这个也做出来，按tap补全. The shape is the real screen's (2.1.292).
    const dim = (text: string, from = 2): ScreenRow => ({ text, dim: [...text].map((_, x) => x >= from) });
    const plain = (text: string): ScreenRow => ({ text, dim: [...text].map(() => false) });
    const rule = plain("─".repeat(40));
    expect(suggestionOnScreen([plain("⏺ Should I add this one too?"), rule, dim("❯ add both"), rule, plain("  ⏸ manual mode on")])).toBe("add both");
    expect(suggestionOnScreen([rule, dim("❯\u00a0run the tests"), rule])).toBe("run the tests");
    // Nothing offered; typing in it; an example from before the first message; no input line at all.
    expect(suggestionOnScreen([rule, plain("❯"), rule])).toBeNull();
    expect(suggestionOnScreen([rule, plain("❯ "), rule])).toBeNull();
    expect(suggestionOnScreen([rule, plain("❯ add both"), rule])).toBeNull();
    expect(suggestionOnScreen([rule, { text: "❯ add both", dim: [false, false, true, true, true, true, false, true, true, true] }, rule])).toBeNull();
    expect(suggestionOnScreen([rule, dim('❯ Try "fix the lint errors"'), rule])).toBeNull();
    expect(suggestionOnScreen([plain("⏺ done"), plain("  ? for shortcuts")])).toBeNull();
    // The last input line is the one: what was sent earlier is above it.
    expect(suggestionOnScreen([plain("❯ Read notes.md"), plain("⏺ It is a list."), rule, dim("❯ add a third item"), rule])).toBe("add a third item");
    expect(modeOnScreen(["  ⏸ manual mode on · ← for agents"])).toBe("default");

    const { cwd, base, token, call } = await start();
    const id = (await call("POST", "/terminals", { harness: "claude-code", cwd })).json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    const offered = () => events.filter((e) => e.event === "suggestion").map((e) => e.data.text);
    const info = async () => (await call("GET", `/terminals/${id}`)).json.terminal as { status: string; suggestion: string | null };
    const say = (text: string) => call("POST", `/terminals/${id}/input`, { text, seal: false });
    await until(() => screen().includes("fake agent ready"));
    expect((await info()).suggestion).toBeNull();
    // At rest, its input shows what it offers.
    await say("suggest add both");
    await until(() => offered().includes("add both"));
    expect((await info()).suggestion).toBe("add both");
    // You typed there yourself: not a suggestion.
    await say("typed add both of them");
    await until(() => offered().length === 2);
    expect((await info()).suggestion).toBeNull();
    await say("suggest run the tests");
    await until(() => offered().length === 3);
    // It works again: gone at once, and not read while it works.
    await say("tool");
    await untilAsked(async () => (await info()).status === "working");
    await until(() => offered().length === 4);
    await say("suggest not while it works");
    await new Promise((r) => setTimeout(r, 500));
    expect((await info()).suggestion).toBeNull();
    expect(offered()).toEqual(["add both", null, "run the tests", null]);
    // Another agent's screen is not read for one.
    const other = (await call("POST", "/terminals", { harness: "codex", cwd })).json.terminal.id as string;
    await call("POST", `/terminals/${other}/input`, { text: "suggest add both", seal: false });
    await new Promise((r) => setTimeout(r, 600));
    expect(((await call("GET", `/terminals/${other}`)).json.terminal as { suggestion: string | null }).suggestion).toBeNull();
  });

  it("a reply's @: the files of the terminal's folder by name, a name that starts with what was typed first", async () => {
    // 2026-10-07, user: 我输入/的时候输入框应该给我提示应有的选项，包括其他cli里应有的特殊符号也一样.
    const files = ["README.md", "src/api/terminals.ts", "src/terminals/host.ts", "tests/terminals.test.ts", "docs/terminal-v0.md", "src/term.ts"];
    expect(matchFiles(files, "term")).toEqual(["src/term.ts", "docs/terminal-v0.md", "src/api/terminals.ts", "tests/terminals.test.ts", "src/terminals/host.ts"]);
    expect(matchFiles(files, "HOST")).toEqual(["src/terminals/host.ts"]);
    // Nothing typed: the files nearest the folder's top first.
    expect(matchFiles(files, "")).toEqual(["README.md", "docs/terminal-v0.md", "src/term.ts", "tests/terminals.test.ts", "src/api/terminals.ts", "src/terminals/host.ts"]);
    expect(matchFiles(files, "", 2)).toHaveLength(2);
    expect(matchFiles(files, "nothing-like-it")).toEqual([]);

    const { cwd, call } = await start();
    mkdirSync(join(cwd, "src", "deep"), { recursive: true });
    mkdirSync(join(cwd, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(cwd, ".cache"), { recursive: true });
    for (const f of ["src/retry.ts", "src/deep/retry-policy.ts", "notes.md", "node_modules/left-pad/retry.js", ".cache/retry.tmp"]) writeFileSync(join(cwd, f), "x");
    // Not a repository: walked, without what nobody mentions.
    expect(await folderFiles(cwd, () => 1)).toEqual(expect.arrayContaining(["src/retry.ts", "src/deep/retry-policy.ts", "notes.md"]));
    expect((await folderFiles(cwd, () => 2)).some((f) => f.includes("node_modules") || f.startsWith("."))).toBe(false);
    const id = (await call("POST", "/terminals", { harness: "claude-code", cwd })).json.terminal.id as string;
    expect((await call("GET", `/terminals/${id}/files?q=retry`)).json).toEqual({ files: ["src/retry.ts", "src/deep/retry-policy.ts"] });
    expect((await call("GET", `/terminals/${id}/files?q=notes`)).json).toEqual({ files: ["notes.md"] });
    expect((await call("GET", "/terminals/nope/files?q=x")).status).toBe(404);
  });

  it("a screen changes how Claude Code asks: ⇧Tab pressed and its screen read until it names the mode; not one the session does not offer", async () => {
    // 2026-10-07, user: Bypass权限那一块要可以调整. The line under its input, newest first.
    expect(modeOnScreen(["⏵⏵ accept edits on (shift+tab to cycle)", "> ", "⏸ plan mode on (shift+tab to cycle)"])).toBe("plan");
    expect(modeOnScreen(["⏸ plan mode on (shift+tab to cycle)", "  ? for shortcuts"])).toBe("default");
    expect(modeOnScreen(["⏵⏵ bypass permissions on (shift+tab to cycle)"])).toBe("bypassPermissions");
    expect(modeOnScreen(["⏵⏵ auto mode on"])).toBe("auto");
    expect(modeOnScreen([])).toBe("default");

    const { home, cwd, base, token, call } = await start();
    const id = (await call("POST", "/terminals", { harness: "claude-code", cwd })).json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    await until(() => screen().includes("fake agent ready"));
    expect((await call("GET", `/terminals/${id}`)).json.terminal.modeNow).toBeNull();
    // Its keys one at a time, as Claude Code's screen takes them.
    expect((await call("POST", `/terminals/${id}/input`, { text: "raw", seal: false })).status).toBe(200);
    await until(() => screen().includes("raw on"));
    // Two presses round to plan (the fake's round: default, acceptEdits, plan); the stream says the mode it is in.
    const first = await call("POST", `/terminals/${id}/mode`, { mode: "plan" });
    expect(first.json, JSON.stringify([first.status, first.json, (await call("GET", `/terminals/${id}`)).json.terminal.status])).toEqual({ ok: true, mode: "plan" });
    expect((await call("GET", `/terminals/${id}`)).json.terminal.modeNow).toBe("plan");
    await until(() => events.some((e) => e.event === "mode" && e.data.mode === "plan"));
    expect(screen().split("mode on").length - 1).toBe(1);
    // Already there: no key at all.
    const before = screen().length;
    expect((await call("POST", `/terminals/${id}/mode`, { mode: "plan" })).json).toEqual({ ok: true, mode: "plan" });
    expect(screen().length).toBe(before);
    // One more press is the round's start again.
    expect((await call("POST", `/terminals/${id}/mode`, { mode: "default" })).json).toEqual({ ok: true, mode: "default" });
    // A mode this session's round has not: once round and back where it began, said as such.
    const refused = await call("POST", `/terminals/${id}/mode`, { mode: "bypassPermissions" });
    expect(refused.status).toBe(400);
    expect((await call("GET", `/terminals/${id}`)).json.terminal.modeNow).toBe("default");
    expect((await call("POST", `/terminals/${id}/mode`, { mode: "yolo" })).status).toBe(400);
    expect((await call("POST", "/terminals/nope/mode", { mode: "plan" })).status).toBe(404);
    // Not while it works (the key would go to whatever has its screen).
    expect((await call("POST", `/terminals/${id}/input`, { text: "tool" })).status).toBe(200);
    await until(() => screen().includes("tool used"));
    expect((await call("POST", `/terminals/${id}/mode`, { mode: "plan" })).status).toBe(409);
    const audit = readFileSync(join(home, "terminals", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.filter((a) => a.action === "mode").map((a) => a.detail.mode)).toEqual(["plan", "plan", "default"]);
    // Another agent chooses on its own screen.
    const codex = (await call("POST", "/terminals", { harness: "codex", cwd })).json.terminal.id as string;
    expect((await call("POST", `/terminals/${codex}/mode`, { mode: "plan" })).status).toBe(400);
  });

  it("a screen changes how hard Claude Code thinks: its own command typed, also while it works; not for an agent with a picker of its own", async () => {
    const { home, cwd, base, token, call } = await start();
    const id = (await call("POST", "/terminals", { harness: "claude-code", cwd, effort: "medium" })).json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    await until(() => screen().includes("fake agent ready"));
    expect((await call("GET", `/terminals/${id}`)).json.terminal.effort).toBe("medium");
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "high" })).json).toEqual({ ok: true });
    await until(() => screen().includes("got: /effort high"));
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "ultra" })).status).toBe(400);
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "high; rm" })).status).toBe(400);
    expect((await call("POST", "/terminals/nope/effort", { effort: "high" })).status).toBe(404);
    // While it works: Claude Code takes it for the next request of the turn.
    expect((await call("POST", `/terminals/${id}/input`, { text: "tool" })).status).toBe(200);
    await until(() => screen().includes("tool used"));
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "max" })).status).toBe(200);
    await until(() => screen().includes("got: /effort max"));
    const audit = readFileSync(join(home, "terminals", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.filter((a) => a.action === "effort").map((a) => a.detail.effort)).toEqual(["high", "max"]);
    const codex = (await call("POST", "/terminals", { harness: "codex", cwd })).json.terminal.id as string;
    expect((await call("POST", `/terminals/${codex}/effort`, { effort: "high" })).status).toBe(400);
    expect((await call("POST", `/terminals/${codex}/model`, { model: "gpt-6-sol" })).status).toBe(400);
  });

  it("pi takes both from a screen too, in its own commands: `/model <provider/id>` and `/thinking <level>`, while it rests", async () => {
    // 2026-10-07, user: codex不能hook掉它的模型选择…其他的agent也是. Seen on pi 0.87.1: "Model: …", "Thinking level: xhigh".
    const { cwd, base, token, call } = await start();
    const id = (await call("POST", "/terminals", { harness: "pi", cwd, effort: "medium" })).json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    const info = async () => (await call("GET", `/terminals/${id}`)).json.terminal as { status: string; effort: string | null; modelNow: string | null };
    await until(() => screen().includes("fake agent ready"));
    // Its status comes from its output here (no hooks in this test): at rest once it has been quiet.
    await untilAsked(async () => (await info()).status === "idle");
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "xhigh" })).json).toEqual({ ok: true });
    await until(() => screen().includes("got: /thinking xhigh"));
    await untilAsked(async () => (await info()).status === "idle");
    expect((await info()).effort).toBe("xhigh");
    // pi's own levels, not Claude Code's: `off` is one, `ultra` is not.
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "off" })).status).toBe(200);
    await until(() => screen().includes("got: /thinking off"));
    await untilAsked(async () => (await info()).status === "idle");
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "ultra" })).status).toBe(400);
    expect((await call("POST", `/terminals/${id}/model`, { model: "anthropic/claude-haiku-4-5" })).json).toEqual({ ok: true });
    await until(() => screen().includes("/model anthropic/claude-haiku-4-5") || screen().includes("to anthropic/claude-haiku-4-5") || screen().includes("set: anthropic/claude-haiku-4-5"));
    expect((await info()).modelNow).toBe("anthropic/claude-haiku-4-5");
    expect(events.filter((e) => e.event === "model").map((e) => e.data.model)).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("a screen changes the agent's model: its own command typed, Claude Code's question skipped for that one change, the new model told (simple-view-v0 §5.4)", async () => {
    const { home, cwd, base, token, call } = await start();
    const id = (await call("POST", "/terminals", { harness: "claude-code", cwd, model: "opus" })).json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    await until(() => screen().includes("fake agent ready"));
    expect((await call("GET", `/terminals/${id}`)).json.terminal).toMatchObject({ model: "opus", modelNow: null });
    // Nothing that reads as a flag or a second command; a terminal that is not there.
    expect((await call("POST", `/terminals/${id}/model`, { model: "--help" })).status).toBe(400);
    expect((await call("POST", `/terminals/${id}/model`, { model: "sonnet; rm -rf" })).status).toBe(400);
    expect((await call("POST", "/terminals/nope/model", { model: "sonnet" })).status).toBe(404);

    // Typed in the terminal itself: Claude Code's own question stands (the hook says nothing).
    expect((await call("POST", `/terminals/${id}/input`, { text: "/model haiku" })).status).toBe(200);
    await until(() => screen().includes("confirm switch to haiku?"));
    expect((await call("GET", `/terminals/${id}`)).json.terminal.modelNow).toBeNull();

    // Asked for by a screen: the command is typed, goes through at once, and the terminal says which model it is on.
    expect((await call("POST", `/terminals/${id}/model`, { model: "sonnet" })).json).toEqual({ ok: true });
    await until(() => screen().includes("model set: sonnet"));
    await until(() => events.some((e) => e.event === "model" && e.data.model === "sonnet"));
    expect((await call("GET", `/terminals/${id}`)).json.terminal).toMatchObject({ model: "opus", modelNow: "sonnet" });
    // The leave is for that one change: the next one typed in the terminal is asked about again.
    expect((await call("POST", `/terminals/${id}/input`, { text: "/model fable" })).status).toBe(200);
    await until(() => screen().includes("confirm switch to fable?"));
    const audit = readFileSync(join(home, "terminals", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.find((a) => a.action === "model")).toMatchObject({ terminal: id, detail: { model: "sonnet" } });

    // While it works the command would wait in its queue as a message: refused. An agent with a picker of its own: refused.
    expect((await call("POST", `/terminals/${id}/input`, { text: "tool" })).status).toBe(200);
    await until(() => screen().includes("tool used"));
    expect((await call("POST", `/terminals/${id}/model`, { model: "opus" })).status).toBe(409);
    const codex = (await call("POST", "/terminals", { harness: "codex", cwd })).json.terminal.id as string;
    expect((await call("POST", `/terminals/${codex}/model`, { model: "gpt-6-luna" })).status).toBe(400);
  });

  it("start, stream, reply, a permission request through the hook answered from the API, audit, delete", async () => {
    const { home, cwd, base, token, call } = await start();
    expect((await call("GET", "/terminals", undefined, false)).status).toBe(401);
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd: "relative/dir" })).status).toBe(400);

    const listed0 = await call("GET", "/terminals");
    expect(listed0.json).toMatchObject({ terminals: [], agents: ["claude-code", "codex", "opencode", "pi"] });
    // Each agent's models for the new terminal's menu, as people say them; pi has no catalog.
    expect(Object.keys(listed0.json.models)).toEqual(["claude-code", "codex", "opencode", "pi"]);
    expect(listed0.json.models.pi).toEqual([]);
    for (const m of Object.values(listed0.json.models).flat() as { id: string; name: string }[]) expect(m.name.length).toBeGreaterThan(0);
    // A model id goes to the agent as `--model <id>`: nothing that reads as a flag.
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd, model: "--dangerously-skip-permissions" })).status).toBe(400);
    expect((await call("GET", "/terminals/style")).json).toHaveProperty("theme.background");
    const created = await call("POST", "/terminals", { harness: "claude-code", cwd, cols: 90, rows: 24 });
    expect(created.status).toBe(201);
    const id = created.json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    await until(() => screen().includes("fake agent ready"));

    // `/` on the phone: this agent's commands in the terminal's folder (a command file of the project's among them).
    mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "commands", "ship.md"), "---\ndescription: Ship it\n---\nbody");
    const commands = (await call("GET", `/terminals/${id}/commands`)).json.commands as { name: string; source: string }[];
    expect(commands).toContainEqual(expect.objectContaining({ name: "ship", source: "project" }));
    expect(commands.some((c) => c.name === "compact" && c.source === "builtin")).toBe(true);
    expect((await call("GET", "/terminals/nope/commands")).status).toBe(404);

    expect((await call("POST", `/terminals/${id}/input`, { text: "hi from the phone" })).status).toBe(200);
    await until(() => screen().includes("got: hi from the phone"));
    // An empty line (⌃C here would really interrupt the agent: the terminal sends it SIGINT).
    expect((await call("POST", `/terminals/${id}/keys`, { keys: ["enter"] })).status).toBe(200);
    expect((await call("POST", `/terminals/${id}/keys`, { keys: ["rm -rf"] })).status).toBe(400);
    expect((await call("POST", `/terminals/${id}/keys`, { keys: ["click:999:2"] })).status).toBe(400);   // outside the screen
    expect((await call("POST", `/terminals/${id}/keys`, { keys: ["click:3:4;rm"] })).status).toBe(400);

    // The hook route takes the terminal's own hook token, never the local one, and not someone else's.
    const forged = await fetch(`${base}/terminals/hook`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id }, body: JSON.stringify({ event: "Stop", payload: {} }) });
    expect(forged.status).toBe(403);

    // "perm": the fake agent runs the real hook command with a PermissionRequest; it waits for a screen's answer.
    await call("POST", `/terminals/${id}/input`, { text: "perm" });
    const asked = await until(() => events.find((e) => e.event === "permission"));
    expect(asked.data.request).toMatchObject({ tool: "Bash", summary: "Bash: rm -rf build" });
    const listed = await call("GET", `/terminals/${id}`);
    expect(listed.json.terminal).toMatchObject({ status: "waiting", agentSessionId: "11111111-2222-3333-4444-555555555555" });
    const pid = asked.data.request.id as string;
    expect((await call("POST", `/terminals/${id}/permissions/${pid}`, { decision: "allow" })).status).toBe(200);
    await until(() => screen().includes("answer: "));
    expect(screen()).toContain('"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}');
    expect((await call("POST", `/terminals/${id}/permissions/${pid}`, { decision: "deny" })).status).toBe(404);
    expect((await call("PATCH", `/terminals/${id}`, { name: "发布前检查" })).json.terminal.name).toBe("发布前检查");

    const audit = readFileSync(join(home, "terminals", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.map((a) => a.action)).toEqual(["create", "input", "keys", "input", "permission", "rename"]);
    expect(audit[1]).toMatchObject({ via: "local", detail: { length: 17 } });
    expect(audit[1].detail).not.toHaveProperty("sealed");   // nothing of a terminal's is sealed (2026-10-08)
    expect(JSON.stringify(audit)).not.toContain("hi from the phone");

    expect((await call("DELETE", `/terminals/${id}`)).status).toBe(200);
    await until(() => events.find((e) => e.event === "removed"));
    expect((await call("GET", `/terminals/${id}`)).status).toBe(404);
  });

  it("the hook program waits with node's plain HTTP request: its fetch gives up after five minutes, whatever it is told (2026-10-08)", () => {
    // Measured on the service's node (24.21): fetch → UND_ERR_HEADERS_TIMEOUT after 301 s under AbortSignal.timeout(29 min);
    // the same program with http.request held a 330 s wait and printed the answer. A card that waited five minutes
    // was dropped: the program ended with nothing, the agent asked in its terminal, the service took the card away.
    const source = readFileSync(HOOK_SCRIPT, "utf8");
    expect(source).toContain('import { request } from "node:http"');
    expect(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).not.toMatch(/\bfetch\s*\(/);
  });

  it("a question through the real hook command: answered from the API, checked, Other's words as written, never in the audit", async () => {
    // A terminal is not behind the credential gate (docs/profiles-v0.md §8, 2026-10-08): the service's sealer, there for
    // Dispatch, is never asked about what is typed into a terminal — not even when an older screen says `seal`.
    const TOKEN = "enc:v1:" + "Q".repeat(40);
    let sealerAsked = 0;
    const sealer: Sealer = async (t) => { sealerAsked += 1; return { ok: true, text: t.split("hunter2").join(TOKEN), sealed: [], ms: 1 }; };
    const { home, cwd, base, token, call } = await start(undefined, sealer);
    const id = (await call("POST", "/terminals", { harness: "claude-code", cwd })).json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    await until(() => screen().includes("fake agent ready"));
    await call("POST", `/terminals/${id}/input`, { text: "ask" });
    const asked = await until(() => events.find((e) => e.event === "permission"));
    expect(asked.data.request).toMatchObject({ tool: "AskUserQuestion", summary: "日期格式化用哪个库？ · 发布前跑哪些检查？" });
    expect(asked.data.request.questions.map((q: { header: string }) => q.header)).toEqual(["Library", "Checks"]);
    const pid = asked.data.request.id as string;
    const answer = (body: unknown) => call("POST", `/terminals/${id}/permissions/${pid}`, body);
    // What an older screen's [ allow ] sends: refused with a reason (it would answer nothing), the request stays.
    expect(await answer({ decision: "allow" })).toMatchObject({ status: 400, json: { error: expect.stringContaining("提问") } });
    expect((await answer({ decision: "allow", answers: { "日期格式化用哪个库？": { labels: ["Moment"] } } })).status).toBe(400);
    expect((await answer({ decision: "allow", answers: { "别的问题？": { labels: ["Luxon"] } } })).status).toBe(400);
    expect((await call("GET", `/terminals/${id}`)).json.terminal.permissions).toHaveLength(1);
    const ok = await answer({ decision: "allow", seal: true, answers: { "日期格式化用哪个库？": { labels: ["Luxon"] }, "发布前跑哪些检查？": { labels: ["单元测试"], other: "先连 db（密码 hunter2）跑迁移" } } });
    expect(ok).toEqual({ status: 200, json: { ok: true, sealed: 0 } });
    await until(() => screen().includes("answer: "));
    const said = JSON.parse(screen().split("answer: ")[1]!.split("\r\n")[0]!.replace(/\r?\n/g, ""));
    expect(said.hookSpecificOutput.decision).toMatchObject({ behavior: "allow", updatedInput: {
      questions: [expect.objectContaining({ question: "日期格式化用哪个库？" }), expect.objectContaining({ question: "发布前跑哪些检查？" })],
      answers: { "日期格式化用哪个库？": "Luxon", "发布前跑哪些检查？": "单元测试, 先连 db（密码 hunter2）跑迁移" },
    } });
    expect(sealerAsked).toBe(0);
    expect(screen()).not.toContain(TOKEN);
    expect((await answer({ decision: "deny" })).status).toBe(404);
    const audit = readFileSync(join(home, "terminals", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.filter((a) => a.action === "permission")).toEqual([expect.objectContaining({ detail: { decision: "allow", tool: "AskUserQuestion" } })]);
    expect(JSON.stringify(audit)).not.toMatch(/Luxon|单元测试|hunter2/);
  });

  it("attaches a file: staged, moved out of the project, its path pasted into the prompt without sending; gone with the terminal", async () => {
    const { base, token, call } = await start();
    const created = await call("POST", "/terminals", { harness: "claude-code", cwd: tmpdir() });
    const id = created.json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    await until(() => screen().includes("fake agent ready"));
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "my shot.png");
    const staged = await (await fetch(`${base}/uploads`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form })).json() as { files: { id: string }[] };
    expect((await call("POST", `/terminals/${id}/attach`, { uploads: ["nope-nope-nop"] })).status).toBe(400);
    const attached = await call("POST", `/terminals/${id}/attach`, { uploads: [staged.files[0]!.id] });
    expect(attached.status).toBe(200);
    const file = attached.json.files[0] as { name: string; path: string };
    expect(file.name).toBe("my-shot.png");
    expect(file.path).toBe(join(tmpdir(), "agentswitch-attach", id, "my-shot.png"));
    expect(existsSync(file.path)).toBe(true);
    await until(() => screen().includes("my-shot.png"));
    expect(screen()).not.toContain("got: ");   // pasted, not sent
    expect((await call("DELETE", `/terminals/${id}`)).status).toBe(200);
    expect(existsSync(join(tmpdir(), "agentswitch-attach", id))).toBe(false);
  });

  // 2026-09-30, user: 图片只能插入到消息开头，选了直接发送……要和 cc 一样，给占位符，发送时按我输入的预期发过去.
  it("a reply with files where the user put them: text and each file's path pasted in order, then Enter", async () => {
    const { base, token, call } = await start();
    const created = await call("POST", "/terminals", { harness: "claude-code", cwd: tmpdir() });
    const id = created.json.terminal.id as string;
    const events = follow(base, token, id);
    const screen = () => events.filter((e) => e.event === "snapshot" || e.event === "output").map((e) => e.data.data).join("");
    await until(() => screen().includes("fake agent ready"));
    const stage = async (name: string) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), name);
      return ((await (await fetch(`${base}/uploads`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form })).json()) as { files: { id: string }[] }).files[0]!.id;
    };
    const shot = await stage("shot.png"), dropped = await stage("dropped.png");
    const sent = await call("POST", `/terminals/${id}/input`, {
      text: "看这张 [Image #1] 哪里不对 [File #9]", seal: false,
      attachments: [{ token: "[Image #1]", upload: shot }, { token: "[Image #2]", upload: dropped }],
    });
    expect(sent.json).toMatchObject({ ok: true, attached: 1 });
    const path = join(tmpdir(), "agentswitch-attach", id, "shot.png");
    await until(() => screen().includes(`got: 看这张 ${path} 哪里不对 [File #9]`));
    expect(existsSync(join(tmpdir(), "agentswitch-attach", id, "dropped.png"))).toBe(false);   // its placeholder was deleted
    expect((await call("POST", `/terminals/${id}/input`, { text: "x", attachments: [{ token: "[Image #1] rm", upload: shot }] })).status).toBe(400);

    // A file already on this Mac, by where it is (the Mac app's reply box, 2026-10-07): not copied, its path typed as a
    // terminal types a dropped file — one word, whatever is in its name. One staged and one by its path in one reply.
    const here = mkdtempSync(join(tmpdir(), "agentswitch-local files-"));
    const local = join(here, "屏幕截图 (2).png");
    writeFileSync(local, "png");
    const pasted = await stage("pasted.png");
    const both = await call("POST", `/terminals/${id}/input`, {
      text: "对比 [Image #1] 和 [Image #2]", seal: false,
      attachments: [{ token: "[Image #1]", path: local }, { token: "[Image #2]", upload: pasted }],
    });
    expect(both.json).toMatchObject({ ok: true, attached: 2 });
    const typed = local.replace(/[ ()]/g, "\\$&");
    await until(() => screen().includes(`got: 对比 ${typed} 和 ${join(tmpdir(), "agentswitch-attach", id, "pasted.png")}`));
    expect(existsSync(local)).toBe(true);
    // A folder dragged in: its path, as a terminal types it.
    expect((await call("POST", `/terminals/${id}/input`, { text: "在 [File #1] 里找", seal: false, attachments: [{ token: "[File #1]", path: here }] })).json).toMatchObject({ ok: true, attached: 1 });
    await until(() => screen().includes(`got: 在 ${here.replace(/ /g, "\\ ")} 里找`));
    // Not there, not absolute, a line hidden in it, both ways at once, neither.
    for (const attachment of [{ token: "[File #1]", path: join(here, "gone.txt") }, { token: "[File #1]", path: "relative.txt" },
      { token: "[File #1]", path: `${local}\nrm -rf ~` }, { token: "[File #1]", path: local, upload: shot }, { token: "[File #1]" }]) {
      expect((await call("POST", `/terminals/${id}/input`, { text: "看 [File #1]", seal: false, attachments: [attachment] })).status, JSON.stringify(attachment)).toBe(400);
    }
    expect((await call("DELETE", `/terminals/${id}`)).status).toBe(200);
  });

  it("a terminal opens in any folder, the home folder too, and reads the local token; tasks keep their rules (2026-09-30)", async () => {
    const { home, call, daemon } = await start();
    const created = await call("POST", "/terminals", { harness: "claude-code", cwd: "~" });
    expect(created.status).toBe(201);
    expect(created.json.terminal.cwd).toBe(homedir());
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd: join(home, "no-such-folder") })).status).toBe(400);
    const host = daemon.terminals!;
    const id = created.json.terminal.id as string;
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(id)!.hookToken;
    const pre = (tool: string, input: Record<string, unknown>) => host.hook(id, token, { event: "PreToolUse", payload: { tool_name: tool, tool_input: input } });
    expect(await pre("Bash", { command: `cat "${join(home, "local-token")}"` })).toBeNull();
    expect(await pre("Edit", { file_path: join(home, "CONTEXT.md") })).toBeNull();
    expect(await pre("Read", { file_path: join(home, "browser-profiles", "slot-1", "Cookies") })).toBeNull();
    const gate = process.env.SECRET_GATE_HOME ?? join(homedir(), ".secret-gate");
    expect(await pre("Read", { file_path: join(gate, "keys", "default.key") })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("git status for the tree's folders only, looked at again after the agent's tool call there (2026-09-30)", async () => {
    const { cwd, call, daemon } = await start();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
    writeFileSync(join(cwd, "a.txt"), "a");
    const created = await call("POST", "/terminals", { harness: "claude-code", cwd });
    const at = created.json.terminal.cwd as string;
    const first = await call("GET", "/folders/git");
    expect(first.json.folders).toEqual({ [at]: { branch: "main", changed: 1, ahead: 0, behind: 0 } });
    // A path the caller names is not looked at: the route takes none.
    expect(Object.keys((await call("GET", `/folders/git?path=${encodeURIComponent(tmpdir())}`)).json.folders)).toEqual([at]);
    writeFileSync(join(cwd, "b.txt"), "b");
    const host = daemon.terminals!;
    const id = created.json.terminal.id as string;
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(id)!.hookToken;
    await host.hook(id, token, { event: "PostToolUse", payload: { tool_name: "Write", tool_input: { file_path: join(cwd, "b.txt") } } });
    let changed = 0;
    for (let i = 0; i < 50 && changed !== 2; i++) {
      changed = (await call("GET", "/folders/git")).json.folders[at]?.changed;
      if (changed !== 2) await new Promise((r) => setTimeout(r, 20));
    }
    expect(changed).toBe(2);
  });

  it("bypass can be chosen from a paired device too (the phone asks first); every terminal may switch to it later", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-terminals-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-terminal-cwd-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const daemon = buildDaemon(cfg, { terminalLauncher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => daemon.close());
    const post = (body: unknown, env?: object) => daemon.api.request("/terminals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
    const fromPhone = await post({ harness: "claude-code", cwd, mode: "bypass" }, markRemote({}, { deviceId: "phone" }));
    expect(fromPhone.status).toBe(201);
    expect(((await fromPhone.json()) as { terminal: { mode: string } }).terminal.mode).toBe("bypass");
    const fromMac = await post({ harness: "claude-code", cwd, mode: "bypass" });
    expect(((await fromMac.json()) as { terminal: { mode: string } }).terminal.mode).toBe("bypass");
  });

  it("says whether a record's entry is the reply that was sent: by when and by its first words (2026-10-08)", () => {
    const reply = { id: "r1", text: "把重试次数改成 3，然后把所有测试跑一遍，失败的列出来", at: 100_000, files: 0 };
    const user = (ts: number, text: string): RecordItem => ({ type: "user", id: `u${ts}`, ts, text });
    expect(holdsReply([user(100_400, reply.text)], reply)).toBe(true);
    expect(holdsReply([user(98_500, reply.text)], reply)).toBe(true);    // the two clocks' rounding
    expect(holdsReply([user(90_000, reply.text)], reply)).toBe(false);   // the same words said before: not this one
    expect(holdsReply([user(100_400, "把重试次数改成 3，然后把所有测试跑一遍，失败的…")], reply)).toBe(true);   // cut short in the record
    expect(holdsReply([user(100_400, "  第一行\n\n第二行 ")], { ...reply, text: "第一行\n第二行" })).toBe(true);   // however its blank space is kept
    expect(holdsReply([user(100_400, "另一句话")], reply)).toBe(false);
    expect(holdsReply([{ type: "answer", id: "a", ts: 100_400, text: reply.text }], reply)).toBe(false);
    // One that went with files reads otherwise in the record: the time decides.
    expect(holdsReply([user(100_400, "看这张 [Image #1]")], { ...reply, text: "看这张 /tmp/a.png", files: 1 })).toBe(true);
    expect(holdsReply([user(90_000, "看这张 [Image #1]")], { ...reply, files: 1 })).toBe(false);
  });

  it("shows what was sent on the record's screens, over the API: on the terminal, in the stream, typed without entering not (2026-10-08)", async () => {
    const { cwd, base, token, call } = await start();
    const id = (await call("POST", "/terminals", { harness: "claude-code", cwd })).json.terminal.id as string;
    const terminal = follow(base, token, id);
    const record = follow(base, token, id, "?view=record");
    await until(() => terminal.some((e) => e.event === "snapshot" && String(e.data.data).includes("fake agent ready")) || terminal.some((e) => e.event === "output" && String(e.data.data).includes("fake agent ready")));
    expect((await call("POST", `/terminals/${id}/input`, { text: "half a thought", submit: false, seal: false })).status).toBe(200);
    expect((await call("GET", `/terminals/${id}`)).json.terminal.sent).toEqual([]);
    expect((await call("POST", `/terminals/${id}/input`, { text: "hello there", seal: false })).status).toBe(200);
    const sent = (await call("GET", `/terminals/${id}`)).json.terminal.sent as { text: string; files: number }[];
    expect(sent.map((r) => [r.text, r.files])).toEqual([["hello there", 0]]);
    await until(() => record.some((e) => e.event === "sent"));
    expect(record.find((e) => e.event === "sent")!.data.replies).toMatchObject([{ text: "hello there" }]);
    expect(terminal.some((e) => e.event === "sent" || e.event === "progress")).toBe(false);   // a screen that draws the terminal sees it typed there
    // A screen that opens later is told what is still waiting.
    const late = follow(base, token, id, "?view=record");
    await until(() => late.some((e) => e.event === "sent"));
    expect(late.find((e) => e.event === "sent")!.data.replies).toMatchObject([{ text: "hello there" }]);
  });

  it("a reply is typed as written, whatever an older screen asks for: nothing of a terminal's goes through the sealer", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-terminals-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-terminal-cwd-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const TOKEN = "enc:v1:" + "S".repeat(40);
    let sealerAsked = 0;
    const sealer: Sealer = async (text) => { sealerAsked += 1; return { ok: true, text: text.split("hunter2").join(TOKEN), sealed: [], ms: 1 }; };
    const daemon = buildDaemon(cfg, { terminalLauncher: fakeLauncher(() => "http://127.0.0.1:9", false), sealer });
    closers.push(() => daemon.close());
    const req = (path: string, body: unknown) => daemon.api.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, markRemote({}, { deviceId: "phone" }));
    const created = (await (await req("/terminals", { harness: "codex", cwd })).json()) as { terminal: { id: string } };
    const id = created.terminal.id;
    const events: TerminalEvent[] = [];
    daemon.terminals!.subscribe(id, null, (e) => events.push(e));
    await until(() => text(events).includes("fake agent ready"));
    // Until 2026-10-08 this went through the sealer (the default); an older phone still says `seal`, which is not read.
    expect(await (await req(`/terminals/${id}/input`, { text: "pw hunter2" })).json()).toEqual({ ok: true, sealed: 0, attached: 0 });
    expect(await (await req(`/terminals/${id}/input`, { text: "again hunter2", seal: true })).json()).toEqual({ ok: true, sealed: 0, attached: 0 });
    // A phone sends its files; it does not point at the Mac's.
    writeFileSync(join(cwd, "notes.txt"), "x");
    expect((await req(`/terminals/${id}/input`, { text: "看 [File #1]", seal: false, attachments: [{ token: "[File #1]", path: join(cwd, "notes.txt") }] })).status).toBe(403);
    await until(() => text(events).includes("got: pw hunter2") && text(events).includes("got: again hunter2"));
    expect(await (await req(`/terminals/${id}/input`, { text: "ls -la", seal: false })).json()).toEqual({ ok: true, sealed: 0, attached: 0 });
    await until(() => text(events).includes("got: ls -la"));
    expect(sealerAsked).toBe(0);
    expect(text(events)).not.toContain(TOKEN);
  });

  it("continues a session in place, once: the same terminal again, a session open elsewhere refused unless forked", async () => {
    const asked: string[] = [];
    const { cwd, call } = await start(async (harness, id) => {
      asked.push(`${harness}:${id}`);
      return id === "busy" ? { pid: 4242, app: "iTerm2" } : null;
    });
    const first = await call("POST", "/terminals/resume", { harness: "claude-code", cwd, agentSessionId: "s-1", title: "发布前检查" });
    expect(first.status).toBe(201);
    expect(first.json.terminal).toMatchObject({ resumedFrom: "s-1", agentSessionId: "s-1", forked: false, name: "发布前检查" });
    // Already open here: that terminal, not a second writer.
    const again = await call("POST", "/terminals/resume", { harness: "claude-code", cwd, agentSessionId: "s-1" });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, terminal: { id: first.json.terminal.id } });
    expect(asked).toEqual(["claude-code:s-1"]);

    const busy = await call("POST", "/terminals/resume", { harness: "codex", cwd, agentSessionId: "busy" });
    expect(busy.status).toBe(409);
    expect(busy.json).toMatchObject({ error: "会话正在iTerm2中运行", elsewhere: { pid: 4242, app: "iTerm2" } });
    const forked = await call("POST", "/terminals/resume", { harness: "codex", cwd, agentSessionId: "busy", fork: true });
    expect(forked.status).toBe(201);
    expect(forked.json.terminal).toMatchObject({ resumedFrom: "busy", forked: true, agentSessionId: null });

    // A session id goes after `--resume`: nothing that reads as a flag; no fork or resume an agent cannot do.
    expect((await call("POST", "/terminals/resume", { harness: "claude-code", cwd, agentSessionId: "--dangerously-skip-permissions" })).status).toBe(400);
    expect((await call("POST", "/terminals/resume", { harness: "opencode", cwd, agentSessionId: "ses_1", fork: true })).status).toBe(400);
    expect((await call("POST", "/terminals/resume", { harness: "pi", cwd, agentSessionId: "p-1" })).status).toBe(400);
    // `dir/` and `dir` are one folder.
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd: `${cwd}/` })).json.terminal.cwd).toBe(cwd);

    // Closing the terminal that went on writing the original never deletes the original.
    expect((await call("DELETE", `/terminals/${first.json.terminal.id}?transcript=1`)).status).toBe(409);
    expect((await call("DELETE", `/terminals/${first.json.terminal.id}`)).status).toBe(200);
  });

  // 2026-10-03, user: 如果会话没了选择新目录继续.
  it("says a session's folder is gone apart from other refusals, with where it may be now", async () => {
    const { cwd, call } = await start(async () => null);
    const there = join(cwd, "Projects", "proj");
    mkdirSync(there, { recursive: true });
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd: there })).status).toBe(201);
    const gone = join(cwd, "Worktop", "proj");
    const res = await call("POST", "/terminals/resume", { harness: "claude-code", cwd: gone, agentSessionId: "s-9" });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ folderGone: gone, near: cwd, alike: [there] });
    // A new terminal in a missing folder is the plain refusal it was.
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd: gone })).status).toBe(400);
    // Picked a folder that is there: it goes on in it.
    const moved = await call("POST", "/terminals/resume", { harness: "claude-code", cwd: there, agentSessionId: "s-9" });
    expect(moved.status).toBe(201);
    expect(moved.json.terminal).toMatchObject({ cwd: there, resumedFrom: "s-9" });
    // Asked again from a list read before the move: the terminal it is open in, not the folder question.
    const again = await call("POST", "/terminals/resume", { harness: "claude-code", cwd: gone, agentSessionId: "s-9" });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, terminal: { id: moved.json.terminal.id } });
    // What an agent cannot do is said first.
    expect((await call("POST", "/terminals/resume", { harness: "pi", cwd: gone, agentSessionId: "p-1" })).status).toBe(400);
  });

  it("a permission request nobody answers ends with no decision when the terminal goes", async () => {
    const { cwd, base, token, call } = await start();
    const id = (await call("POST", "/terminals", { harness: "claude-code", cwd })).json.terminal.id as string;
    const events = follow(base, token, id);
    await until(() => events.find((e) => e.event === "snapshot" || e.event === "output"));
    await call("POST", `/terminals/${id}/input`, { text: "perm" });
    await until(() => events.find((e) => e.event === "permission"));
    await call("POST", `/terminals/${id}/kill`);
    await until(() => events.find((e) => e.event === "permission_resolved" && e.data.decision === null));
    await until(() => events.find((e) => e.event === "exit"));
  });
});

describe("terminal pieces", () => {
  it("cuts output only between escape sequences", () => {
    expect(safeCut("plain text")).toBe(10);
    expect(safeCut("ab\x1b[27;2H")).toBe(9);
    expect(safeCut("ab\x1b[27;")).toBe(2);
    expect(safeCut("ab\x1b")).toBe(2);
    expect(safeCut("ab\x1b]0;title")).toBe(2);
    expect(safeCut("ab\x1b]0;title\x07cd")).toBe(14);
    expect(safeCut("ab\x1b]0;title\x1b\\")).toBe(13);
    expect(safeCut("ab\x1b]0;tit\x1b")).toBe(2);
    expect(safeCut("x\x1b[1mbold\x1b[")).toBe(9);
    expect(safeCut("ab\x1b(")).toBe(2);
    expect(safeCut("ab\x1b(B")).toBe(5);
    expect(safeCut("ab\x1b7")).toBe(4);
  });

  it("names a terminal: the user's name, else the agent's task title without its status glyphs, else the folder", () => {
    expect(cleanTitle("✳ Claude Code")).toBe("Claude Code");
    expect(cleanTitle("✶  创建 hello.txt 文件")).toBe("创建 hello.txt 文件");
    expect(cleanTitle("⠋ Working")).toBe("Working");
    expect(cleanTitle("[ ! ] Action Required | 查看进程 | Codex")).toBe("查看进程 | Codex");
    expect(cleanTitle("[ . ] Action Required")).toBe("");
    expect(meaningfulTitle("✳ Claude Code", "claude-code")).toBeNull();
    expect(meaningfulTitle("codex", "codex")).toBeNull();
    expect(meaningfulTitle("me@mac: ~/proj", "claude-code")).toBeNull();
    expect(meaningfulTitle("✻ 修复登录页的样式", "claude-code")).toBe("修复登录页的样式");
    expect(terminalName(null, "✳ Claude Code", "claude-code", "/Users/me/Projects/AgentSwitch")).toBe("AgentSwitch");
    expect(terminalName(null, "✻ 修复登录页", "claude-code", "/Users/me/Projects/AgentSwitch")).toBe("修复登录页");
    expect(terminalName("发布前检查", "✻ 修复登录页", "claude-code", "/x")).toBe("发布前检查");
    expect(terminalName(null, "✳ Claude Code", "claude-code", "/x/proj", "接着上次的重构")).toBe("接着上次的重构");
    expect(terminalName(null, "✻ 新任务", "claude-code", "/x/proj", "接着上次的重构")).toBe("新任务");
  });

  it("takes the iTerm2 profile's font, spacing and dark colors", () => {
    expect(parseItermFont("MesloLGS-NF-Regular 15")).toEqual({ families: ["MesloLGS NF", "MesloLGS-NF-Regular"], size: 15 });
    expect(parseItermFont("SFMono-Regular 12.5")).toEqual({ families: ["SF Mono", "SFMono-Regular"], size: 12.5 });
    expect(parseItermFont("nonsense")).toBeNull();
    const c = (r: number, g: number, b: number) => ({ "Red Component": String(r), "Green Component": g, "Blue Component": b });
    const style = styleFromItermProfile({
      "Normal Font": "MesloLGS-NF-Regular 15", "Vertical Spacing": 1, "Horizontal Spacing": 1, "Use Separate Colors for Light and Dark Mode": true,
      "Background Color": c(1, 1, 1), "Background Color (Dark)": c(0, 0, 0), "Foreground Color (Dark)": c(1, 1, 1),
      "Ansi 1 Color (Dark)": c(0.8, 0, 0), "Selection Color (Dark)": c(0.71, 0.835, 1),
    });
    expect(style).toMatchObject({ source: "iterm", fontSize: 15, lineHeight: 1, letterSpacing: 0 });
    expect(style.fontFamily.startsWith('"MesloLGS NF", "MesloLGS-NF-Regular", "SF Mono"')).toBe(true);
    expect(style.theme).toMatchObject({ background: "#000000", foreground: "#ffffff", red: "#cc0000", selectionBackground: "rgba(181,213,255,0.4)", blue: DEFAULT_STYLE.theme.blue });
  });

  it("keys follow the cursor mode; a reply is pasted as one block when the program asks for it", () => {
    const plain = { applicationCursor: false, mouse: "none", sgrMouse: false, alternate: false, cols: 80, rows: 24 } as const;
    expect(keySequence("up", plain)).toBe("\x1b[A");
    expect(keySequence("up", { ...plain, applicationCursor: true })).toBe("\x1bOA");
    expect(keySequence("ctrl-c", plain)).toBe("\x03");
    expect(keySequence("pgup", plain)).toBe("\x1b[5~");
    // The wheel: a mouse report in the middle when the program tracks the mouse, an arrow on a full screen without it,
    // nothing on the normal screen (the screen scrolls its own history).
    expect(keySequence("wheel-up", { ...plain, mouse: "any", sgrMouse: true })).toBe("\x1b[<64;41;13M");
    expect(keySequence("wheel-down", { ...plain, mouse: "vt200" })).toBe("\x1b[M" + String.fromCharCode(32 + 65, 32 + 41, 32 + 13));
    expect(keySequence("wheel-down", { ...plain, alternate: true, applicationCursor: true })).toBe("\x1bOB");
    expect(keySequence("wheel-up", plain)).toBe("");
    // A tap on the phone (2026-09-30, user: 手机上的终端只能滚动，点击操作没透传): a left click on that cell, pressed and
    // released, as the program asked for mouse reports; nothing to one that does not track the mouse.
    expect(keySequence("click:4:2", { ...plain, mouse: "any", sgrMouse: true })).toBe("\x1b[<0;5;3M\x1b[<0;5;3m");
    expect(keySequence("click:4:2", { ...plain, mouse: "vt200" })).toBe("\x1b[M" + String.fromCharCode(32, 37, 35) + "\x1b[M" + String.fromCharCode(35, 37, 35));
    expect(keySequence("click:4:2", { ...plain, mouse: "x10", sgrMouse: true })).toBe("\x1b[<0;5;3M");
    expect(keySequence("click:4:2", plain)).toBe("");
    expect(replyBytes("a\nb", true, true)).toBe("\x1b[200~a\nb\x1b[201~\r");
    expect(replyBytes("a\nb", false, true)).toBe("a\rb\r");
    expect(replyBytes("x\x1b[201~y", true, false)).toBe("\x1b[200~xy\x1b[201~");
  });

  it("launches Claude Code with this terminal's own hooks and Codex with notify; a missing agent cannot start", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-launch-"));
    const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", env: { PATH: "/usr/bin", SECRET_GATE_REPAIR_KEY: "k" } });
    const claude = launch({ id: "t1", harness: "claude-code", cwd: "/tmp", model: "claude-opus-5-5", mode: "manual", hookToken: "tok" });
    expect(claude.args).toEqual(["--settings", join(stateDir, "t1", "settings.json"), "--model", "claude-opus-5-5", "--permission-mode", "manual"]);
    // How hard it thinks, in each agent's own argument (harness/efforts.ts).
    expect(launch({ id: "t9", harness: "claude-code", cwd: "/tmp", model: "opus", effort: "xhigh", mode: "manual", hookToken: "tok" }).args.slice(2))
      .toEqual(["--model", "opus", "--effort", "xhigh", "--permission-mode", "manual"]);
    expect(launch({ id: "t10", harness: "codex", cwd: "/tmp", model: "gpt-6-sol", effort: "high", mode: "bypass", hookToken: "tok" }).args.join(" ")).toContain('-m gpt-6-sol -c model_reasoning_effort="high"');
    expect(launch({ id: "t5", harness: "claude-code", cwd: "/tmp", mode: "auto", hookToken: "tok" }).args.slice(-2)).toEqual(["--permission-mode", "auto"]);
    expect(launch({ id: "t6", harness: "claude-code", cwd: "/tmp", mode: "bypass", hookToken: "tok" }).args.slice(-1)).toEqual(["--dangerously-skip-permissions"]);
    expect(launch({ id: "t8", harness: "claude-code", cwd: "/tmp", mode: "auto", allowBypass: true, hookToken: "tok" }).args.slice(-3)).toEqual(["--permission-mode", "auto", "--allow-dangerously-skip-permissions"]);
    expect(launch({ id: "t7", harness: "codex", cwd: "/tmp", mode: "bypass", hookToken: "tok" }).args).toContain("--dangerously-bypass-approvals-and-sandbox");
    // asking is stated, not left to the user's config.toml
    expect(launch({ id: "t8", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok" }).args.join(" ")).toContain('-a on-request -c default_permissions="agentswitch" -c permissions.agentswitch={ extends = ":read-only", filesystem = {} }');
    expect(claude.env).toMatchObject({ AGENTSWITCH_TERMINAL_ID: "t1", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "tok", AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:4711", TERM: "xterm-256color" });
    expect(claude.env.SECRET_GATE_REPAIR_KEY).toBeUndefined();
    const settings = JSON.parse(readFileSync(join(stateDir, "t1", "settings.json"), "utf8"));
    expect(settings).toEqual(claudeHookSettings('"/n/node" "/h/hook.js"'));
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(1800);
    // "Continue" goes on in the same session; a fork only when asked for.
    const codex = launch({ id: "t2", harness: "codex", cwd: "/tmp", resume: "abc", mode: "manual", hookToken: "tok" });
    expect(codex.args).toEqual(["resume", "-C", "/tmp", "abc", "-c", 'notify=["/n/node","/h/hook.js","codex"]', ...CODEX_ATTENTION, "-a", "on-request", "-c", 'default_permissions="agentswitch"', "-c", 'permissions.agentswitch={ extends = ":read-only", filesystem = {} }']);
    // The terminal's folder is named (`-C`): Codex does not ask whether to use the one the session ran in, which may be
    // gone (docs/terminal-v0.md §5).
    expect(launch({ id: "t9", harness: "codex", cwd: "/tmp", resume: "abc", fork: true, mode: "manual", hookToken: "tok" }).args.slice(0, 4)).toEqual(["fork", "-C", "/tmp", "abc"]);
    expect(launch({ id: "t4", harness: "claude-code", cwd: "/tmp", resume: "s-1", mode: "manual", hookToken: "tok" }).args.slice(-2)).toEqual(["--resume", "s-1"]);
    expect(launch({ id: "t10", harness: "claude-code", cwd: "/tmp", resume: "s-1", fork: true, mode: "manual", hookToken: "tok" }).args.slice(-3)).toEqual(["--resume", "s-1", "--fork-session"]);
    expect(() => launch({ id: "t3", harness: "pi", cwd: "/tmp", mode: "manual", hookToken: "tok" })).toThrow(/not installed/);
    // Codex's Daybreak switch (docs/simple-view-v0.md §5.8): the feature it is kept under, for a terminal started
    // where Codex and the account have it — and its companion then says how the switch stands. Otherwise neither.
    expect(codex.args.join(" ")).not.toContain("cli_daybreak");
    const offered = agentLauncher({ binaries: { codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", env: { PATH: "/usr/bin" }, codexServer: true, codexDaybreak: () => true });
    const withSwitch = offered({ id: "t11", harness: "codex", cwd: "/tmp", resume: "abc", mode: "manual", hookToken: "tok" });
    expect(withSwitch.args.join(" ")).toContain("-c features.cli_daybreak=true");
    expect(withSwitch.args.slice(0, 4)).toEqual(["resume", "-C", "/tmp", "abc"]);
    expect(withSwitch.companion?.daybreak).toBeTypeOf("function");
    const without = agentLauncher({ binaries: { codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", env: { PATH: "/usr/bin" }, codexServer: true, codexDaybreak: () => false });
    expect(without({ id: "t12", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok" }).companion?.daybreak).toBeUndefined();
  });

  it("refuses the protected paths each agent's own way: Claude's deny rules, Codex's profile, OpenCode's config, pi's extension", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-launch-"));
    const prot = { roots: ["/as/home", "/as/gate"], exempt: [], readDenied: ["/as/gate", "/as/home/local-token"] };
    const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex", opencode: "/bin/opencode", pi: "/bin/pi" }, protected: prot,
      hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", piExtension: "/h/pi.ts", env: { PATH: "/usr/bin", HOME: "/Users/u" } });
    // Claude Code: its own deny rules besides the PreToolUse floor ("//" = from the filesystem root).
    launch({ id: "c1", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    const settings = JSON.parse(readFileSync(join(stateDir, "c1", "settings.json"), "utf8"));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(//as/home/local-token)", "Read(//as/gate/**)", "Edit(//as/home/**)"]));
    // Codex: a profile its sandbox enforces. No proxy of the gate, for Codex or for the commands it runs (2026-10-08).
    const codex = launch({ id: "x1", harness: "codex", cwd: "/tmp", mode: "auto", hookToken: "tok" });
    expect(codex.args).toContain('permissions.agentswitch={ extends = ":workspace", filesystem = { "/as/home" = "read", "/as/gate" = "deny", "/as/home/local-token" = "deny" } }');
    // With its hooks the reads are the PreToolUse floor's: a deny entry would keep an approved command sandboxed.
    const hooked = agentLauncher({ binaries: { codex: "/bin/codex" }, protected: prot, hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", env: {}, codexHooks: () => true });
    expect(hooked({ id: "x2", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok" }).args).toContain('permissions.agentswitch={ extends = ":read-only", filesystem = { "/as/home" = "read", "/as/gate" = "read" } }');
    expect(codex.args).not.toContain("-s");
    expect(codex.args.find((a) => a.startsWith("shell_environment_policy"))).toBeUndefined();
    expect(codex.env.HTTPS_PROXY).toBeUndefined();
    expect(codex.env.AGENTSWITCH_TERMINAL_ID).toBe("x1");
    // OpenCode: only refusals, the user's other permission settings untouched.
    const opencode = launch({ id: "o1", harness: "opencode", cwd: "/tmp", mode: "auto", hookToken: "tok" });
    expect(opencode.env.OPENCODE_CONFIG).toBe(join(stateDir, "o1", "opencode.json"));
    expect(opencode.args[0]).toBe("--standalone");   // not the user's shared background service, which never sees this env
    const config = JSON.parse(readFileSync(opencode.env.OPENCODE_CONFIG!, "utf8"));
    expect(config.permission.read).toMatchObject({ "/as/home/local-token": "deny", "/as/gate/*": "deny" });
    expect(config.permission.bash).toMatchObject({ "*/as/home*": "deny", "*/as/gate*": "deny" });   // a root covers what is in it
    expect(Object.values(config.permission).flatMap((rules) => Object.values(rules as object))).not.toContain("allow");
    // pi: AgentSwitch's extension, which also gives the status.
    const pi = launch({ id: "p1", harness: "pi", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(pi.args.slice(0, 2)).toEqual(["--extension", "/h/pi.ts"]);
    expect(pi.hooks).toBe(true);
  });

  it("checks pi's tool calls against the floor under Claude Code's names; its agent start and end give the status", async () => {
    const floor = (tool: string, input: Record<string, unknown>) =>
      (String(input.file_path ?? input.path ?? input.command ?? "").includes("local-token") ? `denied ${tool}` : null);
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), floor });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "pi", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const tool = (name: string, input: object) => host.hook(info.id, token, { event: "PiToolCall", payload: { tool: name, input } });
    expect(await tool("read", { path: "/x/local-token" })).toEqual({ block: true, reason: "denied Read" });
    expect(await tool("write", { path: "/x/local-token", content: "" })).toEqual({ block: true, reason: "denied Write" });
    expect(await tool("bash", { command: "cat /x/local-token" })).toEqual({ block: true, reason: "denied Bash" });
    expect(await tool("ls", { path: "/x" })).toBeNull();
    expect(piTool("edit", { path: "/a" })).toEqual({ tool: "Edit", input: { path: "/a", file_path: "/a" } });
    expect(piTool("find", { path: "/a", pattern: "*.ts" }).tool).toBe("Glob");
    await host.hook(info.id, token, { event: "PiAgentEnd", payload: {} });
    expect(host.get(info.id)!.status).toBe("idle");
    await host.hook(info.id, token, { event: "PiAgentStart", payload: {} });
    expect(host.get(info.id)!.status).toBe("working");
    await host.hook(info.id, token, { event: "PiWaiting", payload: {} });
    expect(host.get(info.id)!.status).toBe("waiting");
    await host.hook(info.id, token, { event: "PiAgentStart", payload: {} });
    expect(host.get(info.id)!.status).toBe("working");
  });

  it("pi's extension blocks what the service refuses, and everything when the service does not answer", async () => {
    const { default: extension } = await import("../src/terminals/piExtension.js");
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
    extension({ on: (event, handler) => handlers.set(event, handler) });
    const calls: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        calls.push({ auth: req.headers.authorization, terminal: req.headers["x-agentswitch-terminal"], ...JSON.parse(body) });
        const refused = JSON.stringify(JSON.parse(body).payload?.input ?? {}).includes("local-token");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ output: refused ? { block: true, reason: "受保护" } : null }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    const saved = { ...process.env };
    closers.push(() => { process.env = saved; });
    Object.assign(process.env, { AGENTSWITCH_TERMINAL_URL: `http://127.0.0.1:${port}`, AGENTSWITCH_TERMINAL_ID: "p1", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "tok" });
    const toolCall = handlers.get("tool_call")!;
    expect(await toolCall({ toolName: "read", input: { path: "/x/local-token" } })).toEqual({ block: true, reason: "受保护" });
    expect(await toolCall({ toolName: "read", input: { path: "/x/readme" } })).toBeUndefined();
    expect(calls[0]).toMatchObject({ auth: "Bearer tok", terminal: "p1", event: "PiToolCall", payload: { tool: "read" } });
    process.env.AGENTSWITCH_TERMINAL_URL = "http://127.0.0.1:9";   // nothing listens there
    expect(await toolCall({ toolName: "read", input: { path: "/x/readme" } })).toMatchObject({ block: true });
  });

  it("finds a session open in another program, and the app it runs in; not one of ours, not a stale entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-elsewhere-"));
    const sessions = join(home, ".claude", "sessions");
    const locks = join(home, ".codex", "thread-writer-locks");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(locks, { recursive: true });
    const entry = (pid: number, sessionId: string) => writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: "/w", kind: "interactive" }));
    entry(100, "in-iterm");
    entry(200, "in-ours");
    entry(300, "gone");
    entry(400, "reused");
    writeFileSync(join(locks, "thread-1.lock"), "");
    const table = new Map<number, Proc>([
      [100, { ppid: 90, comm: "claude" }], [90, { ppid: 80, comm: "-zsh" }], [80, { ppid: 70, comm: "/Users/u/Library/Application Support/iTerm2/iTermServer-3.7.3" }],
      [70, { ppid: 1, comm: "/Applications/iTerm.app/Contents/MacOS/iTerm2" }],
      [200, { ppid: 210, comm: "/Users/u/.local/bin/claude" }], [210, { ppid: 1, comm: "node" }],
      [400, { ppid: 1, comm: "/Applications/Safari.app/Contents/MacOS/Safari" }],
      [500, { ppid: 510, comm: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" }],
      [510, { ppid: 1, comm: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }],
    ]);
    const check = elsewhereCheck({
      home, processes: async () => table, alive: (pid) => pid !== 300,
      holders: async (file) => (file.endsWith("thread-1.lock") ? [500] : []),
      appName: async (bundle) => ({ "/Applications/iTerm.app": "iTerm2" } as Record<string, string>)[bundle] ?? null,
    });
    expect(await check("claude-code", "in-iterm", [])).toEqual({ pid: 100, app: "iTerm2" });
    expect(await check("claude-code", "in-ours", [210])).toBeNull();          // our terminal's process tree
    expect(await check("claude-code", "gone", [])).toBeNull();                // exited without removing its entry
    expect(await check("claude-code", "reused", [])).toBeNull();              // its pid now belongs to another program
    expect(await check("claude-code", "nobody", [])).toBeNull();
    expect(await check("codex", "thread-1", [])).toEqual({ pid: 500, app: "ChatGPT" });   // Codex's desktop app holds its lock
    expect(await check("codex", "thread-2", [])).toBeNull();
    expect(await check("opencode", "in-iterm", [])).toBeNull();
  });

  it("drops the markers of a Claude Code session the service was started from, keeps the user's own settings", () => {
    expect(withoutParentSession({ CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_PID: "9",
      ANTHROPIC_BASE_URL: "http://x", CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/usr/bin" }))
      .toEqual({ ANTHROPIC_BASE_URL: "http://x", CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/usr/bin" });
  });

  it("the phone gets every terminal route but the hook and raw keystrokes", () => {
    expect(remoteAllowed("GET", "/terminals")).toBe(true);
    expect(remoteAllowed("GET", "/terminals/ab12cd34/stream")).toBe(true);
    expect(remoteAllowed("POST", "/terminals/ab12cd34/permissions/p1")).toBe(true);
    expect(remoteAllowed("DELETE", "/terminals/ab12cd34")).toBe(true);
    expect(remoteAllowed("POST", "/terminals/hook")).toBe(false);
    expect(remoteAllowed("POST", "/terminals/ab12cd34/write")).toBe(false);
  });

  it("deletes a Claude Code transcript by its session id only", () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-transcripts-"));
    const dir = join(home, ".claude", "projects", "-Users-me-proj");
    mkdirSync(dir, { recursive: true });
    const id = "11111111-2222-3333-4444-555555555555";
    writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
    writeFileSync(join(dir, "other.jsonl"), "{}\n");
    expect(deleteTranscript("claude-code", "../other", home)).toEqual([]);
    expect(deleteTranscript("codex", id, home)).toEqual([]);
    expect(deleteTranscript("claude-code", id, home)).toEqual([join(dir, `${id}.jsonl`)]);
    expect(existsSync(join(dir, "other.jsonl"))).toBe(true);
  });
});
