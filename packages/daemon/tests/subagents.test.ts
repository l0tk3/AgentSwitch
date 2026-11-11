/** A session's sub-agents and what each did (docs/simple-view-v0.md §5.22, 2026-11-10; user: 当产生子代理的时候点击相关的条目，
 *  我看不到子代理的对话内容): the files Claude Code keeps beside a session's own (seen on 2.1.319), one sub-agent read as
 *  a record, the step that sent it naming it, and the routes. Everything here is written in a temporary folder: no test
 *  reads the user's own sessions. */

import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountSessions } from "../src/api/sessions.js";
import type { ApiDeps } from "../src/api/shared.js";
import { remoteAllowed } from "../src/remote/routes.js";
import { SessionMonitor, type SessionSources } from "../src/sessions/monitor.js";
import { readRecord, readStep, type RecordItem } from "../src/sessions/record.js";
import { listSubagents, subagentFile, subagentOf, subagentsDir, type SubagentSummary } from "../src/sessions/subagents.js";

const REPO = "/Users/u/code/site";
const line = (o: unknown) => JSON.stringify(o);
const at = (s: number) => new Date(Date.parse("2026-11-10T02:00:00Z") + s * 1000).toISOString();

/** The session's own lines, as Claude Code writes them. */
const c = {
  user: (s: number, text: string) => line({ type: "user", cwd: REPO, timestamp: at(s), message: { role: "user", content: text } }),
  text: (s: number, text: string) => line({ type: "assistant", cwd: REPO, timestamp: at(s), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] } }),
  tool: (s: number, id: string, name: string, input: object) => line({ type: "assistant", cwd: REPO, timestamp: at(s), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] } }),
  result: (s: number, id: string, toolUseResult: unknown, more: object = {}) => line({ type: "user", cwd: REPO, timestamp: at(s), toolUseResult, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...more }] } }),
};

/** A sub-agent's own lines: the session's, each marked `isSidechain` and with the agent's id. */
const side = (agent: string) => {
  const mark = { isSidechain: true, agentId: agent, sessionId: "c1", cwd: REPO };
  return {
    task: (s: number, text: string) => line({ ...mark, type: "user", timestamp: at(s), promptId: "p1", message: { role: "user", content: text } }),
    // What the harness tells it beside its task: not part of what it was sent to do.
    meta: (s: number, text: string) => line({ ...mark, type: "user", isMeta: true, timestamp: at(s), message: { role: "user", content: text } }),
    attachment: (s: number) => line({ ...mark, type: "attachment", timestamp: at(s), attachment: { type: "date", text: "2026-11-10" } }),
    request: () => line({ type: "api-request", sessionId: "c1", agentId: agent, message: { role: "assistant", content: [{ type: "text", text: "not a line of the record" }] } }),
    text: (s: number, text: string) => line({ ...mark, type: "assistant", timestamp: at(s), message: { role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], usage: { input_tokens: 1200 } } }),
    tool: (s: number, id: string, name: string, input: object) => line({ ...mark, type: "assistant", timestamp: at(s), message: { role: "assistant", model: "claude-haiku-5-5", content: [{ type: "tool_use", id, name, input }] } }),
    result: (s: number, id: string, toolUseResult: unknown, more: object = {}) => line({ ...mark, type: "user", timestamp: at(s), toolUseResult, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...more }] } }),
  };
};

const kinds = (items: readonly RecordItem[]) => items.map((it) => it.type);
const steps = (items: readonly RecordItem[]) => items.flatMap((it) => (it.type === "work" ? it.steps : []));

