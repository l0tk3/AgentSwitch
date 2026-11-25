/** agentswitch CLI. Daemon-backed commands talk to http://127.0.0.1:4711.
 *
 *   serve                       start the daemon (AGENTSWITCH_PORT=...; AGENTSWITCH_REMOTE=1 adds the HTTPS listener for
 *                               paired phones on AGENTSWITCH_REMOTE_PORT, default 4713)
 *   health                      whether the service answers, and its version
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
 *                               (`agentswitch --on studio profiles`)
 *   node [run | name ["<name>"] | restart]   this node (docs/mesh-v0.md §4): what it is and offers; `run` keeps the gate
 *                               and the daemon running in the foreground (what the systemd service runs, and the Mac
 *                               app does on a Mac); `name` names it; `restart` restarts the daemon with node.json
 *   service install | uninstall | status | start | stop | restart | logs   the systemd user service that runs `node run`
 *   doctor                      what this node has and lacks: runtime, service, agents and their sign-ins, tools
 *   gate [--lang l]             where this node's gate runs (gate-simple-v0 §5): as you, or as the system service under
 *                               its own account, and the exact `sudo secret-gate system …` command to run (never run here)
 *   profiles [new | api | color | rm …]   the agents' profiles (docs/profiles-v0.md), what the Mac's Settings › Agents
 *                               does: `new <agent> "<name>" [--api] [--base-url u] [--model m]`, `api <agent> <profile>
 *                               [--base-url u] [--model m] [--key]` (a key asked for, never echoed, sealed by this
 *                               node's gate), `color`, `rm`; with --on, listing only (keeper/profiles.ts)
 *   console [--open]            a one-time link that signs a browser on this machine into the web console
 *   config [agents | node | environment] [--lang <en|zh-Hans|zh-Hant|ja|es>]   this node's settings on a full screen
 *                               (docs/tui-v0.md): profiles and their keys, the node's own, doctor; with --on another
 *                               node's, read only (tui/)
 *   leftovers [end]             what the terminals left running (docs/terminal-v0.md §11); `end` ends it now
 */

import { readLocalToken } from "./api/localAuth.js";
import { NODES_KEY_HEADER, readNodesKey } from "./nodes/book.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "./client.js";
import { defaultConfig, serve } from "./daemon.js";
import { doctor } from "./keeper/doctor.js";
import { layout, readSettings, writeSettings } from "./keeper/plan.js";
import { qrLines } from "./keeper/qr.js";
import { homes, runningKeeper, runNode } from "./keeper/run.js";
import { service } from "./keeper/systemd.js";
import { profilesCommand, readKey, sealWithGate } from "./keeper/profiles.js";
import { localeOf, messages, pickLocale } from "./i18n/index.js";
import { gateReport, reportLines } from "./keeper/gateService.js";
import { portsOf } from "./keeper/plan.js";

const cfg = defaultConfig();
// A node without the Mac app keeps its ports in node.json (keeper/plan.ts); the commands find its service there too.
const nodePort = (() => { try { return process.env.AGENTSWITCH_PORT ? null : readSettings(cfg.home).ports?.local ?? null; } catch { return null; } })();
/** How much of a command one output line shows. */
const COMMAND_CHARS = 60;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  allowNegative: true,
  options: {
    server: { type: "string", default: `http://127.0.0.1:${nodePort ?? cfg.port}` },
    camoufox: { type: "string" },
    playwright: { type: "string" },
    prerelease: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    qr: { type: "boolean", default: true },
    open: { type: "boolean", default: false },
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

const USAGE = "usage: serve | health | engine | browser-mcp | pair | devices | nodes [add|remove] | node [run|name|restart] | service | doctor | gate | leftovers [end] | profiles [new|api|color|rm] | config [page] [--lang l] | console; --on <node>";

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
    case "gate": {
      // Where the gate runs and the command to change that (gate-simple-v0 §5); sudo is the user's to run.
      const { home } = homes();
      let settings = {} as ReturnType<typeof readSettings>;
      try { settings = readSettings(home); } catch { /* defaults */ }
      const locale = pickLocale({ asked: values.lang, kept: settings.language });
      const report = await gateReport({ layout: layout(), ports: portsOf(settings), uid: process.getuid?.() ?? 0 });
      const lines = reportLines(report, messages(locale).gateMode);
      if (values.json) { out({ mode: report.mode, status: report.status, commands: report.commands }); return 0; }
      console.log(lines.length ? lines.join("\n") : report.mode.kind);
      return 0;
    }
    case "leftovers": {
      // What the terminals left running (docs/terminal-v0.md §11); `leftovers end` ends them now.
      const { on, leftovers } = await client.leftovers();
      if (values.json) { out(leftovers); return 0; }
      if (!on) console.log("this service does not clean what its terminals leave behind (AGENTSWITCH_LEFTOVERS=0)");
      if (!leftovers.length) { console.log("nothing left behind"); return 0; }
      for (const p of leftovers) console.log(`${String(p.pid).padStart(6)}  ${p.terminal}  ${p.elapsed.padStart(11)}  ${String(Math.round(p.rssKb / 1024)).padStart(5)} MB  ${p.cpu.toFixed(1).padStart(5)}%  ${p.command.slice(0, COMMAND_CHARS)}`);
      if (a1 === "end") { const { ended } = await client.endLeftovers(); console.log(`ended ${ended.length}`); }
      return 0;
    }
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
        doctor: async () => { const lines: string[] = []; await doctor(process.env, (l) => lines.push(l), locale); return lines; },
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

main().then((code) => { process.exitCode = code; }, (err: Error) => { console.error(`error: ${err.message}`); process.exitCode = 1; });
