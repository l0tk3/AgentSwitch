/** A Codex terminal through its own app-server (codexTerminal.ts) beside one started on its own, for real: the
 *  service's own code, YOUR Codex — its login, its config, a real model. Each run makes a few small turns on your
 *  account, and asks Codex to delete the sessions it made.
 *
 *    npx tsx scripts/codex_terminal_real_probe.ts                       # both ways, the same two messages
 *    PROBE_RESUME=direct,remote PROBE_CWD=<a folder Codex trusts> …     # a session resumed, both ways
 *    PROBE_WAYS=auto,bypass PROBE_CWD=<…> …                             # the other ways of asking, resumed, forked
 *
 *  What it shows, a line each: the terminal starts (attached to its server, behind a token); the hooks run — status,
 *  an approval card answered from the service's API, the command then running with the terminal's environment; the
 *  model and effort set from the API before a turn and between turns, the TUI following and the next turn running on
 *  them; what each turn ran with (how it asked, its sandbox), read from the session's own file; the sessions its
 *  hooks named and the threads its server holds; and that your Codex's config, your login file and the desktop app's
 *  processes are as they were. It uses the hook command of the installed AgentSwitch (the one your Codex already
 *  trusts) and never types into a question Codex asks on its own screen (whether to trust a folder is yours to say):
 *  it stops there. Not a test: it uses the real model. */
import { createHash } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import headless from "@xterm/headless";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { defaultGate } from "../src/executors/gate.js";
import { terminalProtected } from "../src/executors/protected.js";
import { AppServerClient } from "../src/harness/appserver.js";
import { connectWsLines } from "../src/harness/wsLines.js";
import { readRecord } from "../src/sessions/record.js";
import { agentLauncher } from "../src/terminals/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const APP = process.env.AGENTSWITCH_APP ?? resolve(here, "..", "..", "mac-app", "build", "AgentSwitch.app");
const NODE = join(APP, "Contents/Resources/runtime/node/bin/node"), HOOK = join(APP, "Contents/Resources/runtime/daemon/dist/terminals/hookClient.js");
const CODEX = process.env.CODEX_BIN ?? join(homedir(), ".local/share/agentswitch/cli/codex/beta/0.162.0-alpha.18/bin/codex");
for (const f of [NODE, HOOK, CODEX]) if (!existsSync(f)) { console.log(`missing: ${f}`); process.exit(1); }
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const sha = (f: string) => (existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 12) : "-");
const appProcs = () => execSync("ps -axo command | grep -c 'ChatGPT.app/Contents/.*[c]odex' || true").toString().trim();
const before = { config: sha(join(CODEX_HOME, "config.toml")), auth: statSync(join(CODEX_HOME, "auth.json")).mtimeMs, app: appProcs() };

const base = join(here, "..", "node_modules", ".cache");
mkdirSync(base, { recursive: true });
const tmp = realpathSync(mkdtempSync(join(base, "as-codex-real-")));
// Where the terminals work: a throw-away folder, or one named (PROBE_CWD: one your Codex trusts by its own name).
const home = join(tmp, "as"), cwd = process.env.PROBE_CWD ?? join(tmp, "w");
mkdirSync(home); mkdirSync(cwd, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (v: unknown, n = 260) => (typeof v === "string" ? v : JSON.stringify(v))?.slice(0, n);
const say = (what: string, ...rest: unknown[]) => console.log(`${what}`, ...rest.map((r) => short(r)));

let port = 0;
const cfg = { home, targetsPath: resolve(here, "..", "config", "targets.yaml"), port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" } as unknown as DaemonConfig;
// As the service's own environment is: not a terminal's. Run from inside an AgentSwitch terminal, this process has the
// gate's proxy and its CA as the only trusted one — with those Codex cannot reach its own service ("invalid peer
// certificate: UnknownIssuer"; the service gives them to the commands Codex runs, never to Codex).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(CLAUDE|AGENTSWITCH_TERMINAL)/.test(k) && !/^(https?_proxy|all_proxy|no_proxy|ssl_cert_file|requests_ca_bundle|node_extra_ca_certs|secret_gate_home)$/i.test(k))) as NodeJS.ProcessEnv;
// Every hook call passes through here on its way to the service: which session each says it is of.
const hookCalls: { event: string; session: string; transcript: string; source?: string }[] = [];
const relay = createHttpServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  try { const call = JSON.parse(body); const p = call.payload ?? {}; hookCalls.push({ event: call.event ?? p.hook_event_name, session: String(p.session_id ?? p["thread-id"] ?? ""), transcript: String(p.transcript_path ?? "").slice(-42), ...(p.source ? { source: String(p.source) } : {}) }); } catch { /* not ours to judge */ }
  const out = await fetch(`http://127.0.0.1:${port}${req.url}`, { method: "POST", headers: { "content-type": "application/json", authorization: String(req.headers.authorization ?? ""), "x-agentswitch-terminal": String(req.headers["x-agentswitch-terminal"] ?? "") }, body });
  res.writeHead(out.status, { "content-type": "application/json" }).end(await out.text());
});
await new Promise<void>((ok) => relay.listen(0, "127.0.0.1", ok));
const relayPort = (relay.address() as AddressInfo).port;

