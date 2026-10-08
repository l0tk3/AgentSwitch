/** What a real Claude Code shows on its screen while it works — the line with its spinner, how long, how many tokens —
 *  and what the service reads from it for the screens' "Working" line (docs/simple-view-v0.md §5.9). The service's own
 *  code, YOUR Claude Code: its login, a real model (Haiku), one turn that writes a few hundred words.
 *
 *    npx tsx scripts/claude_working_probe.ts
 *
 *  It prints each different spinner line it saw (digits as they were), what the service made of each, and the
 *  `progress` the screens were told over the turn. It types only when Claude Code's own input box is on screen and
 *  nothing on it is a list to choose from; otherwise it stops and prints the screen. Not a test: it uses the real
 *  model. The folder and the session it leaves are deleted at the end. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import headless from "@xterm/headless";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { workingOnScreen } from "../src/terminals/host.js";
import { agentLauncher } from "../src/terminals/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLAUDE = process.env.CLAUDE_BIN ?? execSync("command -v claude").toString().trim();
// Under this repository (in a folder git ignores): a folder Claude Code already trusts, so it asks nothing and
// nothing is added to its list of trusted folders.
const base = join(here, "..", "node_modules", ".cache");
mkdirSync(base, { recursive: true });
const tmp = realpathSync(mkdtempSync(join(base, "as-working-")));
const home = join(tmp, "as"), cwd = join(tmp, "w");
mkdirSync(home); mkdirSync(cwd);
writeFileSync(join(cwd, "notes.md"), "# notes\n\n- buy milk\n- call the plumber\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (what: string, ...rest: unknown[]) => console.log(what, ...rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))));

let port = 0;
const cfg = { home, targetsPath: resolve(here, "..", "config", "targets.yaml"), port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" } as unknown as DaemonConfig;
// As the service's own environment is: not a terminal's (this may be run from inside an AgentSwitch terminal).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(CLAUDE|AGENTSWITCH_TERMINAL)/.test(k) && !/^(https?_proxy|all_proxy|no_proxy|ssl_cert_file|requests_ca_bundle|node_extra_ca_certs|secret_gate_home)$/i.test(k))) as NodeJS.ProcessEnv;

// Every hook call passes through here on its way to the service: which, when, and what it says of a compaction.
const t0 = Date.now();
const hooks: { at: number; event: string; tool?: string; keys: string[]; toolUseId?: string; agent?: string }[] = [];
const relay = createHttpServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  try {
    const call = JSON.parse(body); const p = call.payload ?? {};
    hooks.push({ at: Date.now(), event: call.event, keys: Object.keys(p).sort(), ...(p.tool_name ? { tool: p.tool_name } : {}), ...(p.tool_use_id ? { toolUseId: String(p.tool_use_id).slice(-6) } : {}), ...(p.agent_id ? { agent: p.agent_id } : {}) });
  } catch { /* not ours to judge */ }
  const out = await fetch(`http://127.0.0.1:${port}${req.url}`, { method: "POST", headers: { "content-type": "application/json", authorization: String(req.headers.authorization ?? ""), "x-agentswitch-terminal": String(req.headers["x-agentswitch-terminal"] ?? "") }, body });
  res.writeHead(out.status, { "content-type": "application/json" }).end(await out.text());
});
await new Promise<void>((ok) => relay.listen(0, "127.0.0.1", ok));
const relayPort = (relay.address() as AddressInfo).port;

const launch = agentLauncher({ binaries: { "claude-code": CLAUDE } as never, gate: null, hookUrl: () => `http://127.0.0.1:${relayPort}`, stateDir: join(home, "terminals"), env });
const daemon = buildDaemon(cfg, { terminalLauncher: launch });
const token = ensureLocalToken(home);
const server = await new Promise<{ close(): void }>((done) => { const s = listenLocal(daemon, 0, (info: AddressInfo) => { port = info.port; done(s); }, new LocalAuth(token)); });
daemon.setLocalPort(port);
const api = `http://127.0.0.1:${port}`;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(api + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};

