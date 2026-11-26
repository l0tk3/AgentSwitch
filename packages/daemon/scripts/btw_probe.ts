/** A room's question answered beside the turn, through a real Claude Code's own `/btw` (docs/chatroom-v0.md §13;
 *  2026-11-26, user #529, #538): the service's own code, a real terminal, a real model, one prompt of yours.
 *
 *    npx tsx scripts/btw_probe.ts
 *
 *  It starts a Claude Code in a temporary folder and asks it for a slow shell command (one short prompt, a little of
 *  your plan). While that runs, the user's message names it in a new room and asks for an answer: the service puts the
 *  same question to it through `/btw`, reads the panel, closes it with Esc, and says the answer in the room as the
 *  member, marked `aside` — while the message itself stays queued for the main line, which goes on and finishes.
 *
 *  The terminal runs under a temporary Claude Code setup of its own (its own `CLAUDE_CONFIG_DIR`, the probe folder
 *  trusted, the bypass warning off), signed in with the key of THIS terminal's profile, asked of this terminal's own
 *  service as its agent's `apiKeyHelper` does — never printed, never kept. Everything under the temporary folder goes
 *  at the end, its session included. Not a test: it runs the real program. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import headless from "@xterm/headless";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { asideOnScreen, type AsideAnswer } from "../src/terminals/host.js";
import { agentLauncher } from "../src/terminals/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const claude = process.env.CLAUDE_BIN ?? execSync("command -v claude").toString().trim();
const model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (what: string, ...rest: unknown[]) => console.log(what, ...rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))));

const base = join(here, "..", "node_modules", ".cache");
mkdirSync(base, { recursive: true });
const tmp = realpathSync(mkdtempSync(join(base, "as-btw-probe-")));
const home = join(tmp, "as"), cwd = join(tmp, "w"), configDir = join(tmp, "claude");
mkdirSync(home); mkdirSync(cwd); mkdirSync(configDir);
// Its own Claude Code setup: the folder trusted, the bypass warning off, the model this account's gateway names.
writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3, projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true } } }));
writeFileSync(join(configDir, "settings.json"), JSON.stringify({ ...(model ? { model } : {}), skipDangerousModePermissionPrompt: true }));

// The key this terminal's profile pays by, as its agent's apiKeyHelper asks for it: not printed, not kept.
const own = { url: process.env.AGENTSWITCH_TERMINAL_URL ?? "", id: process.env.AGENTSWITCH_TERMINAL_ID ?? "", token: process.env.AGENTSWITCH_TERMINAL_HOOK_TOKEN ?? "" };
if (!own.url || !own.id || !own.token) { console.error("run this from an AgentSwitch terminal: it needs the terminal's own service and token"); process.exit(2); }
const keyed = await fetch(`${own.url}/terminals/key`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${own.token}`, "x-agentswitch-terminal": own.id }, body: "{}" });
const key = keyed.ok ? ((await keyed.json()) as { key?: string }).key ?? "" : "";
if (!key) { console.error(`this terminal's profile pays by no key (${keyed.status}): the probe starts its own Claude Code, which would have no way in`); process.exit(2); }

let port = 0;
const cfg = { home, targetsPath: resolve(here, "..", "config", "targets.yaml"), port: 0, opencodeBinary: "", watchSessions: true } satisfies DaemonConfig;
// As the service's own environment is: not this terminal's (this is run from inside one).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PROJECT_DIR$|AGENTSWITCH_TERMINAL)/.test(k) && !/^(https?_proxy|all_proxy|no_proxy)$/i.test(k))) as NodeJS.ProcessEnv;
// As DeepSeek's Anthropic-compatible endpoint takes it: a bearer token, not a key Claude Code would ask about.
Object.assign(env, { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_AUTH_TOKEN: key, DISABLE_AUTOUPDATER: "1" });
const launch = agentLauncher({ binaries: { "claude-code": claude } as never, hookUrl: () => `http://127.0.0.1:${port}`, stateDir: join(home, "terminals"), env });
const daemon = buildDaemon(cfg, { terminalLauncher: launch });
const token = ensureLocalToken(home);
const server = await new Promise<{ close(): void }>((done) => { const s = listenLocal(daemon, 0, (info: AddressInfo) => { port = info.port; done(s); }, new LocalAuth(token)); });
daemon.setLocalPort(port);
const api = `http://127.0.0.1:${port}`;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(api + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};

function follow(id: string) {
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
        if (event === "snapshot" || event === "output") { try { const j = JSON.parse(data); if (typeof j?.data === "string") term.write(j.data); } catch { /* not ours */ } }
      }
    }
  })().catch(() => undefined);
  const lines = () => { const b = term.buffer.active, out: string[] = []; for (let y = b.baseY; y < b.baseY + term.rows; y++) out.push(b.getLine(y)?.translateToString(true).trimEnd() ?? ""); return out; };
  return { lines, stop: () => ctl.abort() };
}
const info = async (id: string) => (await call("GET", `/terminals/${id}`)).json.terminal as Record<string, any>;
const show = (lines: string[], rows = 16) => { let end = lines.length; while (end > 0 && !lines[end - 1]!.trim()) end -= 1; for (const l of lines.slice(Math.max(0, end - rows), end)) if (l.trim()) console.log("     │" + l.slice(0, 130)); };
async function until(what: string, test: (t: Record<string, any>) => boolean, id: string, ms = 90_000): Promise<Record<string, any>> {
  const end = Date.now() + ms;
  for (;;) {
    const t = await info(id);
    if (test(t)) { say(`   ✓ ${what}`, { status: t.status, name: t.name, session: t.agentSessionId ? `…${String(t.agentSessionId).slice(-6)}` : null }); return t; }
    if (Date.now() > end) { say(`   ✗ NOT seen: ${what}`, { status: t.status }); return t; }
    await sleep(250);
  }
}

