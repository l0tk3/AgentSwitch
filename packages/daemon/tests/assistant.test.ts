/** The router as the user's assistant (assistant-v0 §1.1): every phone message is sealed, stored, answered with one
 *  action — reply, create_task, status, cancel — and a failed assistant call still creates the task. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import type { Router } from "../src/core/modelCall.js";
import type { Sealer } from "../src/secrets/sealer.js";
import { TARGETS_PATH } from "./helpers.js";

const TOKEN = "enc:v1:" + "T".repeat(40);
/** Seals "hunter2222" like the real sealer would (no legend: nothing else is needed here). */
const sealer: Sealer = async (text) => ({ ok: true, text: text.split("hunter2222").join(TOKEN), sealed: text.includes("hunter2222") ? [{ label: "x/pass", field: "password", kind: "secret", hosts: ["x.com"], uses: ["http"], token: TOKEN }] : [], ms: 1 });

/** An assistant that answers from a script; each call gets the next reply (a function sees the message). */
function scripted(replies: (string | ((message: string) => string))[]): Router & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "assistant-test", calls,
    async route(input) {
      calls.push(input.task);
      const next = replies.shift() ?? "not json";
      return { text: typeof next === "function" ? next(input.task) : next, elapsedMs: 1 };
    },
  };
}

