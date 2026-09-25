/** Real-model probe (2026-09-25): does an OpenCode run on the resident server go silent after its reads outside the
 *  working directory are refused? The phone task 7698f9b5 ("Mac的长期项目工作目录在哪") listed the daemon's home, had
 *  every attempt refused (config deny + engine approval deny) and then produced nothing for six minutes until the
 *  watchdog cancelled it. This rebuilds the scene with a throw-away home: cwd = <home>/work/<id>, the home protected,
 *  the work dir exempt, every approval refused. Every 5 s it prints the active sessions and the newest message of each,
 *  so a stall shows whether OpenCode waits on the model, on a permission, or on nothing. deepseek/deepseek-flash, a
 *  fraction of a cent; stops itself after 3 minutes.
 *    npx tsx scripts/opencode_deny_probe.ts */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionInput } from "../src/executors/types.js";
import { opencodeExecutor } from "../src/executors/opencode.js";
import { OpenCodeExecServer, opencodeServeConfig } from "../src/executors/opencodeServer.js";
import type { ProtectedPaths } from "../src/executors/protected.js";

const MODEL = "deepseek/deepseek-flash";
const LIMIT_MS = Number(process.env.PROBE_LIMIT_MS ?? 180_000);
const binary = process.env.OPENCODE_BIN ?? join(process.env.HOME ?? "", ".opencode", "bin", "opencode");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-ocdeny-")));
const home = join(scratch, "AgentSwitch");
const cwd = join(home, "work", "5ae912dc");
for (const d of [cwd, join(home, "work", "f9a546e2"), join(home, "tasks")]) mkdirSync(d, { recursive: true });
writeFileSync(join(home, "CONTEXT.md"), "# context\n");
const prot: ProtectedPaths = { roots: [home], exempt: [join(home, "work")], readDenied: [] };
const server = new OpenCodeExecServer({ binary, home: join(scratch, "exec-home"), config: opencodeServeConfig(null, prot, join(scratch, "exec-home", "skills")), log: (l) => console.error(`  [server] ${l}`) });

const brief = `目标：用简体中文回答「Mac 上的长期项目工作目录在哪」。请以只读方式调查并给出结论，不要修改、创建或删除任何文件。
已知：本次任务的 cwd 为 ${cwd}；同级的 ${home}/work 下还有多个按任务分配的目录。
要做的检查：1) 列出并查看 ${home}/ 与 ${home}/work/ 的结构；2) 如有 README、AGENTS.md 指出长期项目路径，逐字引用；3) 若没有，说明「未找到」并给出候选。
先给一句直接结论，再给证据。`;

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;

const known = new Set<string>();
let dumped = false;
/** Once the session is no longer active: its newest messages as OpenCode stores them (what should mark the turn's end). */
async function dump(id: string): Promise<void> {
  const msgs = await server.call<{ data?: Record<string, any>[] }>("GET", `/api/session/${encodeURIComponent(id)}/message?limit=6`);
  for (const m of (msgs.data ?? []).slice(0, 6)) {
    const parts = (m.content ?? []).map((p: Record<string, any>) => p.type === "tool" ? `tool:${p.name}:${p.state?.status}:${String(p.state?.error?.message ?? p.state?.error ?? "").slice(0, 60)}` : p.type).join(",");
    console.error(`${at()} MESSAGE type=${m.type} outcome=${m.outcome ?? "-"} created=${m.time?.created ?? "-"} completed=${m.time?.completed ?? "-"} finish=${m.finish ?? "-"} error=${JSON.stringify(m.error ?? null).slice(0, 160)} parts=[${parts}]`);
  }
  const status = await server.call<{ data?: unknown }>("GET", `/api/session/${encodeURIComponent(id)}`).catch((e) => ({ data: String(e) }));
  console.error(`${at()} SESSION ${JSON.stringify(status.data).slice(0, 400)}`);
}

async function snapshot(): Promise<void> {
  try {
    const active = await server.call<{ data?: Record<string, unknown> }>("GET", "/api/session/active");
    const ids = Object.keys(active.data ?? {});
    for (const id of ids) known.add(id);
    if (!ids.length && known.size && !dumped) { dumped = true; for (const id of known) await dump(id); }
    const lines: string[] = [];
    for (const id of ids) {
      const msgs = await server.call<{ data?: Record<string, any>[] }>("GET", `/api/session/${encodeURIComponent(id)}/message?limit=3`);
      const newest = (msgs.data ?? [])[0];
      const perms = await server.call<{ data?: unknown[] }>("GET", `/api/session/${encodeURIComponent(id)}/permission`);
      const parts = (newest?.content ?? []).map((p: Record<string, any>) => p.type === "tool" ? `tool:${p.name}:${p.state?.status}` : p.type).join(",");
      lines.push(`${id.slice(0, 16)} active=${JSON.stringify(active.data?.[id])} newest=${newest?.type ?? "-"} completed=${newest?.time?.completed ?? "-"} parts=[${parts}] pendingPermissions=${(perms.data ?? []).length}`);
    }
    console.error(`${at()} SNAPSHOT ${ids.length ? lines.join(" | ") : "no active session"}`);
  } catch (err) {
    console.error(`${at()} SNAPSHOT failed: ${(err as Error).message}`);
  }
}

const abort = new AbortController();
const stopper = setTimeout(() => { console.error(`${at()} probe limit reached: aborting the run`); abort.abort(); }, LIMIT_MS);
const ticker = setInterval(() => void snapshot(), 2_000);
let sessionId: string | undefined;
try {
  await server.start();
  const executor = opencodeExecutor({ server, gate: null, browser: false, protected: prot, log: (l) => console.error(`  [executor] ${l}`) });
  const input: ExecutionInput = {
    taskId: "deny-probe", task: brief, brief, cwd, model: MODEL, effort: null, handoffNote: null, context: null, knownTokens: new Set(),
    threadHome: null, resume: null, attachments: [], browser: false, gateScope: randomBytes(24).toString("base64url"), transfer: null,
    credentialRepair: { url: "http://127.0.0.1:9/credential-repair", key: randomBytes(16).toString("hex") },
    signal: abort.signal,
    emit: (type, payload) => console.error(`${at()} ${type}: ${JSON.stringify(payload).slice(0, 220)}`),
    approve: async (action) => { console.error(`${at()} APPROVAL denied: ${action}`); return "deny"; },
    ask: async () => null,
  };
  const outcome = await executor.run(input);
  sessionId = outcome.sessionId;
  console.log(JSON.stringify({ seconds: (Date.now() - t0) / 1000, aborted: abort.signal.aborted, ok: outcome.ok, exitCode: outcome.exitCode, timedOut: outcome.timedOut, lastText: (outcome.lastText ?? "").slice(0, 400), stderr: outcome.stderr?.slice(0, 400) }, null, 2));
} finally {
  clearTimeout(stopper);
  clearInterval(ticker);
  if (sessionId) await server.call("DELETE", `/api/session/${encodeURIComponent(sessionId)}`).catch(() => undefined);
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
}
