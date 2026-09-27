/** CONTEXT.md saves (router-v0 §2b, app-v0 §2): sealed like a task when a sealer is configured, linted, the previous
 *  version kept in context-history/; and the SSE heartbeat that keeps a quiet task's stream open. */

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { CONTEXT_HISTORY_KEEP } from "../src/core/contextHistory.js";
import { LEGEND_HEADER, legend, type SealedEntry, type Sealer } from "../src/secrets/sealer.js";
import { TARGETS_PATH } from "./helpers.js";

const TOKEN = "enc:v1:" + "S".repeat(40);
const entry: SealedEntry = { label: "fin/pass", field: "account password", kind: "secret", hosts: ["fin.example.test"], uses: ["http"], token: TOKEN };

function daemon(sealer?: Sealer, extra: { sseHeartbeatMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-ctx-"));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  const d = buildDaemon(cfg, { ...(sealer ? { sealer } : {}), ...extra });
  const put = (text: string) => d.app.request("/context", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  return { d, home, put, contextPath: join(home, "CONTEXT.md"), historyDir: join(home, "context-history") };
}

/** A sealer that finds one plaintext and appends the executor legend, like the real one. */
const sealing = (plaintext: string) => vi.fn<Sealer>(async (text) => ({ ok: true, text: text.split(plaintext).join(TOKEN) + legend([entry], null), sealed: [entry], ms: 1 }));

describe("PUT /context", () => {
  it("seals plaintext credentials before they reach the disk and keeps no executor legend", async () => {
    const sealer = sealing("hunter2222");
    const { put, contextPath } = daemon(sealer);
    const res = await put("# 站点\n- 财务系统 https://fin.example.test 账号 alice / hunter2222\n");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sealed: [{ field: "account password", hosts: ["fin.example.test"] }] });
    const stored = readFileSync(contextPath, "utf8");
    expect(stored).toContain(TOKEN);
    expect(stored).not.toContain("hunter2222");
    expect(stored).not.toContain(LEGEND_HEADER);
    expect(sealer).toHaveBeenCalledTimes(1);
  });

  it("refuses the save when the sealer cannot run or cannot tell the site, and the file stays as it was", async () => {
    const down = vi.fn<Sealer>(async () => ({ ok: false, code: "unavailable", error: "敏感信息检查暂时不可用，请稍后重试。", ms: 1 }));
    const a = daemon(down);
    writeFileSync(a.contextPath, "# before\n");
    const refused = await a.put("- 密码 hunter2222\n");
    expect(refused.status).toBe(503);
    expect(readFileSync(a.contextPath, "utf8")).toBe("# before\n");
    expect(existsSync(a.historyDir)).toBe(false);

    const lost = vi.fn<Sealer>(async () => ({ ok: false, code: "unroutable", error: "无法确定这些凭据所属的站点。", ms: 1 }));
    const b = daemon(lost);
    const unroutable = await b.put("- 某个密码 hunter2222\n");
    expect(unroutable.status).toBe(400);
    expect(String((await unroutable.json() as { error: string }).error)).toMatch(/网址/);
    expect(existsSync(b.contextPath)).toBe(false);
  });

  it("without a sealer (echo mode) it only lints, as before", async () => {
    const { put, contextPath } = daemon();
    const res = await put("- 财务 https://fin.example.test\n  - 密码: hunter2222\n");
    expect(res.status).toBe(200);
    expect((await res.json() as { warnings: string[] }).warnings.join("\n")).toMatch(/line 2/);
    expect(readFileSync(contextPath, "utf8")).not.toContain("hunter2222");
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

describe("SSE heartbeat", () => {
  it("a quiet task's event stream carries comment pings", async () => {
    const { d } = daemon(undefined, { sseHeartbeatMs: 20 });
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
