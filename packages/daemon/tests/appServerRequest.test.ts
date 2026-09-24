import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexQuota } from "../src/quota/codex.js";
import { appServerRequest } from "../src/harness/appserver.js";
import { discoverCodexModels } from "../src/router/discovery.js";

// A local stand-in for `codex app-server`: JSON-RPC over stdio, never a model or the network. FAKE_MODE picks the
// behaviour; the default answers initialize, asks the client one server→client question, then answers the call.
const FAKE = `
const fs = require("node:fs");
const mode = process.env.FAKE_MODE || "ok";
if (process.env.FAKE_PID) fs.writeFileSync(process.env.FAKE_PID, String(process.pid));
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const ids = [];
let notified = false, call = null;
const result = (method, approval) => method === "account/rateLimits/read" ? { rateLimits: { primary: { usedPercent: 25 }, planType: "pro" } }
  : method === "model/list" ? { data: [{ id: "gpt-x" }, "gpt-y", { id: "gpt-x" }] }
  : { approval, notified, ids, env: { HTTPS_PROXY: process.env.HTTPS_PROXY ?? null, http_proxy: process.env.http_proxy ?? null, ALL_PROXY: process.env.ALL_PROXY ?? null, FAKE_MARK: process.env.FAKE_MARK ?? null } };
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === "s1") { send({ id: call.id, result: result(call.method, msg.result) }); return; }
  if (msg.method && msg.id !== undefined) ids.push(msg.id);
  if (msg.method === "initialize") {
    if (mode === "exit") { process.stderr.write("boom"); process.exit(3); }
    if (mode === "init_error") send({ id: msg.id, error: { code: -2, message: "no init" } });
    else if (mode !== "hang") send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === "initialized") { notified = true; return; }
  if (mode === "rpc_error") { send({ id: msg.id, error: { code: -1, message: "nope" } }); return; }
  call = msg;
  send({ id: "s1", method: "item/commandExecution/requestApproval", params: {} });
});
`;

let dir: string, bin: string, pidFile: string;
const env = (mode: string, extra: Record<string, string> = {}) => ({ ...process.env, FAKE_MODE: mode, FAKE_PID: pidFile, ...extra });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentswitch-appserver-"));
  bin = join(dir, "fake-codex.cjs");
  pidFile = join(dir, "pid");
  writeFileSync(bin, `#!${process.execPath}\n${FAKE}`, { mode: 0o700 });
});
afterEach(() => {
  if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("appServerRequest on the shared AppServerClient", () => {
  it("initializes, answers server requests with accept, returns the result, and strips proxy variables", async () => {
    const proxies = { HTTPS_PROXY: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", ALL_PROXY: "socks5://127.0.0.1:9", FAKE_MARK: "kept" };
    const result = await appServerRequest(bin, "thread/list", {}, 5_000, env("ok", proxies));
    expect(result).toEqual({ approval: { decision: "accept" }, notified: true, ids: [1, 2], env: { HTTPS_PROXY: null, http_proxy: null, ALL_PROXY: null, FAKE_MARK: "kept" } });
    await vi.waitFor(() => expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false), { timeout: 2_000, interval: 20 });
  });

  it("a JSON-RPC error answer rejects with the method and the error object", async () => {
    await expect(appServerRequest(bin, "account/rateLimits/read", {}, 5_000, env("rpc_error"))).rejects.toThrow('account/rateLimits/read failed: {"code":-1,"message":"nope"}');
    await expect(appServerRequest(bin, "model/list", {}, 5_000, env("init_error"))).rejects.toThrow('initialize failed: {"code":-2,"message":"no init"}');
  });

  it("an exit reports the code and the stderr tail", async () => {
    await expect(appServerRequest(bin, "model/list", {}, 5_000, env("exit"))).rejects.toThrow(/^app-server exited 3: boom$/);
  });

  it("one deadline covers the exchange and kills a hung child", async () => {
    await expect(appServerRequest(bin, "model/list", {}, 300, env("hang"))).rejects.toThrow("model/list: timed out after 300 ms");
    await vi.waitFor(() => expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false), { timeout: 2_000, interval: 20 });
  });

  it("an abort rejects with its reason; an already aborted signal starts no process", async () => {
    const controller = new AbortController();
    const running = appServerRequest(bin, "model/list", {}, 5_000, env("hang"), controller.signal);
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 2_000, interval: 10 });
    controller.abort(new Error("stop now"));
    await expect(running).rejects.toThrow("stop now");
    rmSync(pidFile);
    await expect(appServerRequest(bin, "model/list", {}, 5_000, env("ok"), AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");
    expect(existsSync(pidFile)).toBe(false);
  });

  it("a missing binary rejects with the spawn error", async () => {
    await expect(appServerRequest(join(dir, "missing"), "model/list", {}, 5_000)).rejects.toThrow(/ENOENT/);
  });

  it("quota and model discovery both read through it", async () => {
    expect(await codexQuota({ binary: bin, env: env("ok") }).read()).toMatchObject({ remaining: 0.75, detail: { planType: "pro" }, error: null });
    expect(await discoverCodexModels(bin, 5_000)).toEqual(["gpt-x", "gpt-y"]);
  });
});
