/** Real-model check of native continuation through the executors: two runs in one thread home, the
 *  second resumes the first and must recall a word without reading the file. Costs a few cents.
 *    npx tsx scripts/executor_resume_smoke.ts <claude-code|codex|opencode> */

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExecutors } from "../src/daemon.js";
import type { ExecutionInput } from "../src/executors/types.js";
import { loadTargets } from "../src/router/targets.js";

const HERE = new URL(".", import.meta.url).pathname;
const [harness] = process.argv.slice(2);
if (harness !== "claude-code" && harness !== "codex" && harness !== "opencode") { console.error("usage: executor_resume_smoke.ts <claude-code|codex|opencode>"); process.exit(2); }
const targets = loadTargets(join(HERE, "..", "config", "targets.yaml"));
const model = harness === "claude-code" ? "claude-haiku-4-5-20251001" : harness === "codex" ? "gpt-5.5" : "deepseek/deepseek-flash";
const executor = realExecutors(targets, false).find((e) => e.harness === harness)!;
const cwd = mkdtempSync(join(tmpdir(), "agentswitch-rsmoke-"));
const threadHome = mkdtempSync(join(tmpdir(), "agentswitch-rthread-"));
const word = `zebra-${Math.floor(1000 + Math.random() * 9000)}`;
writeFileSync(join(cwd, "note.txt"), `${word}\n`);

const base = (taskId: string, brief: string, resume: string | null): ExecutionInput => ({
  taskId, task: brief, brief, cwd, model, effort: harness === "codex" ? "low" : null, handoffNote: null, context: null, threadHome, resume, attachments: [], browser: false,
  signal: new AbortController().signal,
  emit: (type, payload) => console.log(`  ${type}: ${JSON.stringify(payload).slice(0, 160)}`),
  approve: async (action) => { console.log(`  APPROVAL -> allow: ${action}`); return "allow"; },
});
const t0 = Date.now();
const first = await executor.run(base("r1", "Read note.txt in the working directory and reply with its exact content.", null));
const t1 = Date.now();
console.log(JSON.stringify({ first: { ok: first.ok, sessionId: first.sessionId, lastText: first.lastText?.slice(0, 100), ms: t1 - t0 } }));
if (!first.sessionId) { console.error("no sessionId reported"); process.exit(1); }
const second = await executor.run(base("r2", "Without reading any file, what word was in note.txt earlier in this conversation? Reply with only the word.", first.sessionId));
console.log(JSON.stringify({ second: { ok: second.ok, sessionId: second.sessionId, lastText: second.lastText?.slice(0, 100), ms: Date.now() - t1, recalled: (second.lastText ?? "").includes(word), word, commandsRun: second.sideEffects?.commandsRun } }));
console.log(JSON.stringify({ threadHome: readdirSync(threadHome), sub: harness === "opencode" ? [] : readdirSync(join(threadHome, harness === "codex" ? "codex" : "claude")) }));
process.exit(second.ok && (second.lastText ?? "").includes(word) ? 0 : 1);
