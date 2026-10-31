/** agentswitch CLI. Daemon-backed commands talk to http://127.0.0.1:4711; `route`/`reroute`/`context init` run locally.
 *
 *   serve                       start the daemon (AGENTSWITCH_ROUTER=echo, AGENTSWITCH_PORT=...; AGENTSWITCH_REMOTE=1 adds
 *                               the HTTPS listener for paired phones on AGENTSWITCH_REMOTE_PORT, default 4713)
 *   task "<text>" [--cwd d | --ephemeral] [--pin h/m] [--browser] [--no-watch] [--reply <taskId>]   (--reply: follow-up with context)
 *   tasks | show <id> | watch <id> | approve <task> <approval> --allow|--deny | cancel <id>
 *   handoff <taskId> [--pin h/m]     hand a task to another executor (same thread)
 *   threads [--archived] | thread <id> | archive <id> | reopen <id> | rmthread <id>
 *   approvals | quota [--refresh] | preview "<text>" [--cwd d] | log
 *   route "<text>" ... (local, no daemon) | reroute ... | context init
 *   engine [check [--prerelease]] | engine update [--camoufox <version>|latest] [--playwright <version>|bundled] [--prerelease]
 *     | engine cancel         the browser engine, Camoufox and its Playwright (docs/browser-v0.md §7): what is installed,
 *                               what could be, updating the pair (download, digest, self-check, switch, the old copy deleted)
 *   browser-mcp --session <id> --token-file <file>   the shared browser's agent bridge on stdio (docs/browser-v0.md §2),
 *                               as `secret-gate browser -- agentswitch browser-mcp …` (the terminals run the same script)
 *   pair [--one-way]            a pairing code and its link for a phone or another node (docs/mesh-v0.md §2.2); another
 *                               node that pastes the link is used back unless `--one-way`
 *   devices | devices revoke <id>   who uses this node
 *   nodes | nodes add <link> [--one-way] | nodes remove <node> [--both]   the nodes this one uses: `add` pairs with one
 *                               from its link and offers this node in return (`--one-way`: does not); `remove` stops
 *                               using one (`--both`: and it stops using this one)
 *   --on <node>                 with any daemon-backed command: the same on another node, by its id or name
 *                               (`agentswitch --on studio tasks`)
 *   node [run | name ["<name>"] | restart]   this node (docs/mesh-v0.md §4): what it is and offers; `run` keeps the gate
 *                               and the daemon running in the foreground (what the systemd service runs, and the Mac
 *                               app does on a Mac); `name` names it; `restart` restarts the daemon with node.json
 *   service install | uninstall | status | start | stop | restart | logs   the systemd user service that runs `node run`
 *   doctor                      what this node has and lacks: runtime, service, agents and their sign-ins, tools
 *   profiles [new | api | color | rm …]   the agents' profiles (docs/profiles-v0.md), what the Mac's Settings › Agents
 *                               does: `new <agent> "<name>" [--api] [--base-url u] [--model m]`, `api <agent> <profile>
 *                               [--base-url u] [--model m] [--key]` (a key asked for, never echoed, sealed by this
 *                               node's gate), `color`, `rm`; with --on, listing only (keeper/profiles.ts)
 *   console [--open]            a one-time link that signs a browser on this machine into the web console
 *   config [agents | models | permissions | keys | node | environment | context | extensions] [--lang <en|zh-Hans|
 *                               zh-Hant|ja|es>]   this node's settings on a full screen (docs/tui-v0.md): profiles and
 *                               their keys, models, approvals, the gate's key pairs, the node's own, doctor, CONTEXT.md
 *                               and MEMORY.md, MCP servers and skills; with --on another node's, read only (tui/)
 */

import { readLocalToken } from "./api/localAuth.js";
import { NODES_KEY_HEADER, readNodesKey } from "./nodes/book.js";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Client } from "./client.js";
import { defaultConfig, serve } from "./daemon.js";
import type { TaskEvent } from "./engine/types.js";
import { CONTEXT_EXAMPLE } from "./router/context.js";
import { loadContext } from "./core/contextDoc.js";
import { NO_SIDE_EFFECTS, type FailureKind } from "./core/outcome.js";
import { RoutingLog } from "./router/log.js";
import { reroute, route } from "./router/route.js";
import { echoRouter } from "./router/routers/echo.js";
import { opencodeRouter } from "./router/routers/opencode.js";
import { loadTargets } from "./router/targets.js";
import { withModelOverlay } from "./router/modelOverlay.js";
import { doctor } from "./keeper/doctor.js";
import { layout, readSettings, writeSettings } from "./keeper/plan.js";
import { qrLines } from "./keeper/qr.js";
import { homes, runningKeeper, runNode } from "./keeper/run.js";
import { service } from "./keeper/systemd.js";
import { profilesCommand, readKey, sealWithGate } from "./keeper/profiles.js";
import { localeOf, messages, pickLocale } from "./i18n/index.js";
import { GateKeys, gateRunner } from "./keeper/gateKeys.js";

