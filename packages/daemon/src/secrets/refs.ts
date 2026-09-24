/** `secret-gate refs register|release` (gate-next-v0 §1): the daemon, as the trusted dispatcher, registers a task's
 *  enc:v1: tokens under one execution scope and gets short enc:ref: references back. The scope is a capability: it
 *  travels on stdin only (never argv), and is scrubbed from any error text before that text is logged or shown. */

import { spawn } from "node:child_process";
import { z } from "zod";
import { GATE_CLI_TIMEOUT_MS } from "../core/limits.js";

/** A reference as the gate prints it; in free text it must not run on into more id characters. */
export const REF_RE = /enc:ref:[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/g;
/** The same reference after form/URL encoding (curl --data-urlencode, query strings). */
export const ENCODED_REF_RE = /enc%3[Aa]ref%3[Aa]([A-Za-z0-9_-]{16})(?![A-Za-z0-9_-])/g;
const REF_EXACT = /^enc:ref:[A-Za-z0-9_-]{16}$/;

export type RefResult = { readonly ref: string; readonly label: string } | { readonly error: string };

export type RefGate = {
  /** One result per token, in order; a token the gate cannot open is an error item, never a failed call. */
  register(scope: string, tokens: readonly string[], signal?: AbortSignal): Promise<readonly RefResult[]>;
  /** Drop every mapping of the scope; repeating it is harmless. */
  release(scope: string): Promise<number>;
};

/** The CLI's per-call limit (contract: at most 256 tokens per register). */
export const MAX_REGISTER = 256;
/** Stderr quoted in an error. */
const STDERR_QUOTE_CHARS = 200;

const RegisterOutput = z.object({
  refs: z.array(z.union([
    z.object({ ref: z.string().regex(REF_EXACT), label: z.string().nullable().default("") }),
    z.object({ error: z.string() }),
  ])),
});
const ReleaseOutput = z.object({ released: z.number().int().min(0) });

/** Parse errors quote their input; say only that the shape was wrong. */
function json(stdout: string, command: string): unknown {
  try { return JSON.parse(stdout); } catch { throw new Error(`secret-gate refs ${command}: output is not JSON`); }
}

export function parseRegisterOutput(stdout: string, expected: number): readonly RefResult[] {
  const parsed = RegisterOutput.safeParse(json(stdout, "register"));
  if (!parsed.success || parsed.data.refs.length !== expected) throw new Error("secret-gate refs register: unexpected output shape");
  return parsed.data.refs.map((r) => ("ref" in r ? { ref: r.ref, label: r.label ?? "" } : { error: r.error }));
}

const scrub = (text: string, scope: string): string => (scope ? text.split(scope).join("[scope]") : text);

type Run = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

function runRefs(gate: { readonly bin: string; readonly home: string }, command: "register" | "release", body: object, timeoutMs: number, signal?: AbortSignal): Promise<Run> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(`secret-gate refs ${command}: cancelled`)); return; }
    const child = spawn(gate.bin, ["refs", command], { env: { ...process.env, SECRET_GATE_HOME: gate.home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); fn(); };
    const onAbort = () => { child.kill("SIGKILL"); finish(() => reject(new Error(`secret-gate refs ${command}: cancelled`))); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(() => reject(new Error(`secret-gate refs ${command} timed out`))); }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => finish(() => reject(new Error(`secret-gate refs ${command}: ${e.message}`))));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    child.stdin.on("error", () => { /* the child exited early; its exit code and stderr say why */ });
    child.stdin.end(JSON.stringify(body));
  });
}

export function gateRefs(gate: { readonly bin: string; readonly home: string }, timeoutMs = GATE_CLI_TIMEOUT_MS): RefGate {
  return {
    async register(scope, tokens, signal) {
      const out: RefResult[] = [];
      for (let i = 0; i < tokens.length; i += MAX_REGISTER) {
        const batch = tokens.slice(i, i + MAX_REGISTER);
        let r: Run;
        try { r = await runRefs(gate, "register", { scope, tokens: batch }, timeoutMs, signal); }
        catch (err) { throw new Error(scrub((err as Error).message, scope)); }
        if (r.code !== 0 && r.code !== 1) throw new Error(scrub(`secret-gate refs register exited ${r.code}: ${r.stderr.trim().split("\n")[0]?.slice(0, STDERR_QUOTE_CHARS) ?? ""}`, scope));
        out.push(...parseRegisterOutput(r.stdout, batch.length));
      }
      return out;
    },
    async release(scope) {
      let r: Run;
      try { r = await runRefs(gate, "release", { scope }, timeoutMs); }
      catch (err) { throw new Error(scrub((err as Error).message, scope)); }
      if (r.code !== 0) throw new Error(scrub(`secret-gate refs release exited ${r.code}: ${r.stderr.trim().split("\n")[0]?.slice(0, STDERR_QUOTE_CHARS) ?? ""}`, scope));
      const parsed = ReleaseOutput.safeParse(json(r.stdout, "release"));
      if (!parsed.success) throw new Error("secret-gate refs release: unexpected output shape");
      return parsed.data.released;
    },
  };
}
