/** Run ONE real executor on a trivial task in a temp dir. Costs tokens; approvals auto-allowed and printed.
 *    npm run cli -- ... no; use: npx tsx scripts/executor_smoke.ts <claude-code|codex|opencode> [model] */

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExecutors } from "../src/daemon.js";
import { loadTargets } from "../src/router/targets.js";
import { classifyFailure } from "../src/router/failure.js";

const HERE = new URL(".", import.meta.url).pathname;
const [harness, modelArg] = process.argv.slice(2);
if (!harness) { console.error("usage: executor_smoke.ts <harness> [model]"); process.exit(2); }
const targets = loadTargets(join(HERE, "..", "config", "targets.yaml"));
const spec = targets.harnesses[harness];
if (!spec) { console.error(`unknown harness ${harness}`); process.exit(2); }
const model = modelArg ?? spec.default_model;
const executor = realExecutors(targets, false).find((e) => e.harness === harness)!;
const cwd = mkdtempSync(join(tmpdir(), "agentswitch-smoke-"));
const started = Date.now();
const outcome = await executor.run({
  taskId: "smoke", task: "smoke", cwd, model, effort: harness === "codex" ? "low" : null, handoffNote: null, context: null, knownTokens: new Set<string>(), threadHome: null, resume: null, attachments: [], browser: false,
  brief: "Create a file named hello.txt in the current directory containing exactly the text: hi from agentswitch\nThen reply with the single word DONE.",
  signal: new AbortController().signal,
  emit: (type, payload) => console.log(`  ${type}: ${JSON.stringify(payload).slice(0, 160)}`),
  approve: async (action, evidence) => { console.log(`  APPROVAL -> allow: ${action} | ${evidence.slice(0, 120)}`); return "allow"; },
});
const files = readdirSync(cwd);
console.log(JSON.stringify({ harness, model, ms: Date.now() - started, ok: outcome.ok, kind: classifyFailure(outcome), lastText: outcome.lastText?.slice(0, 200), stderr: outcome.stderr?.slice(0, 300), sideEffects: outcome.sideEffects, tokens: outcome.tokens, files, hello: files.includes("hello.txt") ? readFileSync(join(cwd, "hello.txt"), "utf8") : null }, null, 2));
