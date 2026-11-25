/** A room member's use of the room's secrets (user #309: 他们也没法调用 secret gate): since 2026-10-08 a terminal runs
 *  without the credential gate (no proxy, no gate tools; docs/profiles-v0.md §8), so the room's ciphertexts were of no
 *  use to its members. The Kit's `room_secret` hands the call to the gate's own tools — `secret-gate mcp`, the same
 *  server Dispatch's tasks have — started for that one call in the member's folder and spoken to over MCP stdio. The
 *  gate resolves, sends or runs, and redacts what comes back; no value passes through the service. */

import { spawn } from "node:child_process";

export type GateTool = "secret_http" | "secret_exec" | "secret_otp" | "secret_describe";
export type GateCaller = (tool: GateTool, args: Record<string, unknown>, cwd: string | undefined) => Promise<{ readonly text: string; readonly isError: boolean }>;

/** How long one call may take: secret_exec runs its command up to 60 s, the gate's own start comes on top. */
const CALL_MS = 90_000;
const MAX_OUT = 4 << 20;

export function gateCaller(gate: { readonly bin: string; readonly home: string }, timeoutMs = CALL_MS): GateCaller {
  return (tool, args, cwd) => new Promise((resolve) => {
    const child = spawn(gate.bin, ["mcp"], { cwd, env: { ...process.env, SECRET_GATE_HOME: gate.home }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", size = 0, settled = false;
    const done = (text: string, isError: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      resolve({ text, isError });
    };
    const timer = setTimeout(() => done("secret-gate did not answer in time.", true), timeoutMs);
    const send = (o: object): void => { child.stdin.write(`${JSON.stringify(o)}\n`); };
    child.on("error", (e) => done(`secret-gate could not be started: ${e.message}`, true));
    child.on("close", () => done("secret-gate ended without an answer.", true));
    child.stdin.on("error", () => { /* it ended: close says so */ });
    child.stderr.resume();
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_OUT) { done("secret-gate's answer was too long.", true); return; }
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) { done(`secret-gate: ${msg.error.message ?? "refused to start"}`, true); return; }
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
        } else if (msg.id === 2) {
          if (msg.error) { done(msg.error.message ?? "secret-gate refused the call.", true); return; }
          const r = (msg.result ?? {}) as { content?: { type?: string; text?: string }[]; isError?: boolean };
          const text = (r.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text!).join("\n");
          done(text || "(no output)", r.isError === true);
          return;
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agentswitch-room", version: "1" } } });
  });
}

/** Every gate value in a call's arguments: only the room's own ciphertexts may be used through the room. */
const VALUE = /enc:(?:v1|ref):[A-Za-z0-9_=-]+/g;

export function valuesIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(...(v.match(VALUE) ?? []));
  else if (Array.isArray(v)) for (const x of v) valuesIn(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) valuesIn(x, out);
  return out;
}
