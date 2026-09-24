/** Real-model smoke for the OpenCode executor on its resident server (tech debt #8), deepseek/deepseek-flash, a
 *  fraction of a cent. Starts the executor server, runs one short task (text, a shell tool event, and the shell's
 *  HTTPS_PROXY checked for the scoped form without printing it), resumes that session, runs the same task in a fresh
 *  session on the warm server and once with `opencode run --standalone` for timing. The gate is a stub (dead proxy
 *  address, a stub MCP server that records only the names of its env vars), so no real gate or credentials are used.
 *  Afterwards: the runs' sessions and OpenCode rows are removed (cleanupEphemeral, as for ephemeral tasks) and the
 *  server is stopped.
 *    npx tsx scripts/opencode_serve_smoke.ts */

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupEphemeral, defaultCleanupPaths } from "../src/engine/cleanup.js";
import type { GateOptions } from "../src/executors/gate.js";
import { opencodeExecutor } from "../src/executors/opencode.js";
import { locationQuery, OpenCodeExecServer, opencodeServeConfig } from "../src/executors/opencodeServer.js";
import { defaultProtected } from "../src/executors/protected.js";
import type { ExecutionInput } from "../src/executors/types.js";
import type { ExecutionOutcome } from "../src/core/outcome.js";

const MODEL = "deepseek/deepseek-flash";
const binary = process.env.OPENCODE_BIN ?? join(process.env.HOME ?? "", ".opencode", "bin", "opencode");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-ocsmoke-")));
const gateHome = join(scratch, "gate-home");
const stub = join(scratch, "stub-gate");
writeFileSync(stub, `#!${process.execPath}
// Stub "secret-gate mcp": records its env var NAMES, then speaks just enough MCP to connect.
const fs = require("node:fs"); fs.mkdirSync(process.env.SECRET_GATE_HOME, { recursive: true });
fs.writeFileSync(process.env.SECRET_GATE_HOME + "/mcp-env-names.json", JSON.stringify(Object.keys(process.env)));
let buf = ""; const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub-gate", version: "0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} }); } });
`, { mode: 0o700 });
const gate: GateOptions = { bin: stub, home: gateHome, proxy: "http://127.0.0.1:9", playwrightVersion: "0.0.82", allowedOrigins: [] };
const prot = defaultProtected();
const home = join(scratch, "exec-home");
const server = new OpenCodeExecServer({ binary, home, config: opencodeServeConfig(gate, prot, join(home, "skills")), log: (l) => console.error(`  [server] ${l}`) });

const cwds: string[] = [];
const sessions = new Set<string>();
const workDir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-ocsmoke-cwd-"))); cwds.push(d); return d; };

type Run = { ms: number; outcome: ExecutionOutcome; events: { type: string; payload: Record<string, unknown> }[] };

async function run(executor: ReturnType<typeof opencodeExecutor>, cwd: string, brief: string, resume: string | null = null): Promise<Run> {
  const events: Run["events"] = [];
  const input: ExecutionInput = {
    taskId: "serve-smoke", task: brief, brief, cwd, model: MODEL, effort: null, handoffNote: null, context: null, knownTokens: new Set(),
    threadHome: null, resume, attachments: [], browser: false, gateScope: randomBytes(24).toString("base64url"), transfer: null,
    credentialRepair: { url: "http://127.0.0.1:9/credential-repair", key: randomBytes(16).toString("hex") },
    signal: new AbortController().signal,
    emit: (type, payload) => { events.push({ type, payload }); console.error(`  ${type}: ${JSON.stringify(payload).slice(0, 140)}`); },
    approve: async (action) => { console.error(`  APPROVAL (denied by the smoke): ${action}`); return "deny"; },
    ask: async () => null,
  };
  const started = Date.now();
  const outcome = await executor.run(input);
  if (outcome.sessionId) sessions.add(outcome.sessionId);
  return { ms: Date.now() - started, outcome, events };
}

