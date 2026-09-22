/** Real-model check (background-v0 §4): Claude Code spawns a background sub-agent and the executor only
 *  finishes after it is done — `agent` events arrive before the result. Haiku, a few cents.
 *    npx tsx scripts/background_agent_smoke.ts */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExecutors } from "../src/daemon.js";
import { loadTargets } from "../src/router/targets.js";

const HERE = new URL(".", import.meta.url).pathname;
const targets = loadTargets(join(HERE, "..", "config", "targets.yaml"));
const executor = realExecutors(targets, false).find((e) => e.harness === "claude-code")!;
const cwd = mkdtempSync(join(tmpdir(), "agentswitch-bg-"));
for (const n of ["alpha", "beta", "gamma"]) writeFileSync(join(cwd, `${n}.txt`), `${n}\n`);
const log: { t: number; type: string; payload: Record<string, unknown> }[] = [];
const t0 = Date.now();
const outcome = await executor.run({
  taskId: "bg", task: "bg", cwd, model: "claude-haiku-4-5-20251001", effort: null, handoffNote: null, context: null, knownTokens: new Set<string>(), threadHome: null, resume: null, attachments: [], browser: false,
  brief: "Use the Agent tool to launch a subagent IN THE BACKGROUND (run_in_background) whose job is to list the .txt files in the working directory and report their names. Do not read the files yourself. Wait for the background subagent's notification, then reply with exactly the names it reported, comma-separated, and nothing else.",
  signal: new AbortController().signal,
  emit: (type, payload) => { log.push({ t: Date.now() - t0, type, payload }); if (type === "agent") console.log(`  ${Date.now() - t0} ms agent ${payload.status}: ${payload.description}${payload.summary ? ` — ${String(payload.summary).slice(0, 80)}` : ""}`); },
  approve: async (action) => { console.log(`  APPROVAL -> allow: ${action.slice(0, 80)}`); return "allow"; }, ask: async (qs) => { console.log("question:", JSON.stringify(qs)); return Object.fromEntries(qs.map((q) => [q.id, [q.options[0]?.label ?? "yes"]])); }
});
const agentEvents = log.filter((e) => e.type === "agent");
const lastAgent = agentEvents.at(-1)?.t ?? -1;
console.log(JSON.stringify({ ok: outcome.ok, ms: Date.now() - t0, lastText: outcome.lastText?.slice(0, 120), agents: outcome.agents, agentEvents: agentEvents.map((e) => [e.t, e.payload.status, e.payload.background]), lastAgentEventMs: lastAgent, resultAfterAgents: lastAgent >= 0 && lastAgent <= Date.now() - t0 }, null, 2));
process.exit(outcome.ok && (outcome.agents?.spawned ?? 0) > 0 && (outcome.agents?.completed ?? 0) > 0 ? 0 : 1);
