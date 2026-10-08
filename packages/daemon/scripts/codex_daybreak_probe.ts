/** A Codex terminal started with its Daybreak switch on offer (docs/simple-view-v0.md §5.8), for real: the service's
 *  own code, YOUR Codex — its login, its config. It only LOOKS: it starts the terminal, types nothing into it, sends
 *  no message (so no turn runs and nothing goes out under Daybreak), turns no switch (so Codex writes no default),
 *  reads what the service says of the switch and what Codex's own screen says, and closes the terminal.
 *
 *    PROBE_CWD=<a folder your Codex already trusts> npx tsx scripts/codex_daybreak_probe.ts
 *
 *  What it shows, a line each: the terminal starts with the feature enabled, attached to its own server; how the
 *  service reads the switch as it starts and a few seconds later (your own default, then the thread's); the lines of
 *  Codex's screen that name Daybreak; that `/daybreak` is among the commands offered; and that your Codex's config,
 *  its background server and its sessions are as they were.
 *
 *  Not shown, on purpose: turning the switch. Codex writes its default (`daybreak` in ~/.codex/config.toml) each time
 *  it is turned — that is yours to do. Not a test. */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import headless from "@xterm/headless";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { AppServerClient } from "../src/harness/appserver.js";
import { connectWsLines } from "../src/harness/wsLines.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { CodexCompanion } from "../src/terminals/codexTerminal.js";
import { agentLauncher } from "../src/terminals/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const CODEX = process.env.CODEX_BIN ?? join(homedir(), ".local/share/agentswitch/cli/codex/beta/0.162.0-alpha.18/bin/codex");
const cwd = process.env.PROBE_CWD;
if (!cwd || !existsSync(cwd) || !existsSync(CODEX)) { console.log("PROBE_CWD=<a folder your Codex already trusts> is needed, and Codex at", CODEX); process.exit(1); }
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const sha = (f: string) => (existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 12) : "-");
const daemons = () => execSync("ps -axo command | grep -c '[m]anaged-daemon' || true").toString().trim();
/** Its session files of today, newest first: what the probe may have added. */
const sessionsNow = () => {
  const d = new Date(), dir = join(CODEX_HOME, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];
};
const before = { config: sha(join(CODEX_HOME, "config.toml")), daemons: daemons(), sessions: new Set(sessionsNow()) };

// (`serversLeft` at the end counts every such server on this Mac: your own Codex terminals' too.)
const base = join(here, "..", "node_modules", ".cache");
mkdirSync(base, { recursive: true });
const tmp = realpathSync(mkdtempSync(join(base, "as-codex-daybreak-")));
const home = join(tmp, "as");
mkdirSync(home);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (what: string, ...rest: unknown[]) => console.log(what, ...rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))));