const task = (nonce: string) => `Remember this nonce: ${nonce}. Run exactly this shell command in the working directory: printenv HTTPS_PROXY | grep -c '^http://scope:' > proxy_check.txt ; then reply with the single word ok.`;
const checks: Record<string, boolean> = {};
const timings: Record<string, number> = {};
try {
  let t = Date.now();
  await server.start();
  timings.serverStartMs = Date.now() - t;
  const served = opencodeExecutor({ server, gate, browser: false, protected: prot, log: (l) => console.error(`  [executor] ${l}`) });

  const nonce = `N-${randomBytes(3).toString("hex")}`;
  const cwd1 = workDir();
  console.error("run 1: fresh session on the new server");
  const r1 = await run(served, cwd1, task(nonce));
  timings.run1FirstMs = r1.ms;
  checks.run1Ok = r1.outcome.ok && /\bok\b/i.test(r1.outcome.lastText ?? "");
  checks.run1ShellToolEvent = r1.events.some((e) => e.type === "tool_call" && /^(shell|bash)$/.test(String(e.payload.tool)));
  checks.run1ScopedProxyInShell = existsSync(join(cwd1, "proxy_check.txt")) && readFileSync(join(cwd1, "proxy_check.txt"), "utf8").trim() === "1";
  checks.run1NotStandalone = !r1.events.some((e) => String(e.payload.text ?? "").includes("resident server not used"));
  const names = existsSync(join(gateHome, "mcp-env-names.json")) ? JSON.parse(readFileSync(join(gateHome, "mcp-env-names.json"), "utf8")) as string[] : [];
  checks.gateMcpGotScopeAndRepairVars = names.includes("SECRET_GATE_SCOPE") && names.includes("SECRET_GATE_REPAIR_KEY");
  checks.gateMcpHasNoServerPassword = !names.some((n) => /^OPENCODE_(SERVER_)?PASSWORD$/.test(n));
  checks.mcpRemovedAfterRun = ((await server.call<{ data?: unknown[] }>("GET", `/api/mcp?${locationQuery(cwd1)}`)).data ?? []).length === 0;

  console.error("run 2: resume the same session");
  const r2 = await run(served, cwd1, "What nonce did I ask you to remember? Reply with the nonce only, no tools.", r1.outcome.sessionId ?? null);
  timings.run2ResumeMs = r2.ms;
  checks.run2Resumed = r2.outcome.ok && r2.outcome.sessionId === r1.outcome.sessionId && (r2.outcome.lastText ?? "").includes(nonce);

  console.error("run 3: fresh session in a new directory on the warm server");
  const cwd3 = workDir();
  const r3 = await run(served, cwd3, task(`N-${randomBytes(3).toString("hex")}`));
  timings.run3WarmFreshMs = r3.ms;
  checks.run3Ok = r3.outcome.ok && existsSync(join(cwd3, "proxy_check.txt"));

  console.error("run 4: the same task with opencode run --standalone");
  const cwd4 = workDir();
  t = Date.now();
  const r4 = await run(opencodeExecutor({ gate, browser: false, protected: prot }), cwd4, task(`N-${randomBytes(3).toString("hex")}`));
  timings.run4StandaloneMs = Date.now() - t;
  checks.run4StandaloneOk = r4.outcome.ok;
} finally {
  for (const id of sessions) await server.call("DELETE", `/api/session/${encodeURIComponent(id)}`).catch(() => undefined);
  const paths = { ...defaultCleanupPaths(), workRoot: join(scratch, "work") };
  const cleaned = cwds.map((d) => cleanupEphemeral(d, paths));
  checks.ephemeralCleanupWithServerRunning = cleaned.every((c) => c.errors.length === 0 && c.workDirRemoved);
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, timings, cleanup: cleaned.map((c) => ({ sessions: c.opencodeSessionsRemoved, projects: c.opencodeProjectsRemoved, errors: c.errors })) }, null, 2));
}
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
