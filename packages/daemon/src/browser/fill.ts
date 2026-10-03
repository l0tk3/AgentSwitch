/** A person's Fill Ciphertext (docs/browser-v0.md §1): the gate turns a ciphertext into the value to type, for use
 *  `fill` and the pages it is typed into, through `secret-gate fill-value` (JSON on stdin and stdout; with the gate
 *  service, `browser.resolve` on gate.sock, which the CLI calls itself). The gate decides, by its own host rules, whether
 *  every frame from the focused field up to the top may receive it. The value travels on the child's stdout only; it is
 *  never logged and never part of an error. */

import { spawn } from "node:child_process";
import { GATE_CLI_TIMEOUT_MS } from "../core/limits.js";

/** The value of `token` for typing into the field whose frame chain (innermost first) is `frames`; a refusal throws
 *  `FillRefused` with the gate's reason. */
export type FillResolver = (token: string, frames: readonly string[]) => Promise<{ readonly value: string; readonly label: string }>;

/** The gate said no (wrong site, not for filling, not a ciphertext of this gate): its reason, for the person. */
export class FillRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FillRefused";
  }
}

/** A whole ciphertext, as people pick one (references belong to one task's run, never to a person). */
export const CIPHERTEXT = /^enc:v1:[A-Za-z0-9_=-]{16,}$/;
/** The gate's reason is quoted up to this length. */
const REASON_CHARS = 300;

type Gate = { readonly bin: string; readonly home: string };
type Run = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

function run(gate: Gate, body: object, timeoutMs: number): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(gate.bin, ["fill-value"], { env: { ...process.env, SECRET_GATE_HOME: gate.home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(() => reject(new Error("secret-gate fill-value timed out"))); }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => finish(() => reject(new Error(`secret-gate fill-value: ${e.message}`))));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    child.stdin.on("error", () => { /* the child exited early; its exit code and stderr say why */ });
    child.stdin.end(JSON.stringify(body));
  });
}

/** The gate's own reason (`error: …` on stderr), without the prefix. */
function reason(stderr: string): string {
  const line = stderr.split("\n").map((l) => l.trim()).find((l) => l.startsWith("error:")) ?? "";
  return line.replace(/^error:\s*/, "").slice(0, REASON_CHARS) || "凭据网关拒绝了此密文。";
}

export function gateFill(gate: Gate, timeoutMs = GATE_CLI_TIMEOUT_MS): FillResolver {
  return async (token, frames) => {
    if (!CIPHERTEXT.test(token)) throw new FillRefused("请选择一条 enc:v1: 密文。");
    let r: Run;
    try { r = await run(gate, { token, urls: frames }, timeoutMs); }
    catch { throw new FillRefused("凭据网关无响应，未填入。"); }
    if (r.code !== 0) throw new FillRefused(reason(r.stderr));
    let out: unknown;
    try { out = JSON.parse(r.stdout); } catch { throw new FillRefused("凭据网关的回答无法识别，未填入。"); }
    const { value, label } = (out ?? {}) as Record<string, unknown>;
    if (typeof value !== "string" || typeof label !== "string") throw new FillRefused("凭据网关的回答无法识别，未填入。");
    return { value, label };
  };
}
