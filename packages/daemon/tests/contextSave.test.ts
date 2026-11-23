/** CONTEXT.md saves (router-v0 §2b, app-v0 §2): saved as typed and linted (sealed like a task until 2026-11-23), the previous
 *  version kept in context-history/; and the SSE heartbeat that keeps a quiet task's stream open. */

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { CONTEXT_HISTORY_KEEP } from "../src/core/contextHistory.js";
import { TARGETS_PATH } from "./helpers.js";

const TOKEN = "enc:v1:" + "S".repeat(40);

function daemon(extra: { sseHeartbeatMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-ctx-"));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  const d = buildDaemon(cfg, { ...extra });
  const put = (text: string) => d.app.request("/context", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  return { d, home, put, contextPath: join(home, "CONTEXT.md"), historyDir: join(home, "context-history") };
}


describe("PUT /context", () => {
  it("saves the text as typed, only linted, with an empty `sealed` (the automatic sealing was removed on 2026-11-23)", async () => {
    const { put, contextPath } = daemon();
    const res = await put(`- 财务 https://fin.example.test\n  - 密文: ${TOKEN}\n  - 密码: hunter2222\n`);
    expect(res.status).toBe(200);
    const body = await res.json() as { warnings: string[]; sealed: unknown[] };
    expect(body.sealed).toEqual([]);
    expect(body.warnings.join("\n")).toMatch(/line 3/);
    const stored = readFileSync(contextPath, "utf8");
    expect(stored).toContain(TOKEN);
    expect(stored).not.toContain("hunter2222");
  });

  it("keeps the previous version in context-history/, newest " + CONTEXT_HISTORY_KEEP + " only", async () => {
    const { put, historyDir } = daemon();
    expect((await put("# v0\n")).status).toBe(200);
    expect(existsSync(historyDir)).toBe(false);   // nothing to keep yet
    for (let i = 1; i <= CONTEXT_HISTORY_KEEP + 3; i++) expect((await put(`# v${i}\n`)).status).toBe(200);
    const kept = readdirSync(historyDir).sort();
    expect(kept).toHaveLength(CONTEXT_HISTORY_KEEP);
    expect(readFileSync(join(historyDir, kept.at(-1)!), "utf8")).toBe(`# v${CONTEXT_HISTORY_KEEP + 2}\n`);
    expect(kept.every((name) => name.endsWith("-local.md"))).toBe(true);
    // Saving the same text again keeps no duplicate.
    expect((await put(`# v${CONTEXT_HISTORY_KEEP + 3}\n`)).status).toBe(200);
    expect(readdirSync(historyDir).sort().at(-1)).toBe(kept.at(-1));
  });
});

describe("what a task's run is writing", () => {
  it("is in the task's event stream as it is written, in no sequence, and done once its text is there", async () => {
    const { d } = daemon();
    const task = d.engine.submit({ task: 'go @echo {"writing":["终端","终端怎样"],"writingMs":120,"delayMs":200}', cwd: tmpdir() });
    const res = await d.app.request(`/tasks/${task.id}/events`);
    const reader = res.body!.getReader();
    let text = "";
    while (!/event: (succeeded|failed)/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    const blocks = text.split("\n\n").filter((b) => b.includes("event: writing"));
    expect(blocks.map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data:"))!.slice(5)))).toEqual([
      { taskId: task.id, text: "终端" }, { taskId: task.id, text: "终端怎样" }, { taskId: task.id, done: true }]);
    // Not a stored event: no id, and not in what the task's events replay.
    expect(blocks.every((b) => !/^id:/m.test(b))).toBe(true);
    expect(d.store.eventsSince(task.id, 0).some((e) => (e.type as string) === "writing")).toBe(false);
    await d.engine.idle();
  });
});

describe("SSE heartbeat", () => {
  it("a quiet task's event stream carries comment pings", async () => {
    const { d } = daemon({ sseHeartbeatMs: 20 });
    const task = d.engine.submit({ task: 'wait @echo {"delayMs":400,"result":"ok"}', cwd: tmpdir() });
    const res = await d.app.request(`/tasks/${task.id}/events`);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes(": ping")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toContain(": ping");
    d.engine.cancel(task.id);
    await d.engine.idle();
  });
});
