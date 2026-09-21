/** Test executor. Reads a directive from the task text so a single task can script its own run:
 *    @echo {"delayMs":50,"fail":"refusal","approval":"rm -rf /tmp/x","result":"hello","tokens":123}
 *  `fail` is a FailureKind; `failTimes` limits how many attempts fail (default: every attempt). */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OUT_DIR } from "../files/names.js";
import { NO_SIDE_EFFECTS, type ExecutionOutcome, type FailureKind } from "../router/failure.js";
import type { ExecutionInput, Executor } from "./types.js";

export type EchoDirective = {
  readonly delayMs?: number;
  readonly fail?: FailureKind;
  readonly failTimes?: number;
  readonly approval?: string;
  readonly approvalTimes?: number;
  readonly result?: string;
  readonly tokens?: number;
  readonly sideEffects?: { filesChanged?: number; commandsRun?: number };
  /** Files to write under <cwd>/out/ (path → content), to exercise artifact collection. */
  readonly out?: Record<string, string>;
};

const DIRECTIVE = /@echo\s+(\{[^\n]*\})/;

export function parseDirective(text: string): EchoDirective {
  const m = DIRECTIVE.exec(text);
  if (!m) return {};
  try {
    return JSON.parse(m[1]!) as EchoDirective;
  } catch {
    return {};
  }
}

const FAILURES: Record<FailureKind, Partial<ExecutionOutcome>> = {
  refusal: { exitCode: 0, lastText: "I can't help with that request." },
  quota: { httpStatus: 429, stderr: "rate limit exceeded" },
  transport: { stderr: "connect ECONNREFUSED 127.0.0.1:8080" },
  gate_denied: { gateDenied: true, httpStatus: 403, lastText: "X-Secret-Gate: denied" },
  task_failed: { exitCode: 1, lastText: "tests failed" },
  unknown: {},
};

/** Per-task counters shared by every echo executor, so "fail once" means once per task, not once per harness. */
const failures = new Map<string, number>();
const approvalsAsked = new Map<string, number>();

export function echoExecutor(harness: string): Executor & { readonly runs: ExecutionInput[] } {
  const runs: ExecutionInput[] = [];
  return {
    harness,
    runs,
    async run(input) {
      runs.push(input);
      const d = parseDirective(input.task);
      if (d.delayMs) await sleep(d.delayMs, input.signal);
      input.emit("text", { text: `echo[${harness}/${input.model}] ${input.brief.slice(0, 80)}` });
      const asked = approvalsAsked.get(input.taskId) ?? 0;
      if (d.approval && (d.approvalTimes === undefined || asked < d.approvalTimes)) {
        approvalsAsked.set(input.taskId, asked + 1);
        input.emit("tool_call", { tool: "bash", command: d.approval });
        const decision = await input.approve(`bash: ${d.approval}`, "requested by @echo directive");
        if (decision === "deny") return { ok: false, exitCode: 0, lastText: "user denied the action", sideEffects: NO_SIDE_EFFECTS };
      }
      for (const [rel, content] of Object.entries(d.out ?? {})) { const p = join(input.cwd, OUT_DIR, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); }
      const sideEffects = { ...NO_SIDE_EFFECTS, ...(d.sideEffects ?? {}) };
      const failed = failures.get(input.taskId) ?? 0;
      if (d.fail && (d.failTimes === undefined || failed < d.failTimes)) {
        failures.set(input.taskId, failed + 1);
        return { ok: false, ...FAILURES[d.fail], sideEffects };
      }
      return { ok: true, exitCode: 0, lastText: d.result ?? `done: ${input.brief.slice(0, 60)}`, sideEffects, ...(d.tokens !== undefined ? { tokens: d.tokens } : {}) } as ExecutionOutcome;
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("cancelled")); }, { once: true });
  });
}