const cfg = defaultConfig();
// A node without the Mac app keeps its ports in node.json (keeper/plan.ts); the commands find its service there too.
const nodePort = (() => { try { return process.env.AGENTSWITCH_PORT ? null : readSettings(cfg.home).ports?.local ?? null; } catch { return null; } })();
/** How much of an agent summary, a task and a thread title one output line shows. */
const SUMMARY_CHARS = 120;
const TASK_CHARS = 60;
const TITLE_CHARS = 50;

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
    server: { type: "string", default: `http://127.0.0.1:${nodePort ?? cfg.port}` },
    camoufox: { type: "string" },
    playwright: { type: "string" },
    prerelease: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    qr: { type: "boolean", default: true },
    open: { type: "boolean", default: false },
    watch: { type: "boolean", default: true },
    refresh: { type: "boolean", default: false },
    allow: { type: "boolean", default: false },
    deny: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    session: { type: "string" },
    on: { type: "string" },
    "one-way": { type: "boolean", default: false },
    both: { type: "boolean", default: false },
    "token-file": { type: "string" },
    // profiles (keeper/profiles.ts)
    api: { type: "boolean", default: false },
    "base-url": { type: "string" },
    model: { type: "string" },
    key: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    // config (tui/)
    lang: { type: "string" },
    // Added by `secret-gate browser` for a Playwright MCP of its own; the bridge has no files of its own to put there.
    "output-dir": { type: "string" },
  },
});
const [cmd, a1, a2] = positionals;
const nodesKey = readNodesKey(cfg.home);
/** This node's own service; `client` is the node the command is for (`--on`), which is this one unless said. */
const here = new Client(values.server, fetch, readLocalToken(cfg.home), nodesKey ? { [NODES_KEY_HEADER]: nodesKey } : {});
const client = values.on ? here.on(values.on) : here;
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
    case "refusal": console.log(`${t} refusal  ${p.action}: ${p.note ?? p.reason ?? ""}`); break;
    case "redispatch": console.log(`${t} reroute  ${p.kind}${p.target ? ` -> ${(p.target as { harness: string; model: string }).harness}/${(p.target as { model: string }).model}` : ""}${p.source ? ` (${p.source})` : ""}`); break;
    case "waiting": console.log(`${t} waiting  ${p.for}${p.taskId ? ` (${p.taskId})` : ""}`); break;
    case "agent": console.log(`${t}   agent ${p.status} ${p.description ?? p.agentId ?? ""}${p.summary ? `: ${String(p.summary).slice(0, SUMMARY_CHARS)}` : ""}`); break;
    case "thread": console.log(`${t} thread   ${p.threadId} (${p.source}${p.confidence !== null && p.confidence !== undefined ? `, confidence ${p.confidence}` : ""})`); break;
    case "handoff": console.log(`${t} handoff  ${p.from ? `${(p.from as { harness: string }).harness} -> ` : ""}${p.to ? `${(p.to as { harness?: string }).harness ?? "?"}/${(p.to as { model?: string }).model ?? "?"}` : "router"} (${p.reason})${p.taskId ? `  task ${p.taskId}` : ""}`); break;
    case "summary": console.log(`${t} summary  ${p.ok ? `"${p.title}"${p.spoken ? ` — ${p.spoken}` : ""} (${p.ms} ms)` : `failed: ${p.error}`}`); break;
    case "done": console.log(`${t} DONE     ${p.result}`); break;
    case "partial": console.log(`${t} PARTIAL  ${p.result || p.error || "部分完成"}`); break;
    case "blocked": console.log(`${t} BLOCKED  ${p.error || p.result || "等待补充条件"}`); break;
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

const USAGE = "usage: serve | engine | task | tasks | show | watch | approve | cancel | handoff | threads | thread | archive | reopen | rmthread | approvals | quota | preview | log | mcp | skills | health | context init | route | reroute | browser-mcp | pair | devices | nodes [add|remove] | node [run|name|restart] | service | doctor | profiles [new|api|color|rm] | config [page] [--lang l] | console; --on <node>";

