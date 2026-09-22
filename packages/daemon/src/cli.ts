/** agentswitch CLI. Daemon-backed commands talk to http://127.0.0.1:4711; `route`/`reroute`/`context init` run locally.
 *
 *   serve                       start the daemon (AGENTSWITCH_ROUTER=echo, AGENTSWITCH_PORT=...)
 *   task "<text>" [--cwd d | --ephemeral] [--pin h/m] [--browser] [--no-watch] [--reply <taskId>]   (--reply: follow-up with context)
 *   tasks | show <id> | watch <id> | approve <task> <approval> --allow|--deny | cancel <id>
 *   handoff <taskId> [--pin h/m]     hand a task to another executor (same thread)
 *   threads [--archived] | thread <id> | archive <id> | reopen <id> | rmthread <id>
 *   approvals | quota [--refresh] | preview "<text>" [--cwd d] | log
 *   route "<text>" ... (local, no daemon) | reroute ... | context init
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Client } from "./client.js";
import { defaultConfig, serve } from "./daemon.js";
import type { TaskEvent } from "./engine/types.js";
import { CONTEXT_EXAMPLE, loadContext } from "./router/context.js";
import { NO_SIDE_EFFECTS, type FailureKind } from "./router/failure.js";
import { RoutingLog } from "./router/log.js";
import { reroute, route } from "./router/route.js";
import { echoRouter } from "./router/routers/echo.js";
import { opencodeRouter } from "./router/routers/opencode.js";
import { loadTargets } from "./router/targets.js";

const cfg = defaultConfig();

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  allowNegative: true,
  options: {
    cwd: { type: "string" },
    ephemeral: { type: "boolean", default: false },
    reply: { type: "string" },
    thread: { type: "string" },
    archived: { type: "boolean", default: false },
    router: { type: "string", default: cfg.router },
    pin: { type: "string" },
    browser: { type: "boolean", default: false },
    targets: { type: "string", default: cfg.targetsPath },
    log: { type: "string", default: join(cfg.home, "routing.db") },
    context: { type: "string", default: join(cfg.home, "CONTEXT.md") },
    failed: { type: "string" },
    kind: { type: "string", default: "refusal" },
    excerpt: { type: "string", default: "" },
    server: { type: "string", default: `http://127.0.0.1:${cfg.port}` },
    json: { type: "boolean", default: false },
    watch: { type: "boolean", default: true },
    refresh: { type: "boolean", default: false },
    allow: { type: "boolean", default: false },
    deny: { type: "boolean", default: false },
  },
});
const [cmd, a1, a2] = positionals;
const client = new Client(values.server);
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

function splitPin(text: string): { harness: string; model: string } {
  const i = text.indexOf("/");
  if (i <= 0) throw new Error("--pin must be harness/model");
  return { harness: text.slice(0, i), model: text.slice(i + 1) };
}

function showEvent(ev: TaskEvent): void {
  const p = ev.payload as Record<string, unknown>;
  const t = new Date(ev.ts).toISOString().slice(11, 19);
  switch (ev.type) {
    case "routed": { const v = p.verdict as { ok: boolean; harness?: string; model?: string; notes?: string[] }; console.log(`${t} routed   ${v.ok ? `${v.harness}/${v.model}` : "NONE"} (${p.source}${p.routerMs ? `, ${p.routerMs} ms` : ""})${v.notes?.length ? `  ${v.notes.join("; ")}` : ""}`); break; }
    case "dispatched": console.log(`${t} dispatch ${p.harness}/${p.model}${p.effort ? ` effort=${p.effort}` : ""} [${p.chosen}]`); break;
    case "text": console.log(`${t}   ${String(p.text).replace(/\n/g, "\n           ")}`); break;
    case "tool_call": console.log(`${t}   tool ${p.tool}: ${p.command ?? JSON.stringify(p)}`); break;
    case "approval_request": console.log(`${t} ${p.kind === "question" ? "QUESTION" : "APPROVAL"} ${p.approvalId}: ${p.action}\n           ${p.evidence}`); break;
    case "approval_resolved": console.log(`${t} approval ${p.approvalId} -> ${p.decision} (${p.status}, by ${p.by ?? "user"})`); break;
    case "supervisor": console.log(`${t} supervisor ${p.kind}: ${p.decision ?? p.action ?? (p.accepted ? "accepted" : `rejected: ${(p.missing as string[] | undefined)?.join("; ") ?? ""}`)}${p.reason || p.note ? ` — ${p.reason ?? p.note}` : ""} [${p.source}]`); break;
    case "attempt_failed": console.log(`${t} FAILED   ${p.harness}/${p.model}: ${p.kind} "${p.excerpt}"${p.hadSideEffects ? " (side effects)" : ""}`); break;
    case "redispatch": console.log(`${t} reroute  ${p.kind}${p.target ? ` -> ${(p.target as { harness: string; model: string }).harness}/${(p.target as { model: string }).model}` : ""}${p.source ? ` (${p.source})` : ""}`); break;
    case "waiting": console.log(`${t} waiting  ${p.for}${p.taskId ? ` (${p.taskId})` : ""}`); break;
    case "agent": console.log(`${t}   agent ${p.status} ${p.description ?? p.agentId ?? ""}${p.summary ? `: ${String(p.summary).slice(0, 120)}` : ""}`); break;
    case "thread": console.log(`${t} thread   ${p.threadId} (${p.source}${p.confidence !== null && p.confidence !== undefined ? `, confidence ${p.confidence}` : ""})`); break;
    case "handoff": console.log(`${t} handoff  ${p.from ? `${(p.from as { harness: string }).harness} -> ` : ""}${p.to ? `${(p.to as { harness?: string }).harness ?? "?"}/${(p.to as { model?: string }).model ?? "?"}` : "router"} (${p.reason})${p.taskId ? `  task ${p.taskId}` : ""}`); break;
    case "summary": console.log(`${t} summary  ${p.ok ? `"${p.title}"${p.spoken ? ` — ${p.spoken}` : ""} (${p.ms} ms)` : `failed: ${p.error}`}`); break;
    case "done": console.log(`${t} DONE     ${p.result}`); break;
    case "failed": console.log(`${t} FAILED   ${p.error}${p.security ? "  [security]" : ""}`); break;
    case "cancelled": console.log(`${t} CANCELLED`); break;
    case "cleaned": console.log(`${t} cleaned  workdir=${p.workDirRemoved} claude=${(p.claudeProjectsRemoved as string[]).length} opencode=${p.opencodeSessionsRemoved}${(p.errors as string[]).length ? `  ${(p.errors as string[]).join("; ")}` : ""}`); break;
    default: console.log(`${t} ${ev.type} ${JSON.stringify(p)}`);
  }
}

async function watchInteractive(id: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await client.watch(id, async (ev) => {
      if (values.json) return out(ev);
      showEvent(ev);
      if (ev.type === "approval_request" && process.stdin.isTTY) {
        if (ev.payload.kind === "question") {
          const text = await new Promise<string>((r) => rl.question("           answer: ", r));
          if (text.trim()) await client.answer(id, String(ev.payload.approvalId), text.trim());
          else await client.approve(id, String(ev.payload.approvalId), "deny");
          return;
        }
        const answer = await new Promise<string>((r) => rl.question("           allow? [y/N] ", r));
        await client.approve(id, String(ev.payload.approvalId), /^y/i.test(answer) ? "allow" : "deny");
      }
    });
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  switch (cmd) {
    case "serve": {
      const handle = serve(cfg);
      process.on("SIGINT", () => { handle.close(); process.exit(0); });
      await new Promise(() => undefined);
      return 0;
    }
    case "task": {
      if (!a1) throw new Error('task "<text>"');
      const cwd = values.ephemeral || (values.reply && !values.cwd) ? undefined : resolve(values.cwd ?? process.cwd());
      const task = await client.submit(a1, cwd, { ...(values.pin ? { pin: splitPin(values.pin) } : {}), needsBrowser: values.browser, ephemeral: values.ephemeral, ...(values.reply ? { parentId: values.reply } : {}), ...(values.thread ? { threadId: values.thread } : {}) });
      if (values.json && !values.watch) return (out(task), 0);
      console.log(`task ${task.id} queued`);
      if (values.watch) await watchInteractive(task.id);
      return 0;
    }
    case "tasks": {
      const tasks = await client.tasks();
      if (values.json) return (out(tasks), 0);
      for (const t of tasks) console.log(`${t.id}  ${t.status.padEnd(16)} ${t.harness ? `${t.harness}/${t.model}` : "-"}  ${t.task.slice(0, 60)}`);
      return 0;
    }
    case "show": { if (!a1) throw new Error("show <id>"); out(await client.task(a1)); return 0; }
    case "watch": { if (!a1) throw new Error("watch <id>"); await watchInteractive(a1); return 0; }
    case "approve": {
      if (!a1 || !a2 || values.allow === values.deny) throw new Error("approve <task> <approval> --allow|--deny");
      out(await client.approve(a1, a2, values.allow ? "allow" : "deny")); return 0;
    }
    case "cancel": { if (!a1) throw new Error("cancel <id>"); out(await client.cancel(a1)); return 0; }
    case "answer": { if (!a1 || !a2 || !positionals[3]) throw new Error('answer <task> <approval> "<text>"'); out(await client.answer(a1, a2, positionals[3])); return 0; }
    case "policy": {
      if (!a1) { out(await client.policy()); return 0; }
      if (a1 !== "manual" && a1 !== "auto" && a1 !== "scoped") throw new Error("policy [manual|auto|scoped] [cat,cat,…]");
      out(await client.setPolicy({ mode: a1, ...(a2 ? { human: a2.split(",") } : {}) })); return 0;
    }
    case "handoff": {
      if (!a1) throw new Error("handoff <taskId> [--pin h/m]");
      const next = await client.handoff(a1, values.pin ? splitPin(values.pin) : undefined);
      console.log(`task ${next.id} queued in thread ${next.threadId}`);
      if (values.watch) await watchInteractive(next.id);
      return 0;
    }
    case "threads": {
      const list = await client.threads(values.archived ? "archived" : "open");
      if (values.json) return (out(list), 0);
      for (const t of list) console.log(`${t.id}  ${t.status.padEnd(8)} ${String(t.taskCount).padStart(2)} tasks  ${t.lastTarget ? `${t.lastTarget.harness}/${t.lastTarget.model}` : "-"}  ${(t.title ?? "(untitled)").slice(0, 50)}  ${t.cwd}`);
      return 0;
    }
    case "thread": { if (!a1) throw new Error("thread <id>"); out(await client.thread(a1)); return 0; }
    case "archive": { if (!a1) throw new Error("archive <id>"); out(await client.archiveThread(a1)); return 0; }
    case "reopen": { if (!a1) throw new Error("reopen <id>"); out(await client.reopenThread(a1)); return 0; }
    case "rmthread": { if (!a1) throw new Error("rmthread <id>"); out(await client.deleteThread(a1)); return 0; }
    case "approvals": { out(await client.approvals()); return 0; }
    case "quota": {
      const q = await client.quota(values.refresh) as { harness: string; remaining: number | null; source: string; error: string | null; detail: Record<string, unknown> }[];
      if (values.json) return (out(q), 0);
      for (const r of q) console.log(`${r.harness.padEnd(12)} ${r.remaining === null ? "  ?  " : `${Math.round(r.remaining * 100)}%`.padStart(5)}  ${r.error ? `ERROR ${r.error}` : JSON.stringify(r.detail)}`);
      return 0;
    }
    case "preview": { if (!a1) throw new Error('preview "<text>"'); out(await client.preview(a1, resolve(values.cwd ?? process.cwd()))); return 0; }
    case "log": { out(await client.routingLog()); return 0; }
    case "mcp": { out(await client.mcp()); return 0; }
    case "skills": { out(await client.skills()); return 0; }
    case "health": { out(await client.health()); return 0; }
    case "context": {
      if (a1 !== "init") { out(await client.context()); return 0; }
      if (existsSync(values.context)) console.log(`exists: ${values.context}`);
      else { mkdirSync(dirname(values.context), { recursive: true }); copyFileSync(CONTEXT_EXAMPLE, values.context); console.log(`written: ${values.context}`); }
      return 0;
    }
    case "route":
    case "reroute":
      return localRoute(cmd, a1);
    default:
      console.error("usage: serve | task | tasks | show | watch | approve | cancel | handoff | threads | thread | archive | reopen | rmthread | approvals | quota | preview | log | mcp | skills | health | context init | route | reroute");
      return 2;
  }
}

async function localRoute(kind: "route" | "reroute", task: string | undefined): Promise<number> {
  if (!task) throw new Error(`${kind} "<text>"`);
  const targets = loadTargets(values.targets);
  const context = loadContext(values.context);
  for (const w of context.warnings) console.error(`context warning: ${w}`);
  const router = values.router === "echo"
    ? echoRouter([JSON.stringify({ harness: targets.router.default.harness, model: null, brief: task, confidence: 0.9 })])
    : opencodeRouter({ model: targets.router.model });
  const deps = { targets, router, quota: {}, running: {}, context };
  if (kind === "reroute") {
    if (!values.failed) throw new Error("reroute needs --failed harness/model");
    const attempt = { ...splitPin(values.failed), kind: values.kind as FailureKind, excerpt: values.excerpt, sideEffects: NO_SIDE_EFFECTS };
    out(await reroute({ task, cwd: resolve(values.cwd ?? process.cwd()), needsBrowser: values.browser, decision: null, attempts: [attempt], routerAsks: 0 }, deps));
    return 0;
  }
  const pin = values.pin ? splitPin(values.pin) : undefined;
  const cwd = resolve(values.cwd ?? process.cwd());
  const result = await route({ task, cwd, ...(pin ? { pin } : {}), needsBrowser: values.browser }, deps);
  const log = new RoutingLog(values.log);
  const id = log.record(task, cwd, result);
  log.close();
  out({ id, ...result });
  return result.verdict.ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (err: Error) => { console.error(`error: ${err.message}`); process.exitCode = 1; });
