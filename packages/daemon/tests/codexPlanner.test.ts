import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexTextRouter } from "../src/router/routers/codex.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(mode: "ok" | "failed" | "hang") {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-planner-process-")); dirs.push(dir);
  const pidFile = join(dir, "pid"), binary = join(dir, "fake-app-server");
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (${JSON.stringify(mode)} === 'hang') return;
  send({id:msg.id, result:msg.method === 'thread/start' ? {thread:{id:'fixture-thread'}} : {}});
  if (msg.method !== 'turn/start') return;
  if (${JSON.stringify(mode)} === 'ok') send({method:'item/completed',params:{item:{type:'agentMessage',text:'{"action":"ask_user","question":"请确认范围"}'}}});
  send({method:'turn/completed',params:{turn:{status:${JSON.stringify(mode === "failed" ? "failed" : "completed")}, ...(${JSON.stringify(mode)} === 'failed' ? {error:{message:'private provider diagnostics'}} : {})}}});
});
`, { mode: 0o755 });
  return { dir, pidFile, router: codexTextRouter({ binary, model: "fixture-model" }), request: { task: "safe fixture", system: "fixture", cwd: dir } };
}

describe.skipIf(process.platform === "win32")("Codex planning process lifecycle", () => {
  it("returns the planning message and reaps its app-server", async () => {
    const f = fixture("ok");
    const result = await f.router.route(f.request, new AbortController().signal);
    expect(JSON.parse(result.text).action).toBe("ask_user");
    expect(() => process.kill(Number(readFileSync(f.pidFile, "utf8")), 0)).toThrow();
  });

  it("recognizes a failed turn instead of converting it into an empty JSON reply", async () => {
    const f = fixture("failed");
    await expect(f.router.route(f.request, new AbortController().signal)).rejects.toThrow("planning turn failed");
    expect(() => process.kill(Number(readFileSync(f.pidFile, "utf8")), 0)).toThrow();
  });

  it("cancels a stalled initialization and forces the process to exit", async () => {
    const f = fixture("hang"), controller = new AbortController();
    const running = f.router.route(f.request, controller.signal);
    const rejected = expect(running).rejects.toThrow("planner timed out");
    await vi.waitUntil(() => existsSync(f.pidFile));
    controller.abort(new Error("planner timed out"));
    await rejected;
    expect(() => process.kill(Number(readFileSync(f.pidFile, "utf8")), 0)).toThrow();
  });

  it("does not start a process for an already cancelled planning request", async () => {
    const f = fixture("hang"), controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(f.router.route(f.request, controller.signal)).rejects.toThrow("cancelled");
    expect(existsSync(f.pidFile)).toBe(false);
  });
});
