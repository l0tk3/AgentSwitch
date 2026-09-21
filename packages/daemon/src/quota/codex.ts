/** Codex quota via `codex app-server` JSON-RPC `account/rateLimits/read` (verified 2026-09-20). */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { QuotaProvider } from "./types.js";
import { labelForMinutes, type Window } from "./windows.js";

type Json = Record<string, unknown>;

/** `{rateLimits:{primary:{usedPercent,windowDurationMins,resetsAt},planType,...}}` → remaining fraction. */
export function parseRateLimits(result: Json): { remaining: number | null; detail: Json } {
  const limits = (result.rateLimits as Json | undefined) ?? result;
  const primary = limits.primary as Json | undefined;
  const used = typeof primary?.usedPercent === "number" ? primary.usedPercent : null;
  const secondary = limits.secondary as Json | null | undefined;
  const usedSecondary = typeof secondary?.usedPercent === "number" ? secondary.usedPercent : null;
  const worst = Math.max(used ?? 0, usedSecondary ?? 0);
  const windows: Window[] = [];
  for (const w of [primary, secondary]) {
    if (w && typeof w.usedPercent === "number") windows.push({ label: labelForMinutes(w.windowDurationMins as number | undefined), usedPercent: w.usedPercent, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null });
  }
  return {
    remaining: used === null && usedSecondary === null ? null : Math.max(0, Math.min(1, 1 - worst / 100)),
    detail: {
      planType: limits.planType ?? null,
      windows,
      credits: limits.credits ?? null,
      rateLimitReachedType: limits.rateLimitReachedType ?? null,
    },
  };
}

export function codexQuota(opts: { binary: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): QuotaProvider {
  return {
    harness: "codex",
    async read() {
      try {
        const result = await appServerRequest(opts.binary, "account/rateLimits/read", {}, opts.timeoutMs ?? 20_000, opts.env);
        return { ...parseRateLimits(result), source: "codex app-server account/rateLimits/read", error: null };
      } catch (err) {
        return { remaining: null, detail: {}, source: "codex app-server", error: (err as Error).message };
      }
    },
  };
}

/** Minimal JSON-RPC over stdio: initialize, one request, exit. Server→client requests are answered with accept. */
export function appServerRequest(binary: string, method: string, params: Json, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<Json> {
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !/^(https?|all)_proxy$/i.test(k))) as Record<string, string>;
    const child = spawn(binary, ["app-server"], { env: clean, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${method}: timed out after ${timeoutMs} ms`)); }, timeoutMs);
    const send = (msg: Json) => child.stdin.write(JSON.stringify(msg) + "\n");
    const finish = (fn: () => void) => { clearTimeout(timer); child.kill(); fn(); };
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("exit", (code) => { if (code !== null && code !== 0) finish(() => reject(new Error(`app-server exited ${code}: ${stderr.slice(0, 200)}`))); });
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg: Json;
      try { msg = JSON.parse(line) as Json; } catch { return; }
      if (msg.method && msg.id !== undefined) { send({ jsonrpc: "2.0", id: msg.id, result: { decision: "accept" } }); return; }
      if (msg.id === 1 && msg.result !== undefined) { send({ jsonrpc: "2.0", method: "initialized", params: {} }); send({ jsonrpc: "2.0", id: 2, method, params }); return; }
      if (msg.id === 2) {
        if (msg.error) finish(() => reject(new Error(`${method} failed: ${JSON.stringify(msg.error)}`)));
        else finish(() => resolve(msg.result as Json));
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "agentswitch", version: "0.1.0" } } });
  });
}
