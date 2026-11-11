/** A real Grok in one of AgentSwitch's terminals, through the service's own code (docs/terminal-v0.md §3 Grok;
 *  2026-11-11, user: 能否增加对Grok的支持？目前还没有Grok): what the service makes of it from the moment it starts in a
 *  folder it does not trust, through one turn that asks before a tool, to its end.
 *
 *    npx tsx scripts/grok_terminal_probe.ts
 *
 *  YOUR Grok (`GROK_BIN`, else the one on the PATH), signed in as you are: the one turn asks its model for a few words
 *  and costs a little of your plan. What it leaves, and takes away again:
 *  - AgentSwitch's hook file in your Grok folder (`~/.grok/hooks/agentswitch.json`) is written, as a Grok terminal
 *    writes it; it was not there before → removed at the end (`PROBE_KEEP_HOOKS=1` leaves it).
 *  - The folder it runs in is a new one under the system's temporary directory. "Yes, proceed" is taken there through
 *    the service, as a screen would take it, so Grok notes it as trusted: that entry is taken out of
 *    `trusted_folders.toml` again at the end (the file is put back as it was when nothing else changed in it).
 *  - Its session of the turn (a folder under `~/.grok/sessions/`, named for the temporary folder) is removed at the end.
 *  - Grok keeps a level typed with `/effort` as what your later sessions start at (it writes its `config.toml`): the
 *    file is put back as it was at the end.
 *  Not a test: it runs the real program. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import headless from "@xterm/headless";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { ensureGrokHooks, GROK_HOOK_FILE, grokHome } from "../src/terminals/grokHooks.js";
import { agentLauncher, QUICK_HOOK_TIMEOUT_S } from "../src/terminals/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const grok = process.env.GROK_BIN ?? execSync("command -v grok").toString().trim();
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "as-grok-")));
const home = join(tmp, "as");
mkdirSync(home);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (what: string, ...rest: unknown[]) => console.log(what, ...rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))));

const own = grokHome();
if (!own) throw new Error("no home folder");
const hookFile = join(own, "hooks", GROK_HOOK_FILE);
const hadHooks = existsSync(hookFile);
const trustFile = join(own, "trusted_folders.toml");
const trustBefore = existsSync(trustFile) ? readFileSync(trustFile, "utf8") : null;
const configFile = join(own, "config.toml");
const configBefore = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
if (trustBefore !== null) copyFileSync(trustFile, join(tmp, "trusted_folders.toml.before"));

let port = 0;
const cfg = { home, targetsPath: resolve(here, "..", "config", "targets.yaml"), port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "", watchSessions: true } as unknown as DaemonConfig;
// As the service's own environment is: not a terminal's (this may be run from inside an AgentSwitch terminal).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(CLAUDE|CODEX|AGENTSWITCH_TERMINAL)/.test(k) && !/^(ssl_cert_file|requests_ca_bundle|node_extra_ca_certs|secret_gate_home)$/i.test(k))) as NodeJS.ProcessEnv;
const launch = agentLauncher({ binaries: { grok } as never, hookUrl: () => `http://127.0.0.1:${port}`, stateDir: join(home, "terminals"), env, grokHooks: () => ensureGrokHooks(own, QUICK_HOOK_TIMEOUT_S) });
const daemon = buildDaemon(cfg, { terminalLauncher: launch });
const token = ensureLocalToken(home);
const server = await new Promise<{ close(): void }>((done) => { const s = listenLocal(daemon, 0, (info: AddressInfo) => { port = info.port; done(s); }, new LocalAuth(token)); });
daemon.setLocalPort(port);
const api = `http://127.0.0.1:${port}`;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(api + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};

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
  return { events, lines, stop: () => ctl.abort() };
}
const info = async (id: string) => (await call("GET", `/terminals/${id}`)).json.terminal as Record<string, any>;
const show = (lines: string[], rows = 14) => { let end = lines.length; while (end > 0 && !lines[end - 1]!.trim()) end -= 1; for (const l of lines.slice(Math.max(0, end - rows), end)) if (l.trim()) console.log("     │" + l.trimEnd().slice(0, 130)); };
const brief = (t: Record<string, any>) => ({ status: t.status, name: t.name, session: t.agentSessionId ? `…${String(t.agentSessionId).slice(-6)}` : null, mode: t.modeNow, hooks: t.hooks, activity: t.activity ? `${t.activity.tool}: ${t.activity.target}` : null,
  choices: t.choices ? { title: String(t.choices.title).slice(0, 60), options: t.choices.options.map((o: any) => o.label + (o.key ? ` [${o.key}]` : "")), selected: t.choices.selected } : null });
async function until(what: string, test: (t: Record<string, any>) => boolean, id: string, ms = 60_000): Promise<Record<string, any>> {
  const end = Date.now() + ms;
  for (;;) {
    const t = await info(id);
    if (test(t)) { say(`   ✓ ${what}`, brief(t)); return t; }
    if (Date.now() > end) { say(`   ✗ NOT seen: ${what}`, brief(t)); return t; }
    await sleep(250);
  }
}

const cwd = join(tmp, "w");
mkdirSync(cwd);
writeFileSync(join(cwd, "probe-file.txt"), "x\n");
execSync("git init -q", { cwd });
let id = "", session = "";
const checks: [string, boolean][] = [];
const check = (what: string, ok: boolean) => { checks.push([what, ok]); say(`   ${ok ? "PASS" : "FAIL"} ${what}`); };
try {
  say(`== Grok ${execSync(`${JSON.stringify(grok)} --version`).toString().trim()} in a folder it has not seen (${cwd})`);
  const started = await call("POST", "/terminals", { harness: "grok", cwd, mode: "manual", effort: "low" });
  if (started.status >= 300) throw new Error(`could not start: ${started.status} ${JSON.stringify(started.json)}`);
  id = started.json.terminal.id as string;
  check("its hook file is in Grok's folder", existsSync(hookFile));
  const scr = follow(id), rec = follow(id, "?view=record");

  say("-- 1. the folder question");
  let t = await until("the question is offered as a list", (x) => !!x.choices, id, 15_000);
  check("two rows, each with its key; no session yet", t.choices?.options?.length === 2 && t.choices.options[0].key === "y" && t.choices.options[1].key === "n" && !t.agentSessionId);
  const refused = await call("POST", `/terminals/${id}/input`, { text: "yes please", submit: true });
  check(`a reply is not typed into the question (${refused.status} ${refused.json.code ?? ""})`, refused.status === 409 && refused.json.code === "choices");
  const took = await call("POST", `/terminals/${id}/choices`, { pick: 0, label: t.choices.options[0].label });
  check(`"${t.choices.options[0].label}" taken through the service (${took.status})`, took.status === 200);
  t = await until("its hooks say which session it writes", (x) => !!x.agentSessionId, id, 20_000);
  session = t.agentSessionId ?? "";
  check("a session, at rest, asking each time, no list left", !!session && t.status === "idle" && t.modeNow === "default" && !t.choices);

  say("-- 2. a turn that asks before a tool");
  const sent = await call("POST", `/terminals/${id}/input`, { text: "Run the shell command: rm probe-file.txt  Then reply with the single word done.", submit: true });
  check(`the reply is sent (${sent.status})`, sent.status === 200);
  await until("at work", (x) => x.status === "working", id, 20_000);
  t = await until("waiting for you, its question offered as a list", (x) => x.status === "waiting" && !!x.choices, id, 60_000);
  show(scr.lines());
  check("the list before a tool: five rows, the selection on \"Yes, proceed\"", t.choices?.options?.length === 5 && t.choices.options[t.choices.selected]?.label === "Yes, proceed");
  check("named by its session's title, not by what it is doing", typeof t.name === "string" && !/Action Required|[⠀-⣿]/u.test(t.name) && t.name !== "grok");
  const yes = await call("POST", `/terminals/${id}/choices`, { pick: t.choices.selected, label: "Yes, proceed" });
  check(`"Yes, proceed" taken through the service (${yes.status})`, yes.status === 200);
  await until("it goes on", (x) => x.status === "working" || x.status === "idle", id, 15_000);
  t = await until("the turn ended", (x) => x.status === "idle", id, 60_000);
  check("the file is gone: the command ran", !existsSync(join(cwd, "probe-file.txt")));
  show(scr.lines());

  say("-- 3. what the screens that show the record were told");
  const kinds = [...new Set(rec.events.map((e) => e.event))];
  say("   events:", kinds.join(" "));
  const statuses = rec.events.filter((e) => e.event === "status").map((e) => e.data?.status);
  say("   statuses:", statuses.join(" → "));
  check("working → waiting → working → idle", /working.*waiting.*working.*idle/.test(statuses.join(" ")));
  const record = await call("GET", `/sessions/grok/${session}/record`);
  const items = (record.json.items ?? []) as { type: string; text?: string }[];
  say(`   its record (${record.status}): ${items.map((i) => i.type).join(" ")}`);
  check("its record holds what was said", items.some((i) => i.type === "user") && items.some((i) => /done/i.test(i.text ?? "")));

  say("-- 4. its level and its model from a screen");
  const effort = await call("POST", `/terminals/${id}/effort`, { effort: "high" });
  await sleep(1500);
  check(`/effort high typed for the screen (${effort.status})`, effort.status === 200 && /\(high\)/.test(scr.lines().join("\n")));
  show(scr.lines(), 5);
  const commands = (await call("GET", `/terminals/${id}/commands`)).json.commands as { name: string }[] | undefined;
  check(`its commands are listed (${commands?.length ?? 0})`, (commands?.length ?? 0) > 20);

  say("-- 5. its end");
  scr.stop(); rec.stop();
} catch (err) {
  say("stopped:", (err as Error).message);
  checks.push(["ran to the end", false]);
} finally {
  if (id) await call("DELETE", `/terminals/${id}`).catch(() => undefined);
  await sleep(1500);
  // Its session of the turn goes: the list leaves out a session under the temporary directory, so not through the
  // service's delete (which takes a listed one) but its folder itself — the one named for it, with its conversation in it.
  const kept = session ? join(own, "sessions", encodeURIComponent(cwd), session) : "";
  // (With it the folder Grok keeps for the temporary folder's sessions and prompt history: named for that folder alone.)
  try {
    if (kept && existsSync(join(kept, "updates.jsonl")) && dirname(kept).includes(encodeURIComponent(tmp))) { rmSync(dirname(kept), { recursive: true, force: true }); say("   its session's folder is removed again"); }
  } catch (err) { say(`   its session's folder was not removed (${(err as Error).message}): ${kept}`); }
}
await sleep(300);
server.close();
daemon.close();
// What it changed of the user's Grok, put back.
if (!hadHooks && process.env.PROBE_KEEP_HOOKS !== "1") { rmSync(hookFile, { force: true }); say("   the hook file is removed again (it was not there before)"); }
if (trustBefore !== null) {
  const now = readFileSync(trustFile, "utf8");
  const without = now.replace(new RegExp(`\\n?\\[folders\\."${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]\\ntrusted = true\\ndecided_at = \\d+\\n`), "");
  if (without === trustBefore || without.trimEnd() === trustBefore.trimEnd()) { writeFileSync(trustFile, trustBefore); say("   the probe folder's trust entry is taken out again"); }
  else say("   trusted_folders.toml changed otherwise meanwhile: left as it is (the probe folder's entry is harmless, the folder is deleted)");
}
if (configBefore !== null && readFileSync(configFile, "utf8") !== configBefore) { writeFileSync(configFile, configBefore); say("   Grok's config.toml is put back as it was (the level typed for the probe is not kept)"); }
rmSync(tmp, { recursive: true, force: true });
const failed = checks.filter(([, ok]) => !ok);
say(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — failed: ${failed.map(([w]) => w).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
