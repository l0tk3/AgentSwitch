/** What a real Claude Code shows and says while it compacts its context, and what the service makes of it
 *  (docs/simple-view-v0.md §5.7). The service's own code, YOUR Claude Code: its login, a real model (Haiku) — three
 *  tiny turns, one compaction, and one compaction cancelled with esc.
 *
 *    npx tsx scripts/claude_compact_probe.ts
 *    PROBE_SCREEN=1 …         # also the last lines of its screen after the compaction
 *    PROBE_ONLY=compact …     # the first compaction alone
 *    PROBE_HOOKS=compact …    # with PreCompact and PostCompact hooks added, to see what Claude Code prints for them
 *
 *  What it shows, a line each: the line on its screen while it compacts (what the service reads); the hook calls
 *  over that time (the SessionStart after a compaction is the only one of the main agent's); the terminal's status
 *  and what it is doing, as the screens are told; what the record says afterwards; and, for one cancelled with esc,
 *  which hooks came (none of the main agent's) and how long the terminal took to be at rest again.
 *
 *  Seen 2026-10-07 on 2.1.292: `✻ Compacting conversation… (1s)`; SessionStart(compact) as it ends; with the two
 *  compact hooks added, six rows after every compaction naming the hook's command (`PreCompact ["…/node" "…/hookClient"]
 *  completed successfully`, the same for PostCompact) — which is why the service adds none.
 *
 *  It never types into a question Claude Code asks on its own screen (whether to trust a folder is yours to say): it
 *  stops there. Not a test: it uses the real model. The folder and the session it leaves are deleted at the end. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import headless from "@xterm/headless";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { readRecord } from "../src/sessions/record.js";
import { compactingOnScreen } from "../src/terminals/host.js";
import { agentLauncher, claudeHookSettings } from "../src/terminals/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLAUDE = process.env.CLAUDE_BIN ?? execSync("command -v claude").toString().trim();
// Under this repository (in a folder git ignores): a folder Claude Code already trusts, so it asks nothing and
// nothing is added to its list of trusted folders.
const base = join(here, "..", "node_modules", ".cache");
mkdirSync(base, { recursive: true });
const tmp = realpathSync(mkdtempSync(join(base, "as-compact-")));
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
const hooks: { at: number; event: string; trigger?: string; source?: string; agent?: string; summary?: boolean; transcript?: string }[] = [];
const relay = createHttpServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  try {
    const call = JSON.parse(body); const p = call.payload ?? {};
    hooks.push({ at: Date.now(), event: call.event, ...(p.trigger ? { trigger: p.trigger } : {}), ...(p.source ? { source: p.source } : {}), ...(p.agent_id ? { agent: p.agent_id } : {}),
      ...(call.event === "PostCompact" ? { summary: "compact_summary" in p } : {}), ...(p.transcript_path ? { transcript: p.transcript_path } : {}) });
  } catch { /* not ours to judge */ }
  const out = await fetch(`http://127.0.0.1:${port}${req.url}`, { method: "POST", headers: { "content-type": "application/json", authorization: String(req.headers.authorization ?? ""), "x-agentswitch-terminal": String(req.headers["x-agentswitch-terminal"] ?? "") }, body });
  res.writeHead(out.status, { "content-type": "application/json" }).end(await out.text());
});
await new Promise<void>((ok) => relay.listen(0, "127.0.0.1", ok));
const relayPort = (relay.address() as AddressInfo).port;

const launch = agentLauncher({ binaries: { "claude-code": CLAUDE } as never, hookUrl: () => `http://127.0.0.1:${relayPort}`, stateDir: join(home, "terminals"), env });
const daemon = buildDaemon(cfg, { terminalLauncher: (req) => {
  const plan = launch(req);
  if (process.env.PROBE_HOOKS !== "compact") return plan;
  // The same settings file with the two compact hooks added, by the command the others have.
  const file = plan.args[plan.args.indexOf("--settings") + 1]!;
  const settings = JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof claudeHookSettings> & { hooks: Record<string, unknown> };
  settings.hooks.PreCompact = settings.hooks.Stop; settings.hooks.PostCompact = settings.hooks.Stop;
  writeFileSync(file, JSON.stringify(settings));
  return plan;
} });
const token = ensureLocalToken(home);
const server = await new Promise<{ close(): void }>((done) => { const s = listenLocal(daemon, 0, (info: AddressInfo) => { port = info.port; done(s); }, new LocalAuth(token)); });
daemon.setLocalPort(port);
const api = `http://127.0.0.1:${port}`;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(api + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};

/** The terminal's screen and events, each with when it came. */
function follow(id: string) {
  const term = new headless.Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 2000 });
  const events: { at: number; event: string; data: any }[] = [];
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
/** Questions Claude Code asks on its own screen before it works. */
const OWN_QUESTION = /trust this folder|Do you trust|Yes, I trust|Bypass Permissions mode|Select login method/i;