// One service, two ways of starting a Codex terminal: on its own (as today), and through its own app-server.
let remote = false;
const launcher = (codexServer: boolean) => agentLauncher({
  binaries: { codex: CODEX } as never, gate: defaultGate(env), hookUrl: () => `http://127.0.0.1:${relayPort}`, stateDir: join(home, "terminals"),
  node: NODE, hookScript: HOOK, env, protected: terminalProtected({ ...env, AGENTSWITCH_HOME: home }), codexHooks: () => true, codexServer });
const direct = launcher(false), through = launcher(true);
const daemon = buildDaemon(cfg, { terminalLauncher: (req) => (remote ? through : direct)(req) });
const token = ensureLocalToken(home);
const server = await new Promise<{ close(): void }>((done) => { const s = listenLocal(daemon, 0, (info: AddressInfo) => { port = info.port; done(s); }, new LocalAuth(token)); });
daemon.setLocalPort(port);
const api = `http://127.0.0.1:${port}`;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(api + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};

/** A terminal's screen and events, followed from its stream. */
function follow(id: string) {
  const term = new headless.Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 2000 });
  const events: { event: string; data: any }[] = [];
  const raw = { text: "" };
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
        events.push({ event, data: json });
        if ((event === "snapshot" || event === "output") && typeof json?.data === "string") { term.write(json.data); raw.text = (raw.text + json.data).slice(-6000); }
      }
    }
  })().catch(() => undefined);
  const lines = () => { const b = term.buffer.active, out: string[] = []; for (let y = b.baseY; y < b.baseY + term.rows; y++) out.push(b.getLine(y)?.translateToString(true) ?? ""); return out; };
  return { events, lines, said: () => raw.text.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, " ").replace(/\s+/g, " ").trim(), text: () => lines().join("\n"), foot: () => lines().filter((l) => l.trim() && !/[⣀-⣿]/.test(l)).slice(-3).map((l) => l.trim().slice(0, 84)), stop: () => ctl.abort(),
    statuses: () => events.filter((e) => e.event === "status").map((e) => e.data?.status as string).filter((s, i, a) => s !== a[i - 1]) };
}
const info = async (id: string) => (await call("GET", `/terminals/${id}`)).json.terminal as Record<string, any>;
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms: number) => { for (let t = 0; t < ms; t += 500) { if (await ok()) return true; await sleep(500); } say(`   (waited ${ms / 1000}s for ${what})`); return false; };

const made: string[] = [];
/** Questions Codex asks on its own screen before it works: whether to trust a folder, whether to run hooks. */
const OWN_QUESTION = /Trust this folder|Folder access|Hooks need review|Back to Agent Command Center/;
const servers = () => execSync("ps -axo command | grep '[a]pp-server --listen ws://127.0.0.1' || true").toString().trim().split("\n").filter(Boolean);
const ASK_CARD = "Create an empty file named as-probe.txt in the current folder by running the shell command `touch as-probe.txt`. The sandbox is read-only, so request escalated permissions for that command and wait for my approval. Then reply with the single word done.";
const ASK_ENV = "Run the shell command `printenv AGENTSWITCH_TERMINAL_ID` and reply with exactly what it printed, nothing else.";