/** A session `c1` that sent two sub-agents — `a1` ended, `a2` still at work — and where it is kept. */
function session() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-subagents-")));
  const project = join(root, "claude", "-Users-u-code-site");
  mkdirSync(project, { recursive: true });
  const file = join(project, "c1.jsonl");
  writeFileSync(file, [
    c.user(0, "查一下登录为什么慢，顺便看看连接池"),
    c.tool(1, "t1", "Agent", { description: "查登录慢", subagent_type: "Explore", prompt: "<task>查登录接口为什么慢</task>" }),
    c.tool(1, "t2", "Agent", { description: "看连接池", subagent_type: "general-purpose", prompt: "看连接池的配置", run_in_background: true }),
    // One sent to the background says which it is at once; one waited on, when it has ended.
    c.result(2, "t2", { isAsync: true, status: "async_launched", agentId: "a2", description: "看连接池" }),
    c.result(60, "t1", { status: "completed", agentId: "a1", agentType: "Explore", totalDurationMs: 58_000 }),
    c.tool(61, "t3", "Agent", { description: "被拒绝的", subagent_type: "Explore", prompt: "…" }),
    c.result(62, "t3", "The user doesn't want to proceed with this tool use.", { is_error: true, content: "rejected" }),
    c.tool(63, "t4", "Agent", { description: "还没有结果的", subagent_type: "Explore", prompt: "…" }),
  ].join("\n") + "\n");
  const dir = subagentsDir(file);
  mkdirSync(dir, { recursive: true });
  const a1 = side("a1"), a2 = side("a2");
  writeFileSync(join(dir, "agent-a1.jsonl"), [
    a1.task(1, "<task>查登录接口为什么慢</task>"),
    a1.meta(1, "<system-reminder>Use the tools you have.</system-reminder>"),
    a1.attachment(1),
    a1.request(),
    a1.text(2, "先看登录的处理函数。"),
    a1.tool(3, "s1", "Grep", { pattern: "login", path: REPO }),
    a1.result(4, "s1", { numFiles: 2 }),
    a1.tool(5, "s2", "Bash", { command: "time curl -s localhost:8080/login\n  | head -1", description: "Time the login" }),
    a1.result(9, "s2", { stdout: "real 0m2.31s\n", stderr: "", interrupted: false }),
    // It sends one of its own.
    a1.tool(10, "s3", "Agent", { description: "读日志", subagent_type: "Explore", prompt: "读一下慢查询日志" }),
    a1.result(40, "s3", { status: "completed", agentId: "a9" }),
    a1.tool(58, "s4", "SubagentHandback", { message: "登录慢在密码哈希：每次请求都重新派生密钥。\n\n见 `auth/hash.ts:41`。" }),
    a1.result(59, "s4", { ok: true }),
  ].join("\n") + "\n");
  writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", isBuiltIn: true, description: "查登录慢", toolUseId: "t1", spawnDepth: 1, requestShape: "foreground", finished: true }));
  writeFileSync(join(dir, "agent-a2.jsonl"), [
    a2.task(2, "看连接池的配置"),
    a2.tool(3, "s1", "Read", { file_path: `${REPO}/db/pool.ts` }),
    a2.result(4, "s1", { type: "text", file: {} }),
  ].join("\n") + "\n");
  writeFileSync(join(dir, "agent-a2.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "看连接池", toolUseId: "t2", requestShape: "background" }));
  // What is not a sub-agent's file is not listed.
  writeFileSync(join(dir, "notes.txt"), "not one");
  writeFileSync(join(dir, "agent-..jsonl"), "not one either\n");
  // `a1` began first and was written last: the list's order is by when each began, not by when it last wrote. A Mac's
  // disk takes a file's making back to a time it is written at that is earlier (so the first of each pair sets when it
  // began, the second when it last wrote); elsewhere the making is as it was — `a1` first.
  for (const [id, began, wrote] of [["a1", 1, 59], ["a2", 2, 4]] as const) {
    utimesSync(join(dir, `agent-${id}.jsonl`), new Date(at(began)), new Date(at(began)));
    utimesSync(join(dir, `agent-${id}.jsonl`), new Date(at(wrote)), new Date(at(wrote)));
  }
  return { root, file, dir };
}

function served(more: Partial<ApiDeps> = {}, sources: Partial<SessionSources> = {}) {
  const made = session();
  const monitor = new SessionMonitor({ claudeProjects: join(made.root, "claude"), codexSessions: join(made.root, "codex"), opencodeDb: join(made.root, "none.db"), excluded: [], ...sources }, () => Date.parse(at(100)));
  const app = new Hono();
  mountSessions(app, { sessions: monitor, ...more } as unknown as ApiDeps);
  return { ...made, monitor, app };
}

describe("the files Claude Code keeps of a session's sub-agents", () => {
  it("are listed beside the session's own: each its id, its kind, what it was sent to do, whether it has ended", () => {
    const { file, dir } = session();
    expect(dir).toBe(join(file.replace(/\.jsonl$/, ""), "subagents"));
    const all = listSubagents(file);
    // In the order they began, whichever wrote last.
    expect(all.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(all[0]).toMatchObject({ type: "Explore", name: "查登录慢", done: true, updatedAt: Date.parse(at(59)) });
    expect(all[1]).toMatchObject({ type: "general-purpose", name: "看连接池", done: false, updatedAt: Date.parse(at(4)) });
    for (const a of all) expect(a.startedAt).toBeGreaterThan(0);
    expect(subagentOf(file, "a1")).toEqual(all.find((a) => a.id === "a1"));
    // The latest so many of a session that sent a great many.
    expect(listSubagents(file, 1)).toHaveLength(1);
  });

  it("one with nothing written beside it is still listed, by its id alone; a session that sent none has none", () => {
    const { file, dir } = session();
    writeFileSync(join(dir, "agent-a3.jsonl"), side("a3").task(70, "没有说明的") + "\n");
    writeFileSync(join(dir, "agent-a4.jsonl"), side("a4").task(71, "说明不是 JSON 的") + "\n");
    writeFileSync(join(dir, "agent-a4.meta.json"), "{ not json");
    expect(subagentOf(file, "a3")).toMatchObject({ id: "a3", type: "", name: "", done: false });
    expect(subagentOf(file, "a4")).toMatchObject({ id: "a4", type: "", name: "", done: false });
    expect(listSubagents(join(file, "..", "none.jsonl"))).toEqual([]);
    expect(subagentOf(file, "nope")).toBeNull();
  });

  it("never open a file by a name that is not a sub-agent's id", () => {
    const { file, root } = session();
    writeFileSync(join(root, "claude", "-Users-u-code-site", "agent-x.jsonl"), "{}\n");
    for (const id of ["../../agent-x", "a1/../a1", "a1.jsonl", "", ".", "..", "a 1", "a1\n"]) {
      expect(subagentFile(file, id), JSON.stringify(id)).toBeNull();
      expect(subagentOf(file, id), JSON.stringify(id)).toBeNull();
    }
    expect(subagentFile(file, "a1")).toBe(join(subagentsDir(file), "agent-a1.jsonl"));
  });
});

describe("a sub-agent's record", () => {
  it("is what it was sent to do, its work step by step, and what it handed back as its answer", () => {
    const { file } = session();
    const record = readRecord("claude-code", subagentFile(file, "a1")!, { cwd: REPO, side: true })!;
    expect(kinds(record.items)).toEqual(["user", "answer", "work", "answer"]);
    // Another agent's words, whatever they begin with: not taken for the harness's own.
    expect(record.items[0]).toMatchObject({ type: "user", text: "<task>查登录接口为什么慢</task>" });
    expect(record.items[1]).toMatchObject({ type: "answer", text: "先看登录的处理函数。" });
    expect(steps(record.items)).toMatchObject([
      { kind: "search", text: "login" },
      { kind: "run", note: "Time the login", out: "real 0m2.31s" },
      // One it sent itself: a record of its own, by its id.
      { kind: "agent", text: "读日志", agent: "a9" },
    ]);
    // Its report back is its answer, not a tool it used.
    expect(record.items[3]).toMatchObject({ type: "answer", text: "登录慢在密码哈希：每次请求都重新派生密钥。\n\n见 `auth/hash.ts:41`。" });
    expect(steps(record.items).some((s) => s.tool === "SubagentHandback")).toBe(false);
    expect(record.usage).toMatchObject({ model: "claude-haiku-5-5" });
    expect(record.more).toBe(false);
  });

  it("one still at work ends where it has come to; one of its steps is read whole as a session's is", () => {
    const { file } = session();
    const going = readRecord("claude-code", subagentFile(file, "a2")!, { cwd: REPO, side: true })!;
    expect(kinds(going.items)).toEqual(["user", "work"]);
    expect(steps(going.items)).toMatchObject([{ kind: "read", text: "db/pool.ts" }]);
    const done = readRecord("claude-code", subagentFile(file, "a1")!, { cwd: REPO, side: true })!;
    const run = done.items.find((it) => it.type === "work")!;
    expect(readStep("claude-code", subagentFile(file, "a1")!, { work: run.id, n: 1, cwd: REPO, side: true })).toMatchObject({ kind: "run", text: "time curl -s localhost:8080/login\n  | head -1", out: "real 0m2.31s" });
    // Read as a session's own file, a sub-agent's lines are left out, as they are of a session's.
    expect(readRecord("claude-code", subagentFile(file, "a1")!, { cwd: REPO })!.items).toEqual([]);
    expect(readStep("claude-code", subagentFile(file, "a1")!, { work: run.id, n: 1, cwd: REPO })).toBeNull();
  });

  it("pages back as a session's record does", () => {
    const { file } = session();
    const path = subagentFile(file, "a1")!;
    const last = readRecord("claude-code", path, { cwd: REPO, side: true, limit: 2 })!;
    expect(kinds(last.items)).toEqual(["work", "answer"]);
    expect(last.more).toBe(true);
    const before = readRecord("claude-code", path, { cwd: REPO, side: true, limit: 2, before: last.cursor })!;
    expect(kinds(before.items)).toEqual(["user", "answer"]);
    expect(before.more).toBe(false);
  });
});

describe("the step that sent a sub-agent", () => {
  it("names it once the session's record says which: at once for one sent to the background, at its end for one waited on", () => {
    const { file } = session();
    const record = readRecord("claude-code", file, { cwd: REPO })!;
    expect(steps(record.items)).toMatchObject([
      { kind: "agent", text: "查登录慢", agent: "a1" },
      { kind: "agent", text: "看连接池", agent: "a2" },
      { kind: "agent", text: "被拒绝的", failed: true },
      { kind: "agent", text: "还没有结果的" },
    ]);
    // One refused, and one with no result yet, name none.
    expect(steps(record.items)[2]).not.toHaveProperty("agent");
    expect(steps(record.items)[3]).not.toHaveProperty("agent");
  });

  it("takes nothing for an id that is not one", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-subagents-")));
    const file = join(root, "s.jsonl");
    writeFileSync(file, [c.user(0, "go"), c.tool(1, "t1", "Agent", { description: "x", prompt: "…" }), c.result(2, "t1", { status: "completed", agentId: "../../etc/passwd" }),
      c.tool(3, "t2", "Bash", { command: "ls" }), c.result(4, "t2", { stdout: "a\n", agentId: "a1" })].join("\n") + "\n");
    const all = steps(readRecord("claude-code", file, { cwd: REPO })!.items);
    expect(all[0]).not.toHaveProperty("agent");
    // Only a step that sent a sub-agent names one.
    expect(all[1]).not.toHaveProperty("agent");
  });
});

describe("sub-agents over the API", () => {
  it("lists a session's sub-agents in the order they started; unchanged, the list is not sent again", async () => {
    const { app } = served();
    const res = await app.request("/sessions/claude-code/c1/subagents");
    expect(res.status).toBe(200);
    const body = await res.json() as { subagents: SubagentSummary[] };
    // `a1`'s file was made first.
    expect(body.subagents.map((a) => [a.id, a.type, a.name, a.done])).toEqual([["a1", "Explore", "查登录慢", true], ["a2", "general-purpose", "看连接池", false]]);
    expect((await app.request("/sessions/claude-code/c1/subagents", { headers: { "if-none-match": res.headers.get("etag")! } })).status).toBe(304);
    expect((await app.request("/sessions/claude-code/nope/subagents")).status).toBe(404);
    expect((await app.request("/sessions/vim/c1/subagents")).status).toBe(404);
  });

  it("serves one sub-agent's record with what the list says of it; asked again with its version, nothing is read until it has written more or ended", async () => {
    const { app, dir } = served();
    const res = await app.request("/sessions/claude-code/c1/subagents/a2/record");
    expect(res.status).toBe(200);
    const body = await res.json() as { session: { id: string }; agent: SubagentSummary; items: RecordItem[]; rev: string };
    expect(body.session.id).toBe("c1");
    expect(body.agent).toMatchObject({ id: "a2", type: "general-purpose", name: "看连接池", done: false });
    expect(kinds(body.items)).toEqual(["user", "work"]);
    const version = res.headers.get("etag")!;
    expect(version).toBe(`"${body.rev}"`);
    const same = await app.request("/sessions/claude-code/c1/subagents/a2/record", { headers: { "if-none-match": version } });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");

    // It writes on: another version, the record with what it wrote.
    appendFileSync(join(dir, "agent-a2.jsonl"), side("a2").text(70, "连接池上限是 4，偏小。") + "\n");
    const more = await app.request("/sessions/claude-code/c1/subagents/a2/record", { headers: { "if-none-match": version } });
    expect(more.status).toBe(200);
    const grown = await more.json() as { agent: SubagentSummary; items: RecordItem[]; rev: string };
    expect(kinds(grown.items)).toEqual(["user", "work", "answer"]);
    expect(grown.rev).not.toBe(body.rev);

    // It ends: Claude Code marks that beside the file, which itself does not change — another version all the same.
    const working = more.headers.get("etag")!;
    writeFileSync(join(dir, "agent-a2.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "看连接池", finished: true }));
    const ended = await app.request("/sessions/claude-code/c1/subagents/a2/record", { headers: { "if-none-match": working } });
    expect(ended.status).toBe(200);
    expect((await ended.json() as { agent: SubagentSummary }).agent.done).toBe(true);
    expect(ended.headers.get("etag")).not.toBe(working);
    expect((await app.request("/sessions/claude-code/c1/subagents/a2/record", { headers: { "if-none-match": ended.headers.get("etag")! } })).status).toBe(304);
  });

  it("pages a sub-agent's record back, and reads one of its steps whole", async () => {
    const { app } = served();
    const last = await (await app.request("/sessions/claude-code/c1/subagents/a1/record?limit=2")).json() as { items: RecordItem[]; more: boolean; cursor: number };
    expect(kinds(last.items)).toEqual(["work", "answer"]);
    expect(last.more).toBe(true);
    const page = await app.request(`/sessions/claude-code/c1/subagents/a1/record?limit=2&before=${last.cursor}`);
    expect(kinds((await page.json() as { items: RecordItem[] }).items)).toEqual(["user", "answer"]);
    // An earlier page is not the record's latest: nothing to ask again with.
    expect(page.headers.get("etag")).toBeNull();
    const run = last.items[0]!;
    const step = await app.request(`/sessions/claude-code/c1/subagents/a1/steps/${run.id}/1`);
    expect(step.status).toBe(200);
    expect(await step.json()).toMatchObject({ kind: "run", text: "time curl -s localhost:8080/login\n  | head -1", out: "real 0m2.31s" });
    expect((await app.request(`/sessions/claude-code/c1/subagents/a1/steps/${run.id}/99`)).status).toBe(404);
    expect((await app.request(`/sessions/claude-code/c1/subagents/a1/steps/abc/0`)).status).toBe(400);
    expect((await app.request(`/sessions/claude-code/c1/subagents/a1/steps/${run.id}/0/images/0`)).status).toBe(404);
    expect((await app.request(`/sessions/claude-code/c1/subagents/a1/steps/${run.id}/0/images/x`)).status).toBe(400);
  });

  it("answers 404 for a sub-agent the session has none of, an id that is not one, and an agent that keeps no such files", async () => {
    const { app } = served();
    expect((await app.request("/sessions/claude-code/c1/subagents/zz/record")).status).toBe(404);
    expect((await app.request("/sessions/claude-code/c1/subagents/a1.jsonl/record")).status).toBe(404);
    expect((await app.request("/sessions/claude-code/c1/subagents/..%2F..%2Fc1/record")).status).toBe(404);
    expect((await app.request("/sessions/claude-code/c1/subagents/a1/record?before=abc")).status).toBe(400);
    expect((await app.request("/sessions/claude-code/nope/subagents/a1/record")).status).toBe(404);
    expect((await app.request("/sessions/codex/c1/subagents/a1/record")).status).toBe(404);
    expect((await app.request("/sessions/vim/c1/subagents/a1/record")).status).toBe(404);
  });

  it("reads a terminal's own session wherever it runs, and nobody else's unlisted one", async () => {
    // The session's folder is one the list leaves out (a scratch folder): only a terminal of ours reads it by its id.
    const running: { agentSessionId: string }[] = [];
    const { app } = served({ terminals: { host: { list: () => running } } } as unknown as Partial<ApiDeps>, { excluded: [REPO] });
    expect((await app.request("/sessions/claude-code/c1/subagents")).status).toBe(404);
    expect((await app.request("/sessions/claude-code/c1/subagents/a1/record")).status).toBe(404);
    running.push({ agentSessionId: "c1" });
    expect((await app.request("/sessions/claude-code/c1/subagents")).status).toBe(200);
    expect((await app.request("/sessions/claude-code/c1/subagents/a1/record")).status).toBe(200);
  });

  it("is on the paired devices' list beside the session's own record", () => {
    for (const path of ["/sessions/claude-code/c1/subagents", "/sessions/claude-code/c1/subagents/a1/record", "/sessions/claude-code/c1/subagents/a1/steps/120/1", "/sessions/claude-code/c1/subagents/a1/steps/120/1/images/0"]) {
      expect(remoteAllowed("GET", path), path).toBe(true);
      expect(remoteAllowed("POST", path), path).toBe(false);
      expect(remoteAllowed("DELETE", path), path).toBe(false);
    }
    expect(remoteAllowed("GET", "/sessions/claude-code/c1/subagents/a1")).toBe(false);
    expect(remoteAllowed("GET", "/sessions/claude-code/c1/subagents/a1/record/x")).toBe(false);
  });
});