const ago = (ts: number | null): string => {
  if (ts === null) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129_600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
};

async function main(): Promise<number> {
  if (values.help) { console.log(USAGE); return 0; }
  switch (cmd) {
    case "serve": {
      const handle = await serve(cfg);
      // A second signal does not wait for the first to finish.
      let stopping = false;
      const stop = () => { if (stopping) process.exit(0); stopping = true; void handle.stop().finally(() => process.exit(0)); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
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
      for (const t of tasks) console.log(`${t.id}  ${t.status.padEnd(16)} ${t.harness ? `${t.harness}/${t.model}` : "-"}  ${t.task.slice(0, TASK_CHARS)}`);
      return 0;
    }
    case "show": { if (!a1) throw new Error("show <id>"); out(await client.task(a1)); return 0; }
    case "watch": { if (!a1) throw new Error("watch <id>"); await watchInteractive(a1); return 0; }
    case "approve": {
      if (!a1 || !a2 || values.allow === values.deny) throw new Error("approve <task> <approval> --allow|--deny");
      out(await client.approve(a1, a2, values.allow ? "allow" : "deny")); return 0;
    }
    case "cancel": { if (!a1) throw new Error("cancel <id>"); out(await client.cancel(a1)); return 0; }
    case "rate": { if (!a1 || !["up", "down", "clear"].includes(a2 ?? "")) throw new Error("rate <task> up|down|clear"); out(await client.rate(a1, a2 === "up" ? 1 : a2 === "down" ? -1 : null)); return 0; }
    case "answer": { if (!a1 || !a2 || !positionals[3]) throw new Error('answer <task> <approval> "<text>"'); out(await client.answer(a1, a2, positionals[3])); return 0; }
    case "policy": {
      if (!a1) { out(await client.policy()); return 0; }
      if (a1 !== "manual" && a1 !== "auto" && a1 !== "scoped" && a1 !== "skip") throw new Error("policy [manual|auto|scoped|skip] [cat,cat,…]");
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
      for (const t of list) console.log(`${t.id}  ${t.status.padEnd(8)} ${String(t.taskCount).padStart(2)} tasks  ${t.lastTarget ? `${t.lastTarget.harness}/${t.lastTarget.model}` : "-"}  ${(t.title ?? "(untitled)").slice(0, TITLE_CHARS)}  ${t.cwd}`);
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
    // docs/mesh-v0.md: who uses this node, and the nodes it uses. Always this node's own service, whatever `--on` says.
    case "pair": {
      const before = new Set((await here.devices()).map((d) => d.id));
      const p = await here.pairing(!values["one-way"]);
      if (values.json) { out(p); return 0; }
      if (values.qr && process.stdout.isTTY) console.log(`${qrLines(p.link).join("\n")}\n`);
      const info = await here.remoteInfo().catch(() => null);
      const fp = info?.fingerprint ? info.fingerprint.match(/.{1,4}/g)!.join(" ") : null;
      console.log(`code   ${p.code}   (once, for ${Math.round((p.expiresAt - Date.now()) / 60_000)} minutes)\nlink   ${p.link}${info ? `\nname   ${info.name}  port ${info.port}\naddr   ${[...info.lan, ...info.tailnet].join("  ") || "none found"}` : ""}${fp ? `\nfp     ${fp}` : ""}\n\nOn a phone: scan the code in the app, or paste the link. On another node: agentswitch nodes add '<link>'${values["one-way"] ? "\nOne way: that node will use this one; this one will not use it." : ""}`);
      if (!process.stdout.isTTY) return 0;
      // Who redeems it (Ctrl-C stops waiting; the code stays good until it expires).
      console.log("\nwaiting for a device to pair…");
      while (Date.now() < p.expiresAt) {
        await new Promise((r) => setTimeout(r, 2000));
        const added = (await here.devices()).filter((d) => !before.has(d.id));
        if (added.length) { for (const d of added) console.log(`paired: ${d.name} (${d.platform}, ${d.id})`); return 0; }
      }
      console.log("the code expired");
      return 1;
    }
    case "devices": {
      if (a1 === "revoke") { if (!a2) throw new Error("devices revoke <id>"); out(await here.revokeDevice(a2)); return 0; }
      const list = await here.devices();
      if (values.json) { out(list); return 0; }
      for (const d of list) console.log(`${d.id}  ${d.revokedAt !== null ? "revoked" : d.online ? "online " : "       "}  ${d.platform.padEnd(6)}  ${d.name}  (seen ${ago(d.lastSeenAt)})`);
      if (!list.length) console.log("no device is paired with this node");
      return 0;
    }
    case "nodes": {
      if (a1 === "add") {
        if (!a2) throw new Error("nodes add <link> [--one-way]");
        const r = await here.addNode(a2, !values["one-way"]);
        if (values.json) { out(r); return 0; }
        const way = r.back === "paired" ? "both ways" : r.back === "none" ? "one way (this node uses it)" : r.back === "declined" ? "one way: it did not take this node in return" : "one way: it could not reach this node in return";
        console.log(`paired with ${r.node.name} (${r.node.id}), ${way}`);
        return 0;
      }
      if (a1 === "remove") {
        if (!a2) throw new Error("nodes remove <node> [--both]");
        const r = await here.removeNode(a2, values.both);
        if (values.json) { out(r); return 0; }
        console.log(`removed ${r.node.name}${r.told ? "" : " (it could not be told; its list still has this node)"}${r.inboundRevoked ? "; it no longer uses this node" : r.node.inbound ? "; it still uses this node (--both ends that too)" : ""}`);
        return 0;
      }
      if (a1) throw new Error("nodes | nodes add <link> [--one-way] | nodes remove <node> [--both]");
      const { self, nodes } = await here.nodes();
      if (values.json) { out({ self, nodes }); return 0; }
      console.log(`this node  ${self.name}${self.listening ? `  (port ${self.port})` : "  (not listening: it can use other nodes, none can use it)"}`);
      for (const n of nodes) {
        const state = n.state === "online" ? `online${n.waiting ? `, ${n.waiting} waiting` : ""}` : n.state === "revoked" ? "removed there" : "offline";
        console.log(`${n.id}  ${n.name}  ${state}${n.address ? `  ${n.address}` : ""}  ${n.inbound ? "both ways" : "this node uses it"}`);
      }
      if (!nodes.length) console.log("this node uses no other node");
      return 0;
    }
    case "context": {
      if (a1 !== "init") { out(await client.context()); return 0; }
      if (existsSync(values.context)) console.log(`exists: ${values.context}`);
      else { mkdirSync(dirname(values.context), { recursive: true }); copyFileSync(CONTEXT_EXAMPLE, values.context); console.log(`written: ${values.context}`); }
      return 0;
    }
    case "route":
    case "reroute":
      return localRoute(cmd, a1);
    case "engine": {
      if (!a1) { out(await client.browserEngine()); return 0; }
      if (a1 === "check") { out(await client.browserEngine({ check: true, prerelease: values.prerelease })); return 0; }
      if (a1 === "cancel") { out(await client.cancelBrowserEngine()); return 0; }
      if (a1 !== "update") throw new Error("engine [check] | engine update [--camoufox <version>|latest] [--playwright <version>|bundled] | engine cancel");
      await client.updateBrowserEngine({ ...(values.camoufox ? { camoufox: values.camoufox } : {}), ...(values.playwright ? { playwright: values.playwright } : {}), ...(values.prerelease ? { prerelease: true } : {}) });
      // Its progress, a line a phase, until it is over.
      let said = "";
      for (;;) {
        const { update } = await client.browserEngine();
        const line = update.running ? `${update.phase ?? "starting"}${update.part ? ` ${update.part}` : ""}${update.phase === "download" && update.total ? ` ${Math.floor(100 * (update.received ?? 0) / update.total)}%` : ""}` : "";
        if (line && line !== said) { console.log(line); said = line; }
        if (!update.running) {
          console.log(update.ok === false ? `not updated: ${update.error ?? ""}` : "updated");
          out(await client.browserEngine());
          return update.ok === false ? 1 : 0;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    case "node": {
      const { home, runDir } = homes();
      const hup = (): boolean => { const pid = runningKeeper(runDir); if (!pid) return false; process.kill(pid, "SIGHUP"); return true; };
      if (a1 === "run") return runNode();
      if (a1 === "restart") { if (!hup()) throw new Error("no keeper runs for this home (agentswitch service start)"); console.log("restarting the daemon"); return 0; }
      if (a1 === "name") {
        if (a2 === undefined) { console.log(readSettings(home).name ?? "(the host name)"); return 0; }
        const settings = readSettings(home);
        writeSettings(home, a2.trim() ? { ...settings, name: a2.trim() } : Object.fromEntries(Object.entries(settings).filter(([k]) => k !== "name")));
        console.log(`named ${a2.trim() || "after the host"}${hup() ? "; restarting the daemon" : "; takes effect when the service starts"}`);
        return 0;
      }
      if (a1) throw new Error('node [run | name ["<name>"] | restart]');
      const [self, info] = await Promise.all([here.node(), here.remoteInfo()]);
      if (values.json) { out({ ...self, remote: info, settings: readSettings(home) }); return 0; }
      console.log(`name   ${self.name} (${self.kind}, ${self.version})\nhome   ${self.home}\nhas    ${self.has.join(" ")}`);
      if (info.enabled) console.log(`port   ${info.port}\nfp     ${info.fingerprint!.match(/.{1,4}/g)!.join(" ")}\nlan    ${info.lan.join("  ") || "-"}\noverlay ${info.tailnet.join("  ") || "-"}\nonline ${info.onlineDevices} device(s)`);
      else console.log("remote access is off (node.json \"remote\": false)");
      return 0;
    }
    case "service": return service(a1, layout());
    case "doctor": return doctor();
    case "profiles": {
      const gate = { bin: layout().gate, home: homes().gateHome };
      return profilesCommand(positionals.slice(1), { api: values.api, baseUrl: values["base-url"], model: values.model, key: values.key, force: values.force, json: values.json, remote: Boolean(values.on) }, {
        client, readKey: (prompt) => readKey(prompt), print: (line) => console.log(line),
        seal: (host, value) => {
          if (!existsSync(gate.bin)) throw new Error(`no secret-gate at ${gate.bin}: the key is sealed by this node's gate`);
          return sealWithGate(gate, host, value);
        },
      });
    }
    case "config": {
      const { home, runDir } = homes();
      const kept = (() => { try { return readSettings(home).language; } catch { return undefined; } })();
      if (values.lang && !localeOf(values.lang)) throw new Error(messages(pickLocale({ kept })).common.unknownLanguage(values.lang));
      const locale = pickLocale({ asked: values.lang, kept });
      if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error(messages(locale).common.needsTerminal); return 2; }
      const gate = { bin: layout().gate, home: homes().gateHome };
      const { runConfig } = await import("./tui/run.js");
      const { editText } = await import("./tui/editor.js");
      return runConfig({
        client, remote: values.on ?? null,
        seal: (label, host, value) => {
          if (!existsSync(gate.bin)) throw new Error(`no secret-gate at ${gate.bin}: what is typed is sealed by this node's gate`);
          return sealWithGate(gate, host, value, undefined, label);
        },
        node: {
          read: () => readSettings(home),
          write: (next) => writeSettings(home, next),
          restart: () => { const pid = runningKeeper(runDir); if (!pid) return false; process.kill(pid, "SIGHUP"); return true; },
        },
        edit: async (text, name) => editText(text, name),
        keys: new GateKeys(gateRunner(gate)),
        doctor: async () => { const lines: string[] = []; await doctor(process.env, (l) => lines.push(l)); return lines; },
      }, locale, a1);
    }
    case "console": {
      const { path } = await here.consoleLink();
      const url = `${values.server}${path}`;
      console.log(`${url}\n(one use, within a minute; from another machine: ssh -L ${new URL(values.server).port}:127.0.0.1:${new URL(values.server).port} <this host> first)`);
      if (values.open) spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
      return 0;
    }
    case "browser-mcp": {
      const { bridgeArgs, runBridge } = await import("./browser/bridgeClient.js");
      return runBridge(bridgeArgs(["--url", values.server, ...(values.session ? ["--session", values.session] : []), ...(values["token-file"] ? ["--token-file", values["token-file"]] : [])]));
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

async function localRoute(kind: "route" | "reroute", task: string | undefined): Promise<number> {
  if (!task) throw new Error(`${kind} "<text>"`);
  const targets = withModelOverlay(loadTargets(values.targets), join(cfg.home, "models.json"));
  const context = loadContext(values.context);
  for (const w of context.warnings) console.error(`context warning: ${w}`);
  const router = values.router === "echo"
    ? echoRouter([JSON.stringify({ harness: targets.router.default.harness, model: null, brief: task, confidence: 0.9 })])
    : opencodeRouter({ model: targets.router.model });
  const deps = { targets, router, quota: {}, context };
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