/** One terminal, two turns: an approval card answered from the API, then what a command sees of its environment. */
async function terminal(label: string, resume?: string, extra: Record<string, unknown> = {}) {
  const started = resume ? await call("POST", "/terminals/resume", { harness: "codex", cwd, agentSessionId: resume, ...extra })
    : await call("POST", "/terminals", { harness: "codex", cwd, mode: "manual", effort: "low", ...extra });
  if (started.status >= 300) throw new Error(`could not start: ${started.status} ${short(started.json)}`);
  const id = started.json.terminal.id as string;
  const scr = follow(id);
  await until("its prompt", () => /Ask Codex|for shortcuts/.test(scr.text()) || OWN_QUESTION.test(scr.text()), 40000);
  await sleep(1500);
  if (OWN_QUESTION.test(scr.text())) {
    say(`${label} it asks a question of its own (nothing is typed into it):`); for (const l of scr.lines().filter((l) => l.trim() && !/[⣀-⣿]/.test(l)).slice(-12)) console.log("     │" + l.trimEnd().slice(0, 150));
    scr.stop(); await call("DELETE", `/terminals/${id}`);
    throw new Error("stopped at its question");
  }
  if ((await info(id)).status === "exited") {
    say(`${label} it ended as it started; its screen:`); for (const l of scr.lines().filter((l) => l.trim() && !/[⣀-⣿]/.test(l)).slice(-10)) console.log("     │" + l.trimEnd().slice(0, 220));
    scr.stop(); await call("DELETE", `/terminals/${id}`);
    throw new Error("it ended as it started");
  }
  await until("its footer", async () => /GPT-|gpt-/.test(scr.foot().join(" ")) || (await info(id)).status === "exited", 15000);
  if ((await info(id)).status === "exited") {
    say(`${label} it ended as it started; the last it wrote:`, scr.said().slice(-700));
    scr.stop(); await call("DELETE", `/terminals/${id}`);
    throw new Error("it ended as it started");
  }
  say(`${label} started:`, { hooks: (await info(id)).hooks, status: (await info(id)).status, itsServer: servers().length, tuiRemote: /--remote ws:/.test(execSync("ps -axo command | grep '[-]-remote ws://' || true").toString()) }, "| TUI:", scr.foot()[1]);
  const turn = async (text: string, what: string) => {
    if (OWN_QUESTION.test(scr.text())) throw new Error(`it is at a question of its own, nothing was typed: ${scr.lines().filter((l) => l.trim()).slice(-6).join(" / ").slice(0, 400)}`);
    const seen = scr.statuses().length;
    await call("POST", `/terminals/${id}/input`, { text, seal: false });
    // Every card of the turn is allowed as it comes (it may ask more than once), until the turn has ended.
    const cards: { tool: string; summary: string; answered: number }[] = [];
    const handled = new Set<string>();
    await until(`${what}: its end`, async () => {
      const t = await info(id);
      for (const c of (t.permissions ?? []) as any[]) if (!handled.has(c.id)) { handled.add(c.id); cards.push({ tool: c.tool, summary: String(c.summary).slice(0, 50), answered: (await call("POST", `/terminals/${id}/permissions/${c.id}`, { decision: "allow" })).status }); }
      return t.status === "idle" && !(t.permissions ?? []).length && scr.statuses().slice(seen).includes("working");
    }, 180000);
    await sleep(1200);
    return { card: cards[0] ?? null, cards: cards.length, statuses: scr.statuses().slice(seen) };
  };
  return { id, scr, turn };
}
const record = async (session: string | null) => {
  if (!session) return { status: "no session id" };
  // Read as the service reads it, from the file Codex keeps for that session (this throw-away service lists none).
  const path = execSync(`find ${JSON.stringify(join(CODEX_HOME, "sessions"))} -name "*${session}.jsonl" | head -1`).toString().trim();
  if (!path) return { status: "no file for that session" };
  const read = readRecord("codex", path, {});
  const r = { status: "read", json: { items: read?.items ?? [], usage: read?.usage } };
  const items = (r.json.items ?? []) as any[];
  return { status: r.status, items: items.map((i) => (i.type === "work" ? `work[${(i.steps ?? []).map((s: any) => s.kind + (s.failed ? "!" : "")).join(",")}]` : i.type)).join(" "), model: r.json.usage?.model, effort: r.json.usage?.effort, lastAnswer: String(items.filter((i) => i.type === "answer" && !i.thinking).at(-1)?.text ?? "").slice(0, 40) };
};