/** The terminal's screen and events, each with when it came. */
function follow(id: string, query = "") {
  const term = new headless.Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 2000 });
  const events: { at: number; event: string; data: any }[] = [];
  const ctl = new AbortController();
  void (async () => {
    const res = await fetch(`${api}/terminals/${id}/stream${query}`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal }).catch(() => null);
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
        events.push({ at: Date.now(), event, data: json });
        if ((event === "snapshot" || event === "output") && typeof json?.data === "string") term.write(json.data);
      }
    }
  })().catch(() => undefined);
  const lines = () => { const b = term.buffer.active, out: string[] = []; for (let y = b.baseY; y < b.baseY + term.rows; y++) out.push(b.getLine(y)?.translateToString(true) ?? ""); return out; };
  return { events, lines, text: () => lines().join("\n"), stop: () => ctl.abort() };
}
const info = async (id: string) => (await call("GET", `/terminals/${id}`)).json.terminal as Record<string, any>;
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms: number) => { for (let t = 0; t < ms; t += 250) { if (await ok()) return true; await sleep(250); } say(`   (waited ${ms / 1000}s for ${what})`); return false; };
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Claude Code's own input box is on screen and nothing on it is a list to choose from (a question of its own —
 *  whether to trust a folder, which login — is the user's to answer, never typed into). */
const SPINNER = /^[·✢✳✶✻✽*]\s+\S/;
const RULE = /^\s*[─━]{20,}\s*$/;
/** Its input box: a row that begins with its prompt mark, between two of the box's rules. */
const inputBox = (lines: string[]): boolean => lines.some((l, i) => /^\s*❯(\s|$)/.test(l) && !/^\s*❯\s*\d+\./.test(l) && RULE.test(lines[i - 1] ?? "") && lines.slice(i + 1, i + 8).some((b) => RULE.test(b)));
const choosing = (lines: string[]): boolean => lines.some((l) => /^\s*[❯›]?\s*\d+\.\s+\S/.test(l));
const show = (lines: string[]) => { for (const l of lines.filter((l) => l.trim()).slice(-16)) console.log("     │" + l.trimEnd().slice(0, 150)); };

