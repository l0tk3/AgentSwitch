/** Real-model probe (2026-09-25): when its sandbox refuses a command (`ps`, `top` are setuid: "operation not
 *  permitted"), does Codex ask to run it outside the sandbox, and does AgentSwitch then see the plain command? The phone
 *  task "查看 mac 占用高 cpu 的进程" went to Codex twice and got nothing. This runs one read-only Codex turn in a
 *  throw-away folder with the approval floor of a look-only step (a read-only command passes, anything else is
 *  refused) and prints every event and approval. GPT-6 Luna at low effort, a few cents; stops itself after 3 minutes.
 *    npx tsx scripts/codex_escalation_probe.ts */

import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexExecutor } from "../src/executors/codex.js";
import { defaultProtected } from "../src/executors/protected.js";
import { isReadOnlyCommand, shellCommandOf } from "../src/executors/readOnly.js";
import type { ExecutionInput } from "../src/executors/types.js";

const MODEL = process.env.PROBE_MODEL ?? "gpt-6-luna";
const LIMIT_MS = Number(process.env.PROBE_LIMIT_MS ?? 180_000);
const binary = process.env.CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-codex-esc-")));
const prot = defaultProtected();
const brief = `目标：以只读方式查明这台 Mac 当前占用 CPU 最高的 5 个进程，列出进程名、PID 和 CPU 占用，用简体中文回答。
不要修改、创建或删除任何文件，不要结束或改变任何进程。`;

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const approvals: { action: string; decision: string }[] = [];
const abort = new AbortController();
const stopper = setTimeout(() => abort.abort(new Error("probe time limit")), LIMIT_MS);

try {
  const executor = codexExecutor({ binary, gate: null, browser: false, protected: prot });
  const input: ExecutionInput = {
    taskId: "codex-esc-probe", task: brief, brief, cwd, model: MODEL, effort: "low", handoffNote: null, context: null, knownTokens: new Set(),
    threadHome: null, resume: null, attachments: [], browser: false, gateScope: randomBytes(24).toString("base64url"), transfer: null,
    signal: abort.signal,
    emit: (type, payload) => console.error(`${at()} ${type}: ${JSON.stringify(payload).slice(0, 220)}`),
    // The floor of a read-only step (taskLoop.ts): a read-only command passes, the rest is refused.
    approve: async (action) => {
      const command = shellCommandOf(action);
      const decision = command !== null && isReadOnlyCommand(command, cwd, prot) ? "allow" : "deny";
      approvals.push({ action, decision });
      console.error(`${at()} APPROVAL ${decision}: ${action}`);
      return decision;
    },
    ask: async () => null,
  };
  const outcome = await executor.run(input);
  console.log(JSON.stringify({ seconds: (Date.now() - t0) / 1000, ok: outcome.ok, approvals, lastText: (outcome.lastText ?? "").slice(0, 600) }, null, 2));
} finally {
  clearTimeout(stopper);
  rmSync(cwd, { recursive: true, force: true });
}