function daemon(assistant: Router | undefined) {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-assistant-"));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  const d = buildDaemon(cfg, { sealer, ...(assistant ? { assistant } : {}) });
  const say = async (text: string, extra: Record<string, unknown> = {}) => {
    const res = await d.app.request("/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, client_id: `c-${Math.random().toString(36).slice(2, 12)}`, ...extra }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const messages = async (after = 0) => (await (await d.app.request(`/assistant?after=${after}`)).json() as { messages: Record<string, any>[] }).messages;
  return { d, say, messages };
}

describe("assistant", () => {
  it("answers without creating a task, and the conversation keeps only sealed text", async () => {
    const f = daemon(scripted([JSON.stringify({ action: "reply", text: "你好，我在。" })]));
    const r = await f.say("在吗？密码是 hunter2222");
    expect(r.status).toBe(200);
    expect(r.body.assistant).toMatchObject({ role: "assistant", text: "你好，我在。", kind: "reply", taskIds: [] });
    expect(r.body.task).toBeUndefined();
    const log = JSON.stringify(await f.messages());
    expect(log).toContain(TOKEN);
    expect(log).not.toContain("hunter2222");
    expect(f.d.store.listTasks(10)).toEqual([]);
  });

  it("creates the task with the user's words, or with the assistant's version only when it kept every token", async () => {
    const f = daemon(scripted([
      JSON.stringify({ action: "create_task", text: "好的。", task: "登录 x.com（没带密文）" }),
      JSON.stringify({ action: "create_task", text: "好的。", task: `用 ${TOKEN} 登录 x.com 看通知` }),
    ]));
    const a = await f.say("登录 x.com，密码 hunter2222");
    expect(a.body.task.task).toBe(`登录 x.com，密码 ${TOKEN}`);   // the rewrite dropped the token: the user's words
    expect(a.body.assistant).toMatchObject({ kind: "task", taskIds: [a.body.task.id] });
    const b = await f.say("再看一下通知，密码 hunter2222");
    expect(b.body.task.task).toBe(`用 ${TOKEN} 登录 x.com 看通知`);
    await f.d.engine.idle();
  });

  it("a continuation becomes a follow-up of the task it names", async () => {
    let first = "";
    const f = daemon(scripted([
      JSON.stringify({ action: "create_task", text: "好的。" }),
      (message) => JSON.stringify({ action: "create_task", text: "接着做。", parent_id: /id (\w+)/.exec(message)?.[1] ?? "?" }),
    ]));
    first = (await f.say("整理 docs 目录")).body.task.id;
    await f.d.engine.idle();
    const second = await f.say("再把 README 也整理一下");
    expect(second.body.task.parentId).toBe(first);
    await f.d.engine.idle();
  });

  it("answers progress from the register, names only tasks that exist, and sees what a task waits for", async () => {
    const assistant = scripted([
      JSON.stringify({ action: "create_task", text: "好的。" }),
      (message) => JSON.stringify({ action: "status", text: "还在跑。", task_ids: [/id (\w+)/.exec(message)?.[1] ?? "?", "made-up"] }),
    ]);
    const f = daemon(assistant);
    const task = (await f.say('慢慢来 @echo {"delayMs":2000,"result":"ok"}')).body.task;
    const r = await f.say("刚才那个怎么样了？");
    expect(r.body.assistant).toMatchObject({ kind: "status", text: "还在跑。", taskIds: [task.id] });
    expect(assistant.calls[1]).toMatch(/Running or waiting:[\s\S]*id \w+/);
    f.d.engine.cancel(task.id);
    await f.d.engine.idle();
  });

  it("cancels a running task it names; a finished one is left alone", async () => {
    const f = daemon(scripted([
      JSON.stringify({ action: "create_task", text: "好的。" }),
      (message) => JSON.stringify({ action: "cancel", text: "停了。", task_ids: [/id (\w+)/.exec(message)?.[1] ?? "?"] }),
    ]));
    const task = (await f.say('慢慢来 @echo {"delayMs":20000,"result":"ok"}')).body.task;
    const r = await f.say("停掉吧");
    expect(r.body.assistant).toMatchObject({ kind: "cancel", taskIds: [task.id] });
    await f.d.engine.idle();
    expect(f.d.store.getTask(task.id)?.status).toBe("cancelled");
  });

  it("watch: sets an interval on a running task, the register shows it, 0 stops it; an ended or unknown task is refused", async () => {
    const assistant = scripted([
      JSON.stringify({ action: "create_task", text: "好的。" }),
      (message) => JSON.stringify({ action: "watch", text: "每 5 分钟告诉你。", task_ids: [/id (\w+)/.exec(message)?.[1] ?? "?"], every_minutes: 5 }),
      (message) => JSON.stringify({ action: "watch", text: "不盯了。", task_ids: [/id (\w+)/.exec(message)?.[1] ?? "?"], every_minutes: 0 }),
      JSON.stringify({ action: "watch", text: "好。", task_ids: ["made-up"] }),
    ]);
    const f = daemon(assistant);
    const task = (await f.say('慢慢来 @echo {"delayMs":3000,"result":"ok"}')).body.task;
    const set = await f.say("每 5 分钟告诉我一下进展");
    expect(set.body.assistant).toMatchObject({ kind: "watch", taskIds: [task.id] });
    const stop = await f.say("别盯了");
    expect(assistant.calls[2]).toMatch(/watched every 5 min/);
    expect(stop.body.assistant).toMatchObject({ kind: "watch", taskIds: [task.id] });
    const none = await f.say("盯着那个不存在的");
    expect(none.body.assistant).toMatchObject({ kind: "reply", text: "没有找到正在进行的这个任务。" });
    expect(assistant.calls[3]).not.toMatch(/watched every/);   // stopped
    f.d.engine.cancel(task.id);
    await f.d.engine.idle();
  });

  it("when the assistant fails, the message still becomes a task", async () => {
    const f = daemon(scripted(["no json", "still no json"]));
    const r = await f.say("整理下载目录");
    expect(r.status).toBe(200);
    expect(r.body.task.task).toBe("整理下载目录");
    expect(r.body.assistant).toMatchObject({ kind: "fallback", taskIds: [r.body.task.id] });
    await f.d.engine.idle();
  });

  it("without an assistant (echo mode) every message is a task, as before", async () => {
    const f = daemon(undefined);
    const r = await f.say("整理下载目录");
    expect(r.body.assistant.kind).toBe("fallback");
    expect(r.body.task.task).toBe("整理下载目录");
    await f.d.engine.idle();
  });

  it("a message sent twice (same client id) is handled once", async () => {
    const f = daemon(scripted([JSON.stringify({ action: "create_task", text: "好的。" })]));
    const body = JSON.stringify({ text: "整理下载目录", client_id: "same-client-id" });
    const post = () => f.d.app.request("/assistant", { method: "POST", headers: { "content-type": "application/json" }, body });
    const [a, b] = await Promise.all([post(), post()]);
    const [ja, jb] = [await a.json() as Record<string, any>, await b.json() as Record<string, any>];
    expect(ja.task.id).toBe(jb.task.id);
    expect(f.d.store.listTasks(10)).toHaveLength(1);
    expect(await f.messages()).toHaveLength(2);
    await f.d.engine.idle();
  });

  it("a message with files or a pinned executor is always a task", async () => {
    const f = daemon(scripted([JSON.stringify({ action: "reply", text: "看到了。" })]));
    const upload = new FormData();
    upload.append("files", new File(["hi"], "a.txt", { type: "text/plain" }));
    const staged = await (await f.d.app.request("/uploads", { method: "POST", body: upload })).json() as { files: { id: string }[] };
    const r = await f.say("看看这个文件", { attachments: staged.files.map((x) => x.id) });
    expect(r.body.task).toBeDefined();
    expect(r.body.task.attachments).toHaveLength(1);
    await f.d.engine.idle();
  });

  it("a first load gets the newest messages (?last=), later polls the ones after a sequence number", async () => {
    const f = daemon(scripted([JSON.stringify({ action: "reply", text: "一" }), JSON.stringify({ action: "reply", text: "二" })]));
    await f.say("第一句");
    await f.say("第二句");
    const last = (await (await f.d.app.request("/assistant?last=2")).json() as { messages: Record<string, any>[] }).messages;
    expect(last.map((m) => m.text)).toEqual(["第二句", "二"]);
    expect((await f.messages(last[0]!.seq)).map((m) => m.text)).toEqual(["二"]);
  });

  it("refuses an empty message and a sealer failure stores nothing", async () => {
    const f = daemon(scripted([]));
    expect((await f.say("")).status).toBe(400);
    expect(await f.messages()).toEqual([]);
  });
});