const ranWith = (session: string | null) => {
  const file = session ? execSync(`find ${JSON.stringify(join(CODEX_HOME, "sessions"))} -name "*${session}.jsonl" | head -1`).toString().trim() : "";
  return file ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"turn_context"')).map((l) => { const p = JSON.parse(l).payload; return `${p.model}/${p.effort} asks ${p.approval_policy} sandbox ${p.sandbox_policy?.type}`; }) : ["(no file)"];
};
try {
  // The other ways of asking, through its own server: a new session each, one trivial turn, then how it ran.
  for (const way of (process.env.PROBE_WAYS ?? "").split(",").filter(Boolean)) {
    remote = true;
    const t = await terminal(`[${way}]`, undefined, { mode: way });
    await t.turn("Reply with the single word ok.", "a turn");
    const session = (await info(t.id)).agentSessionId as string | null;
    if (session) made.push(session);
    say(`[${way}] a new session ran with:`, ranWith(session));
    t.scr.stop(); await call("DELETE", `/terminals/${t.id}`); await sleep(2500);
    if (!session) continue;
    // The same session resumed that way (how it asks goes to the server then), and a fork of it.
    const again = await terminal(`[${way}] resumed`, session, { mode: way });
    await again.turn("Reply with the single word again.", "a turn after resuming");
    say(`[${way}] resumed, it ran with:`, ranWith(session).slice(-1));
    again.scr.stop(); await call("DELETE", `/terminals/${again.id}`); await sleep(2500);
    if (way === (process.env.PROBE_FORK ?? "auto")) {
      const fork = await terminal(`[${way}] forked`, session, { mode: way, fork: true });
      await fork.turn("Reply with the single word forked.", "a turn in the fork");
      const forked = (await info(fork.id)).agentSessionId as string | null;
      if (forked && forked !== session) made.push(forked);
      say(`[${way}] forked:`, { aNewSession: !!forked && forked !== session, showsHistory: /\bagain\b/.test(fork.scr.text()) }, ranWith(forked).slice(-1), await record(forked));
      fork.scr.stop(); await call("DELETE", `/terminals/${fork.id}`); await sleep(2500);
    }
  }
  for (const mode of (process.env.PROBE_RESUME ?? "").split(",").filter(Boolean)) {
    remote = mode === "remote";
    const t = await terminal(`[resume, ${mode}]`);
    await t.turn("Reply with the single word ok.", "a first turn");
    const session = (await info(t.id)).agentSessionId as string | null;
    if (session) made.push(session);
    t.scr.stop();
    await call("DELETE", `/terminals/${t.id}`);
    await sleep(2500);
    if (!session) throw new Error("no session to resume");
    const again = await terminal(`[resume, ${mode}] resumed`, session);
    await sleep(2500);
    const r = await info(again.id);
    say(`[resume, ${mode}]`, { sameSession: r.agentSessionId === session, resumedFrom: r.resumedFrom === session, showsHistory: /\bok\b/.test(again.scr.text()), status: r.status });
    if (remote) { const m = await call("POST", `/terminals/${again.id}/model`, { model: process.env.PROBE_MODEL ?? "gpt-6-luna" }); await sleep(1500); say(`[resume, ${mode}] model →`, m.status, m.json, "| TUI:", again.scr.foot()[1]); }
    const next = await again.turn("Reply with the single word again.", "a turn after resuming");
    say(`[resume, ${mode}] a turn there:`, { statuses: next.statuses, follows: (await info(again.id)).agentSessionId === session }, await record(session));
    const file = execSync(`find ${JSON.stringify(join(CODEX_HOME, "sessions"))} -name "*${session}.jsonl" | head -1`).toString().trim();
    const turns = file ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"turn_context"')).map((l) => { const p = JSON.parse(l).payload; return `${p.model}/${p.effort} asks ${p.approval_policy} sandbox ${p.sandbox_policy?.type}`; }) : [];
    say(`[resume, ${mode}] each turn ran with:`, turns);
    again.scr.stop();
    await call("DELETE", `/terminals/${again.id}`);
    await sleep(2000);
  }
  for (const mode of (process.env.PROBE_RESUME || process.env.PROBE_WAYS ? "" : process.env.PROBE_MODES ?? "direct,remote").split(",").filter(Boolean)) {
    remote = mode === "remote";
    rmSync(join(cwd, "as-probe.txt"), { force: true });
    const t = await terminal(`[${mode}]`);
    if (remote) {
      // The model and the effort, before any turn.
      const pick = process.env.PROBE_MODEL ?? "gpt-6-luna";
      const m = await call("POST", `/terminals/${t.id}/model`, { model: pick });
      const e = await call("POST", `/terminals/${t.id}/effort`, { effort: "low" });
      await sleep(1500);
      const bad = await call("POST", `/terminals/${t.id}/effort`, { effort: "nosuch" });
      say(`[${mode}] before a turn: model → ${pick}`, m.status, m.json, "effort → low", e.status, "| modelNow", (await info(t.id)).modelNow, "| TUI:", t.scr.foot()[1], "| an effort it has not:", bad.status, bad.json);
    }
    const one = await t.turn(ASK_CARD, "the approval turn");
    const session = (await info(t.id)).agentSessionId as string | null;
    if (session) made.push(session);
    say(`[${mode}] turn 1 (asks to write outside its sandbox):`, { card: one.card, cards: one.cards, statuses: one.statuses, fileWritten: existsSync(join(cwd, "as-probe.txt")) });
    say(`[${mode}] the sessions its hooks named:`, [...new Map(hookCalls.map((h) => [`${h.session}|${h.transcript}`, h])).values()].map((h) => ({ session: h.session.slice(0, 18), file: h.transcript.slice(-24, -6), first: h.event, source: h.source })), "| the terminal follows:", String(session).slice(0, 18));
    if (remote) {
      // The threads its server holds, as a client of it sees them.
      const url = /--listen (ws:\/\/127\.0\.0\.1:\d+)/.exec(servers()[0] ?? "")?.[1], tokenFile = join(home, "terminals", t.id, "codex-server-token");
      if (url && existsSync(tokenFile)) {
        const ws = await connectWsLines(url, { token: readFileSync(tokenFile, "utf8") });
        const rpc = new AppServerClient(ws.input, ws.output, async () => ({}), () => undefined);
        await rpc.request("initialize", { clientInfo: { name: "agentswitch-probe", version: "0" }, capabilities: { experimentalApi: true } }, 8000);
        rpc.notify("initialized");
        const ids = ((await rpc.request("thread/loaded/list", {}, 8000)).data as string[]) ?? [];
        const seen = [];
        for (const tid of ids) { const th = ((await rpc.request("thread/read", { threadId: tid, includeTurns: false }, 8000)).thread ?? {}) as any; seen.push({ id: String(th.id).slice(0, 18), parent: th.parentThreadId ? String(th.parentThreadId).slice(0, 18) : null, source: typeof th.source === "string" ? th.source : Object.keys(th.source ?? {})[0], ephemeral: th.ephemeral, file: th.path ? String(th.path).slice(-24, -6) : null, preview: String(th.preview ?? "").slice(0, 30) }); }
        say(`[${mode}] threads on its server:`, seen);
        ws.close();
      }
    }
    hookCalls.length = 0;
    const two = await t.turn(ASK_ENV, "the environment turn");
    const rec = await record(session);
    say(`[${mode}] turn 2 (what a command sees):`, { statuses: two.statuses, answerIsThisTerminal: rec.lastAnswer?.includes(t.id), answer: rec.lastAnswer });
    say(`[${mode}] its record:`, rec);
    if (remote) {
      // Changed between turns: the next turn runs on it.
      const pick2 = process.env.PROBE_MODEL2 ?? "gpt-6-sol";
      const m2 = await call("POST", `/terminals/${t.id}/model`, { model: pick2 });
      const e2 = await call("POST", `/terminals/${t.id}/effort`, { effort: "medium" });
      await sleep(1500);
      say(`[${mode}] between turns: model → ${pick2}`, m2.status, "effort → medium", e2.status, "| TUI:", t.scr.foot()[1]);
      await t.turn("Reply with the single word ok.", "the third turn");
      const rec3 = await record(session);
      say(`[${mode}] turn 3 ran on:`, { model: rec3.model, effort: rec3.effort, answer: rec3.lastAnswer });
    }
    if (!one.card || process.env.PROBE_SCREEN) { say(`[${mode}] its screen:`); for (const l of t.scr.lines().filter((l) => l.trim() && !/[⣀-⣿]/.test(l)).slice(-16)) console.log("     │" + l.trimEnd().slice(0, 150)); }
    t.scr.stop();
    await call("DELETE", `/terminals/${t.id}`);
    await sleep(2500);
    say(`[${mode}] closed: servers left`, servers().length);
    if (remote && session) {
      // The same session again, through a server of its own once more.
      const again = await terminal("[remote, resumed]", session);
      await sleep(2000);
      const m3 = await call("POST", `/terminals/${again.id}/model`, { model: process.env.PROBE_MODEL ?? "gpt-6-luna" });
      await sleep(1500);
      const r = await info(again.id);
      say("[remote, resumed]", { sameSession: r.agentSessionId === session || r.resumedFrom === session, showsHistory: /ok|done/i.test(again.scr.text()) }, "| model →", m3.status, m3.json, "| TUI:", again.scr.foot()[1]);
      const four = await again.turn("Reply with the single word again.", "a turn after resuming");
      const rec4 = await record(session);
      say("[remote, resumed] a turn there:", { statuses: four.statuses, model: rec4.model, answer: rec4.lastAnswer, items: rec4.items });
      again.scr.stop();
      await call("DELETE", `/terminals/${again.id}`);
      await sleep(2000);
    }
  }
} catch (e) {
  say("FAILED:", String(e));
} finally {
  for (const t of ((await call("GET", "/terminals").catch(() => ({ json: {} as any }))).json.terminals ?? []) as { id: string }[]) await call("DELETE", `/terminals/${t.id}`).catch(() => undefined);
  await sleep(1500);
  server.close(); daemon.close(); relay.close();
  // The sessions it made on your Codex: asked of Codex itself.
  for (const session of [...new Set([...made, ...(process.env.PROBE_ALSO_DELETE ?? "").split(",").filter(Boolean)])]) {
    const del = spawnSync(CODEX, ["delete", "--force", session], { encoding: "utf8", timeout: 20000, env: env as Record<string, string> });
    say("its session deleted from your Codex:", session.slice(0, 13) + "…", del.status === 0 ? "yes" : `no (${short((del.stderr || del.stdout || "").trim().split("\n").at(-1), 140)})`);
  }
  const after = { config: sha(join(CODEX_HOME, "config.toml")), auth: statSync(join(CODEX_HOME, "auth.json")).mtimeMs, app: appProcs() };
  say("your Codex afterwards:", { configUnchanged: after.config === before.config, authFileTouched: after.auth !== before.auth, desktopAppProcesses: `${before.app} → ${after.app}` });
  try { execSync(`pkill -9 -f ${JSON.stringify(tmp)} || true`); } catch { /* none */ }
  rmSync(tmp, { recursive: true, force: true });
  say("cleaned:", !existsSync(tmp), "| servers left:", execSync("ps -axo command | grep -c '[a]pp-server --listen ws://127.0.0.1' || true").toString().trim());
  process.exit(0);
}