let id = "", room = "";
const checks: [string, boolean][] = [];
const check = (what: string, ok: boolean, more?: unknown) => { checks.push([what, ok]); say(`   ${ok ? "PASS" : "FAIL"} ${what}${more === undefined ? "" : ` ${JSON.stringify(more)}`}`); };
try {
  say(`== a real Claude Code ${execSync(`${JSON.stringify(claude)} --version`).toString().trim()} in ${cwd}, under its own setup`);
  const made = await call("POST", "/rooms", { name: "旁答探针" });
  if (made.status >= 300) throw new Error(`no room: ${made.status} ${JSON.stringify(made.json)}`);
  room = made.json.room.id as string;
  const started = await call("POST", "/terminals", { harness: "claude-code", cwd, mode: "bypass", ...(model ? { model } : {}) });
  if (started.status >= 300) throw new Error(`could not start: ${started.status} ${JSON.stringify(started.json)}`);
  id = started.json.terminal.id as string;
  const seated = await call("POST", `/rooms/${room}/seats`, { terminal: id });
  if (seated.status >= 300) throw new Error(`could not seat it: ${seated.status} ${JSON.stringify(seated.json)}`);
  const handle = seated.json.seat.handle as string;
  say(`   seated as @${handle}`);
  const scr = follow(id);

  say("-- 1. a turn that takes a while");
  // Its own input box, there and empty: anything typed before it is up goes nowhere (the start's screens are up).
  const onScreen = (re: RegExp): boolean => re.test(scr.lines().join("\n"));
  let t = await until("its input box is up", (x) => x.status === "idle", id, 60_000);
  const ready = Date.now() + 60_000;
  while (Date.now() < ready && !(onScreen(/❯/) && onScreen(/bypass permissions on/u))) await sleep(250);
  show(scr.lines(), 12);
  check("its input box is up, the bypass warning out of the way", onScreen(/❯/) && onScreen(/bypass permissions on/u));
  await sleep(1500);
  const sent = await call("POST", `/terminals/${id}/input`, { text: "Run the shell command sleep 25, then reply with the single word done.", submit: true });
  check(`the prompt is sent (${sent.status})`, sent.status === 200);
  t = await until("at work", (x) => x.status === "working", id, 60_000);
  check("at work", t.status === "working");
  check("it is drawing its working line", onScreen(/esc to interrupt/u));

  say("-- 2. the user asks, while it works");
  await sleep(1500);
  show(scr.lines(), 20);
  say("   while it works:", JSON.stringify({ status: (await info(id)).status, choices: (await info(id)).choices ?? null }));
  const asked = await call("POST", `/rooms/${room}/messages`, { text: `@${handle} 做到哪一步了？`, expects: "answer" });
  check(`the user's message is posted (#${asked.json.message?.seq})`, asked.status === 201);
  const seq = asked.json.message.seq as number;
  check("it is queued for the member, not given", asked.json.receipts?.[handle] === "sent" || asked.json.receipts?.[handle] === "queued", asked.json.receipts);
  const seen: AsideAnswer[] = [];
  let aside: Record<string, any> | null = null, stillWorking = false;
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const list = (await call("GET", `/rooms/${room}/messages`)).json.messages as Record<string, any>[];
    aside = list.find((m) => m.aside) ?? null;
    const now = asideOnScreen(scr.lines());
    if (now && (!seen.length || seen[seen.length - 1]!.answer !== now.answer)) { seen.push(now); }
    if (aside) { stillWorking = (await info(id)).status === "working"; break; }
    await sleep(500);
  }
  check("it opened /btw beside the turn", seen.length > 0, seen.length ? { complete: seen[seen.length - 1]!.complete } : undefined);
  // What was read is what the room got: its answer's words, not just the marker and the note under them.
  const words = aside ? (/〔快速回答 · \/btw〕([\s\S]*?)\n\n原消息/u.exec(String(aside.text))?.[1] ?? "").trim() : "";
  check("the answer was read off the panel", words.length > 5, { words: words.slice(0, 80) });
  check("the room has it as the member, marked aside", !!aside && aside.from === handle && aside.replyTo === seq, aside ? { from: aside.from, replyTo: aside.replyTo, aside: aside.aside } : null);
  check("it says the original is still queued", !!aside && String(aside.text).includes(`#${seq} 已排队`));
  say("   its words:", aside ? String(aside.text).slice(0, 200) : "(none)");
  check("the turn went on beside it", stillWorking);
  if (!aside) {
    // What the probe itself sees when it types what the service would: is the panel there at all during a tool's run?
    say("   no aside: typing /btw as the service does, to see the screen");
    const direct = await call("POST", `/terminals/${id}/input`, { text: "/btw 你现在做到哪一步了？请用一两句话说明。", submit: true });
    say(`   typed (${direct.status}); screen in a moment:`);
    await sleep(6000);
    show(scr.lines(), 24);
    const panel = asideOnScreen(scr.lines());
    say("   panel read directly:", panel ? { complete: panel.complete, working: panel.working, answer: panel.answer.slice(0, 80) } : null);
  }
  check("the panel is closed", !asideOnScreen(scr.lines()));
  const after = (await call("GET", `/rooms/${room}/messages`)).json.messages as Record<string, any>[];
  check("only one aside, and it answers that message", after.filter((m) => m.aside).length === 1 && after.find((m) => m.aside)?.replyTo === seq);

  say("-- 3. the turn ends as it would");
  t = await until("at rest again", (x) => x.status === "idle", id, 120_000);
  check("the main turn finished", t.status === "idle");
  // Its record is under the probe's own Claude Code folder, which the service's session monitor does not read (it
  // reads the Mac's own), so the turn's own end is what says it went on: at rest, with nothing on its screen waiting.
  show(scr.lines(), 12);
  scr.stop();
} catch (err) {
  say("stopped:", (err as Error).message);
  checks.push(["ran to the end", false]);
} finally {
  if (id) await call("DELETE", `/terminals/${id}`).catch(() => undefined);
  await sleep(1000);
  server.close();
  daemon.close();
  rmSync(tmp, { recursive: true, force: true });
}
const failed = checks.filter(([, ok]) => !ok);
say(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — failed: ${failed.map(([w]) => w).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