let port = 0;
const cfg = { home, targetsPath: resolve(here, "..", "config", "targets.yaml"), port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" } as unknown as DaemonConfig;
// As the service's own environment is: not a terminal's (see codex_terminal_real_probe.ts).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(CLAUDE|AGENTSWITCH_TERMINAL)/.test(k) && !/^(https?_proxy|all_proxy|no_proxy|ssl_cert_file|requests_ca_bundle|node_extra_ca_certs|secret_gate_home)$/i.test(k))) as NodeJS.ProcessEnv;
// No hooks (they need the installed app's own command, which this does not use): the switch does not depend on them.
// `PROBE_FEATURE=off`: as a terminal is started where Codex has no such switch, to compare.
const offered = process.env.PROBE_FEATURE !== "off";
const launch = agentLauncher({ binaries: { codex: CODEX } as never, hookUrl: () => `http://127.0.0.1:${port}`, stateDir: join(home, "terminals"), env,
  codexHooks: () => false, codexServer: true, codexDaybreak: () => offered });
// The same terminal with one thing more, for the probe's eyes only: Codex's own status line with its Daybreak item,
// which says how the TUI itself holds the switch ("Daybreak on" / "Daybreak off") without a key being pressed.
const daemon = buildDaemon(cfg, { terminalLauncher: (req) => {
  const plan = launch(req);
  const args = [...plan.args, "-c", 'tui.status_line=["model-with-reasoning","daybreak"]'];
  return { ...plan, companion: new CodexCompanion({ binary: CODEX, cwd: req.cwd, env: plan.env, args, dir: join(home, "terminals", req.id), daybreak: offered }) };
} });
const token = ensureLocalToken(home);
const server = await new Promise<{ close(): void }>((done) => { const s = listenLocal(daemon, 0, (info: AddressInfo) => { port = info.port; done(s); }, new LocalAuth(token)); });
daemon.setLocalPort(port);
const api = `http://127.0.0.1:${port}`;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(api + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};

let id = "";
try {
  const started = await call("POST", "/terminals", { harness: "codex", cwd, mode: "manual" });
  if (started.status >= 300) throw new Error(`could not start: ${started.status} ${JSON.stringify(started.json)}`);
  id = started.json.terminal.id as string;
  say("started · the service reads its switch at once as:", { daybreak: started.json.terminal.daybreak });
  // Its own two processes, among any other Codex terminals this Mac runs: the server by the token file in this
  // probe's folder, the TUI by that server's address.
  const all = execSync("ps -axo command").toString().split("\n");
  const srv = all.find((l) => l.includes("app-server --listen ws://127.0.0.1") && l.includes(tmp)) ?? "";
  const at = /--listen (ws:\/\/127\.0\.0\.1:\d+)/.exec(srv)?.[1] ?? "(none)";
  const tui = all.find((l) => l.includes(`--remote ${at}`)) ?? "";
  say("its server:", { running: !!srv, featureOn: srv.includes("features.cli_daybreak=true") });
  say("its TUI:", { attachedToItsOwnServer: !!tui, featureOn: tui.includes("features.cli_daybreak=true") });

  // Its screen, followed from the stream. Nothing is ever written to it.
  const term = new headless.Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 2000 });
  const ctl = new AbortController();
  void (async () => {
    const res = await fetch(`${api}/terminals/${id}/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal }).catch(() => null);
    if (!res?.body) return;
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += Buffer.from(chunk).toString("utf8");
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "message";
        const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
        let json: any = null; try { json = JSON.parse(data); } catch { /* not json */ }
        if ((event === "snapshot" || event === "output") && typeof json?.data === "string") term.write(json.data);
        if (event === "daybreak") say("   (the stream says: daybreak", json?.on, ")");
      }
    }
  })().catch(() => undefined);
  const lines = () => { const b = term.buffer.active, out: string[] = []; for (let y = b.baseY; y < b.baseY + term.rows; y++) out.push(b.getLine(y)?.translateToString(true) ?? ""); return out.filter((l) => l.trim()); };

  // Until its screen has settled (its prompt, or a question of its own — which is left alone).
  let last = "", still = 0;
  for (let t = 0; t < 40000 && still < 4000; t += 500) { await sleep(500); const now = lines().join("\n"); if (now && now === last) still += 500; else { still = 0; last = now; } }
  say("its screen, the last lines (nothing was typed):");
  for (const l of lines().filter((l) => !/[\u2800-\u28ff]/.test(l)).slice(-12)) console.log("     │" + l.trimEnd().slice(0, 130));
  say("lines of its screen that name Daybreak (its status line is how its TUI holds the switch):", lines().filter((l) => /daybreak/i.test(l)).map((l) => l.trim().slice(0, 110)));
  const info = (await call("GET", `/terminals/${id}`)).json.terminal as Record<string, any>;
  say("a few seconds on, the service reads its switch as:", { daybreak: info.daybreak, status: info.status, session: info.agentSessionId ? String(info.agentSessionId).slice(0, 8) + "…" : null });
  // What its server holds, asked as one more client (reads only): the threads, each one's saved choice, its default.
  try {
    const ws = await connectWsLines(at, { token: readFileSync(join(home, "terminals", id, "codex-server-token"), "utf8"), timeoutMs: 8000 });
    const rpc = new AppServerClient(ws.input, ws.output, async () => ({}), () => undefined);
    await rpc.request("initialize", { clientInfo: { name: "agentswitch-probe", version: "0" }, capabilities: { experimentalApi: true } }, 8000);
    rpc.notify("initialized");
    const loaded = (((await rpc.request("thread/loaded/list", {}, 8000)).data as unknown[] | undefined) ?? []).map(String);
    for (const th of loaded) {
      const read = ((await rpc.request("thread/read", { threadId: th, includeTurns: false }, 8000)).thread ?? {}) as Record<string, unknown>;
      say("  a thread its server holds:", { id: th.slice(0, 8) + "…", ephemeral: read.ephemeral ?? false, daybreakEnabled: read.daybreakEnabled ?? null, model: read.model ?? null });
    }
    if (!loaded.length) say("  its server holds no thread yet");
    const config = ((await rpc.request("config/read", { includeLayers: false, cwd }, 8000)).config ?? {}) as Record<string, any>;
    say("  its server's config:", { daybreak: config.daybreak ?? config.additional?.daybreak ?? null, cli_daybreak: config.features?.cli_daybreak ?? null });
    ws.close();
  } catch (e) { say("  (its server could not be asked:", String(e), ")"); }
  const commands = ((await call("GET", `/terminals/${id}/commands`)).json.commands ?? []) as { name: string; description?: string }[];
  say("its commands as the reply box offers them include:", commands.filter((c) => c.name === "daybreak"));
  ctl.abort();
} catch (e) {
  say("FAILED:", String(e));
} finally {
  if (id) await call("DELETE", `/terminals/${id}`).catch(() => undefined);
  await sleep(2500);
  server.close(); daemon.close();
  try { execSync(`pkill -9 -f ${JSON.stringify(tmp)} || true`); } catch { /* none */ }
  rmSync(tmp, { recursive: true, force: true });
  const added = sessionsNow().filter((f) => !before.sessions.has(f));
  say("your Codex afterwards:", { configUnchanged: sha(join(CODEX_HOME, "config.toml")) === before.config, backgroundServers: `${before.daemons} → ${daemons()}`,
    sessionFilesAdded: added.map((f) => `${f.split("/").pop()} (${statSync(f).size} bytes)`), serversLeft: execSync("ps -axo command | grep -c '[a]pp-server --listen ws://127.0.0.1' || true").toString().trim() });
  process.exit(0);
}