let id = "";
try {
  const started = await call("POST", "/terminals", { harness: "claude-code", cwd, model: process.env.PROBE_MODEL ?? "haiku", mode: "manual" });
  if (started.status >= 300) throw new Error(`could not start: ${started.status} ${JSON.stringify(started.json)}`);
  id = started.json.terminal.id as string;
  const scr = follow(id);
  await until("its input box", () => inputBox(scr.lines()) || choosing(scr.lines()), 30000);
  await sleep(1500);
  if (!inputBox(scr.lines()) || choosing(scr.lines())) { say("its input box is not on screen, or it asks something of its own (nothing is typed):"); show(scr.lines()); throw new Error("stopped before typing"); }

  // A second screen, showing the record (not the terminal): it is told what the agent is doing, and how far the turn is.
  const rec = follow(id, "?view=record");
  await sleep(300);
  const seen = scr.events.length, recSeen = rec.events.length, zero = Date.now();
  const rows = new Map<string, { at: number; read: string }>();
  const sent = await call("POST", `/terminals/${id}/input`, { text: process.env.PROBE_PROMPT ?? "Write about 450 words on how tides work, in plain paragraphs. Do not use any tools." });
  if (sent.status >= 300) throw new Error(`could not send: ${sent.status} ${JSON.stringify(sent.json)}`);
  let working = false;
  const asked: string[] = [];
  const mids = (process.env.PROBE_MID ?? "").split(",").map(Number).filter((n) => n > 0), shown = new Set<number>();
  for (let t = 0; t < 120000; t += 150) {
    const lines = scr.lines();
    for (const l of lines) if (SPINNER.test(l) && !rows.has(l.trimEnd())) rows.set(l.trimEnd(), { at: Date.now() - zero, read: JSON.stringify(workingOnScreen(lines)) });
    const status = scr.events.slice(seen).filter((e) => e.event === "status").pop()?.data?.status;
    // `PROBE_MID=6000,7500`: its screen's last lines at those moments of the turn (what it shows while the answer streams).
    for (const at of mids) if (!shown.has(at) && Date.now() - zero >= at) { shown.add(at); say(`its screen ${secs(Date.now() - zero)} into the turn:`); for (const l of lines.filter((l) => l.trim()).slice(-9)) console.log("     │" + l.trimEnd().slice(0, 118)); }
    if (t % 600 === 0) { const p = JSON.stringify((await info(id)).progress ?? null); if (asked[asked.length - 1]?.split(" ")[1] !== p) asked.push(`${secs(Date.now() - zero)} ${p}`); }
    if (status === "working") working = true;
    if (working && status === "idle") break;
    await sleep(150);
  }
  await sleep(600);
  say(`the lines with its spinner (${rows.size} different), each with what the service read from the screen then:`);
  for (const [row, { at, read }] of rows) console.log(`  ${secs(at).padStart(6)}  ${row.slice(0, 110).padEnd(64)}  → ${read}`);
  const told = rec.events.slice(recSeen).filter((e) => e.event === "progress").map((e) => `${secs(e.at - zero)} ${JSON.stringify(e.data?.progress)}`).filter((l, i, a) => l.split(" ")[1] !== a[i - 1]?.split(" ")[1]);
  say(`what the terminal's own entry said when asked (${asked.length} changes): ${asked.slice(0, 4).join(" | ")}${asked.length > 4 ? " | … | " + asked[asked.length - 1] : ""}`);
  say(`what a screen showing the record was told of the turn's tokens (${told.length} changes):`);
  for (const line of told.filter((_, i) => i < 5 || i >= told.length - 3)) console.log("   " + line);
  say("after the turn:", JSON.stringify((await info(id)).progress ?? null), "· its screen's last lines:");
  show(scr.lines().slice(-8));

  if (process.env.PROBE_PERMISSION) {
    // A command it has to ask about: which fields its hooks carry (what ties the request to the tool call), then allowed from here.
    const from = hooks.length, at = scr.events.length;
    if (!inputBox(scr.lines()) || choosing(scr.lines())) { say("its input box is not on screen (nothing is typed):"); show(scr.lines()); throw new Error("stopped before typing"); }
    await call("POST", `/terminals/${id}/input`, { text: "Use your Bash tool to run exactly this command: touch probe.txt   Then reply with the single word done." });
    const asked = await until("its permission request", () => scr.events.slice(at).some((e) => e.event === "permission"), 60000);
    if (asked) {
      const request = scr.events.slice(at).find((e) => e.event === "permission")!.data.request;
      say("it asks:", request.tool, JSON.stringify(request.summary));
      await call("POST", `/terminals/${id}/permissions/${request.id}`, { decision: "allow" });
    }
    await until("the turn to end", async () => (await info(id)).status === "idle", 60000);
    say("its hooks over that turn (event · tool · the call's id · the payload's fields):");
    for (const h of hooks.slice(from)) console.log(`   ${h.event.padEnd(18)} ${(h.tool ?? "").padEnd(6)} ${(h.toolUseId ?? "-").padEnd(7)} ${h.agent ? "[sub-agent] " : ""}${h.keys.join(",")}`);
  }
} catch (err) {
  say("stopped:", (err as Error).message);
} finally {
  if (id) await call("DELETE", `/terminals/${id}`).catch(() => undefined);
  await sleep(500);
  server.close();
  daemon.close();
  relay.close();
  rmSync(tmp, { recursive: true, force: true });
  // The session file it left, in Claude Code's folder for that (throw-away) working folder.
  const kept = join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (existsSync(kept) && kept.includes("as-working-")) rmSync(kept, { recursive: true, force: true });
  say("cleaned:", !existsSync(tmp) && !existsSync(kept), `· ran ${secs(Date.now() - t0)}`);
  process.exit(0);
}