/** `PROBE_ONLY=compact`: the first compaction alone. */
const ONLY = new Error("stopped after the first compaction, as asked");
let id = "";
try {
  const started = await call("POST", "/terminals", { harness: "claude-code", cwd, model: process.env.PROBE_MODEL ?? "haiku", mode: "manual" });
  if (started.status >= 300) throw new Error(`could not start: ${started.status} ${JSON.stringify(started.json)}`);
  id = started.json.terminal.id as string;
  const scr = follow(id);
  await until("its first screen", () => /❯|\? for shortcuts/.test(scr.text()) || OWN_QUESTION.test(scr.text()), 30000);
  await sleep(1500);
  if (OWN_QUESTION.test(scr.text())) {
    say("it asks a question of its own (nothing is typed into it):"); for (const l of scr.lines().filter((l) => l.trim()).slice(-12)) console.log("     │" + l.trimEnd().slice(0, 150));
    throw new Error("stopped at its question");
  }
  const turn = async (text: string) => {
    const seen = scr.events.length;
    const sent = await call("POST", `/terminals/${id}/input`, { text, seal: false });
    if (sent.status >= 300) throw new Error(`could not send: ${sent.status} ${JSON.stringify(sent.json)}`);
    await until("it to begin", () => scr.events.slice(seen).some((e) => e.event === "status" && e.data?.status === "working"), 20000);
    await until("the turn to end", async () => (await info(id)).status === "idle", 120000);
    await sleep(800);
  };
  await turn("Read notes.md and reply with how many items the list has, as one word.");
  await turn("Reply with the single word two.");
  say("two turns made · session", String((await info(id)).agentSessionId).slice(0, 8) + "…");

  /** The stream's status and activity events from `from` on, with when each came after `zero`. */
  const told = (from: number, zero: number) => scr.events.slice(from).filter((e) => e.event === "status" || e.event === "activity")
    .map((e) => `${secs(e.at - zero)} ${e.event === "status" ? e.data?.status : `doing ${e.data?.activity?.tool ?? "nothing"}`}`).filter((l, i, a) => l.split(" ").slice(1).join(" ") !== a[i - 1]?.split(" ").slice(1).join(" "));
  const calls = (from: number, zero: number) => hooks.slice(from).map((h) => `${secs(h.at - zero)} ${h.event}${h.trigger ? `(${h.trigger})` : ""}${h.source ? `(${h.source})` : ""}${h.agent ? " [sub-agent]" : ""}${h.summary !== undefined ? ` summary sent on: ${h.summary}` : ""}`);
  const compacting = async () => (await info(id)).activity?.tool === "Compact";
  const lineNow = () => scr.lines().find((l) => compactingOnScreen([l]))?.trim().slice(0, 110) ?? null;

  // ---- a compaction that runs to its end ----
  let seenEvents = scr.events.length, seenHooks = hooks.length, zero = Date.now();
  await call("POST", `/terminals/${id}/input`, { text: "/compact", seal: false });
  const began = await until("the service to say it compacts", compacting, 15000);
  const during = await info(id);
  say("[compact] its screen says:", lineNow(), "· the service says:", { status: during.status, doing: during.activity });
  const ended = await until("the SessionStart after it", () => hooks.slice(seenHooks).some((h) => h.event === "SessionStart" && h.source === "compact"), 240000);
  await sleep(2500);
  say("[compact] hook calls:", calls(seenHooks, zero));
  say("[compact] the screens were told:", told(seenEvents, zero));
  say("[compact]", { began, ended, statusAfter: (await info(id)).status, lineAfter: lineNow() });
  if (process.env.PROBE_SCREEN) { say("[compact] its screen afterwards:"); for (const l of scr.lines().filter((l) => l.trim()).slice(-14)) console.log("     │" + l.trimEnd().slice(0, 150)); }
  const file = hooks.findLast((h) => h.transcript)?.transcript;
  const rec = file ? readRecord("claude-code", file, {}) : null;
  say("[compact] its record ends with:", (rec?.items ?? []).slice(-3).map((i) => (i.type === "work" ? "work" : `${i.type}: ${String((i as { text?: string }).text ?? "").slice(0, 60)}`)), "· context", rec?.usage?.used ?? null);
  if (process.env.PROBE_ONLY === "compact") throw ONLY;

  // ---- one cancelled with esc: no hook says it ended ----
  await turn("Reply with the single word three.");
  seenEvents = scr.events.length; seenHooks = hooks.length; zero = Date.now();
  await call("POST", `/terminals/${id}/input`, { text: "/compact", seal: false });
  const again = await until("the service to say it compacts", compacting, 15000);
  await sleep(1500);
  const pressed = Date.now();
  await call("POST", `/terminals/${id}/keys`, { keys: ["esc"] });
  const rested = await until("it to be at rest", async () => (await info(id)).status === "idle", 30000);
  const restedAt = scr.events.slice(seenEvents).findLast((e) => e.event === "status" && e.data?.status === "idle")?.at ?? Date.now();
  await sleep(2500);
  say("[cancel] hook calls:", calls(seenHooks, zero));
  say("[cancel] the screens were told:", told(seenEvents, zero));
  say("[cancel]", { began: again, rested, atRestAfterEsc: secs(restedAt - pressed), statusAfter: (await info(id)).status, lineAfter: lineNow() });
  say("[cancel] its screen says:", scr.lines().filter((l) => /compact|interrupt|cancel/i.test(l)).map((l) => l.trim().slice(0, 110)).slice(-3));
  // It still works afterwards: a turn, and at rest again.
  await turn("Reply with the single word four.");
  say("[after] a turn made, status", (await info(id)).status);
  scr.stop();
} catch (e) {
  if (e !== ONLY) say("FAILED:", String(e));
} finally {
  if (id) await call("DELETE", `/terminals/${id}`).catch(() => undefined);
  await sleep(1500);
  server.close(); daemon.close(); relay.close();
  rmSync(tmp, { recursive: true, force: true });
  // The session file it left, in Claude Code's folder for that (throw-away) working folder.
  const kept = join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (existsSync(kept) && kept.includes("as-compact-")) rmSync(kept, { recursive: true, force: true });
  say("cleaned:", !existsSync(tmp) && !existsSync(kept), `· ran ${secs(Date.now() - t0)}`);
  process.exit(0);
}
