/** A real Antigravity CLI in one of AgentSwitch's terminals, through the service's own code (docs/terminal-v0.md §3
 *  Antigravity; 2026-11-26, user #508): what the service makes of it from the moment it starts in a folder it does not
 *  trust, through one turn that asks before a command, a change of level and model from a screen, a second start in a
 *  folder AgentSwitch trusts, and going on with the conversation, to its end.
 *
 *    npx tsx scripts/agy_terminal_probe.ts
 *
 *  YOUR `agy` (`AGY_BIN`, else the one on the PATH), signed in as you are: the one turn asks its model for a few words
 *  and costs a little of your quota (`PROBE_NO_TURN=1` leaves the turn, and what needs one, out). What it leaves, and
 *  takes away again:
 *  - AgentSwitch's entry in Antigravity's MCP configuration (`<home>/config/mcp_config.json`, `agentswitch`) is
 *    written, as an Antigravity terminal writes it; the file is put back as it was at the end (`PROBE_KEEP_MCP=1`
 *    leaves it).
 *  - The folders it runs in are new ones under the system's temporary directory. "Yes, I trust this folder" is taken
 *    there through the service, as a screen would take it, and the second folder is trusted the way AgentSwitch's own
 *    list does it: both entries are taken out of `settings.json` again at the end. A level and a model typed from a
 *    screen are kept by the program as what your later sessions start on: `model` there is put back as it was too.
 *  - Its conversation of the turn is deleted at the end, by the service's own delete.
 *  `AGENTSWITCH_AGY_HOME=<dir>` runs it against a home other than `~/.gemini` (the program's `--gemini_dir`; the one
 *  sign-in in the keychain serves it too — a new one first walks through the program's welcome screens by hand).
 *  Not a test: it runs the real program. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import headless from "@xterm/headless";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { ModelOffers } from "../src/models/modelOffers.js";
import { AGY_HOME_VAR, AGY_MCP_SERVER, agyGeminiDir, agyHome, ensureAgyMcp } from "../src/terminals/agy.js";
import { elsewhereCheck } from "../src/terminals/elsewhere.js";
import { agentLauncher, ROOM_KIT_SCRIPT } from "../src/terminals/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const agy = process.env.AGY_BIN ?? execSync("command -v agy").toString().trim();
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "as-agy-")));
const home = join(tmp, "as");
mkdirSync(home);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (what: string, ...rest: unknown[]) => console.log(what, ...rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))));
const turn = process.env.PROBE_NO_TURN !== "1";

const gem = agyGeminiDir(), own = agyHome();
const settingsFile = join(own, "settings.json"), mcpFile = join(gem, "config", "mcp_config.json");
const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null);
const settingsBefore = read(settingsFile), mcpBefore = read(mcpFile);

let port = 0;
const cfg = { home, targetsPath: resolve(here, "..", "config", "targets.yaml"), port: 0, opencodeBinary: "", watchSessions: true } satisfies DaemonConfig;
// As the service's own environment is: not a terminal's (this may be run from inside an AgentSwitch terminal).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(CLAUDE|CODEX|AGENTSWITCH_TERMINAL|AGENTSWITCH_ROOM_KIT)/.test(k) && !/^(ssl_cert_file|requests_ca_bundle|node_extra_ca_certs|secret_gate_home)$/i.test(k))) as NodeJS.ProcessEnv;
const cwd = join(tmp, "w"), trusted = join(tmp, "t");
mkdirSync(cwd); mkdirSync(trusted);
const launch = agentLauncher({ binaries: { agy } as never, hookUrl: () => `http://127.0.0.1:${port}`, stateDir: join(home, "terminals"), env, agyMcp: () => ensureAgyMcp(gem, process.execPath, ROOM_KIT_SCRIPT), trustedFolders: () => [trusted] });
const modelOffers = new ModelOffers({ agyBinary: agy, agyHome: own, agyGeminiDir: process.env[AGY_HOME_VAR]?.trim() || null, listClaude: async () => [], log: (l) => say(`   ${l}`) });
await modelOffers.refresh();
const daemon = buildDaemon(cfg, { terminalLauncher: launch, modelOffers });
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
/** The screen's last rows, without the line that names the account. */
const show = (lines: string[], rows = 12) => { let end = lines.length; while (end > 0 && !lines[end - 1]!.trim()) end -= 1; for (const l of lines.slice(Math.max(0, end - rows), end)) if (l.trim() && !l.includes("@")) console.log("     │" + l.trimEnd().slice(0, 130)); };
const brief = (t: Record<string, any>) => ({ status: t.status, name: t.name, session: t.agentSessionId ? `…${String(t.agentSessionId).slice(-6)}` : null, mode: t.modeNow, model: t.modelNow, effort: t.effort, hooks: t.hooks,
  choices: t.choices ? { title: String(t.choices.title).slice(0, 60), options: t.choices.options.map((o: any) => String(o.label).slice(0, 40)), selected: t.choices.selected } : null });
async function until(what: string, test: (t: Record<string, any>) => boolean, id: string, ms = 60_000): Promise<Record<string, any>> {
  const end = Date.now() + ms;
  for (;;) {
    const t = await info(id);
    if (test(t)) { say(`   ✓ ${what}`, brief(t)); return t; }
    if (Date.now() > end) { say(`   ✗ NOT seen: ${what}`, brief(t)); return t; }
    await sleep(250);
  }
}

writeFileSync(join(cwd, "probe-file.txt"), "x\n");
let id = "", session = "";
const ids: string[] = [];
const checks: [string, boolean][] = [];
const check = (what: string, ok: boolean) => { checks.push([what, ok]); say(`   ${ok ? "PASS" : "FAIL"} ${what}`); };
try {
  say(`== Antigravity CLI ${execSync(`${JSON.stringify(agy)} --version`).toString().trim()}, home ${gem}, in a folder it has not seen (${cwd})`);
  check("its models are offered, each once with its levels", (modelOffers.current().agy?.models.length ?? 0) > 0);
  say("   models:", (modelOffers.current().agy?.models ?? []).map((m) => `${m.id}${m.efforts?.length ? ` [${m.efforts.join(" ")}]` : ""}`).join(", "));
  const started = await call("POST", "/terminals", { harness: "agy", cwd, mode: "manual" });
  if (started.status >= 300) throw new Error(`could not start: ${started.status} ${JSON.stringify(started.json)}`);
  id = started.json.terminal.id as string; ids.push(id);
  check("AgentSwitch's entry is in its MCP configuration", Boolean((JSON.parse(read(mcpFile) || "{}") as { mcpServers?: Record<string, unknown> }).mcpServers?.[AGY_MCP_SERVER]));
  const scr = follow(id), rec = follow(id, "?view=record");

  say("-- 1. the folder question");
  let t = await until("the question is offered as a list", (x) => !!x.choices, id, 20_000);
  check("two rows, the selection on the first; no conversation yet", t.choices?.options?.length === 2 && t.choices.selected === 0 && /trust/i.test(t.choices.options[0].label) && !t.agentSessionId);
  const refused = await call("POST", `/terminals/${id}/input`, { text: "yes please", submit: true });
  check(`a reply is not typed into the question (${refused.status} ${refused.json.code ?? ""})`, refused.status === 409 && refused.json.code === "choices");
  const took = await call("POST", `/terminals/${id}/choices`, { pick: 0, label: t.choices.options[0].label });
  check(`"${t.choices.options[0].label}" taken through the service (${took.status})`, took.status === 200);
  t = await until("its status line says it rests, asking each time, on a model", (x) => x.status === "idle" && !x.choices && !!x.modelNow && x.modeNow === "default", id, 30_000);
  check("at rest, asking each time, its model known by the menus' id, no list left", t.status === "idle" && t.modeNow === "default" && /^[a-z0-9.-]+$/.test(t.modelNow ?? "") && !t.choices);
  show(scr.lines(), 6);
  await sleep(3000);
  const kit = execSync("ps -axo command").toString().split("\n").filter((l) => l.includes(ROOM_KIT_SCRIPT));
  check("the Chat Room's tool server runs beside it (its MCP entry started it)", kit.length > 0);

  if (turn) {
    say("-- 2. a turn that asks before a command");
    const sent = await call("POST", `/terminals/${id}/input`, { text: "Run the shell command: rm probe-file.txt  Then reply with the single word done.", submit: true });
    check(`the reply is sent (${sent.status})`, sent.status === 200);
    t = await until("at work, the conversation it writes known", (x) => x.status === "working" && !!x.agentSessionId, id, 30_000);
    session = t.agentSessionId ?? "";
    t = await until("waiting for you, its question offered as a list", (x) => x.status === "waiting" && !!x.choices, id, 90_000);
    show(scr.lines());
    check("the list before a command: the selection on \"Yes, run command\", a way to say no", /^Yes, run/.test(t.choices?.options?.[t.choices.selected]?.label ?? "") && t.choices.options.some((o: any) => /^No/.test(o.label)));
    const yes = await call("POST", `/terminals/${id}/choices`, { pick: t.choices.selected, label: t.choices.options[t.choices.selected].label });
    check(`"Yes, run command" taken through the service (${yes.status})`, yes.status === 200);
    await until("it goes on", (x) => x.status === "working" || x.status === "idle", id, 15_000);
    t = await until("the turn ended", (x) => x.status === "idle", id, 90_000);
    check("the file is gone: the command ran", !existsSync(join(cwd, "probe-file.txt")));
    show(scr.lines());
    await sleep(1500);
    t = await until("named by its conversation's title", (x) => typeof x.name === "string" && x.name !== "w" && x.name !== "Antigravity", id, 20_000);

    say("-- 3. what the screens that show the record were told");
    const statuses = rec.events.filter((e) => e.event === "status").map((e) => e.data?.status);
    say("   statuses:", statuses.join(" → "));
    check("working → waiting → working → idle", /working.*waiting.*working.*idle/.test(statuses.join(" ")));
    const record = await call("GET", `/sessions/agy/${session}/record`);
    const items = (record.json.items ?? []) as { type: string; text?: string }[];
    say(`   its record (${record.status}): ${items.map((i) => i.type).join(" ")}`);
    check("its record holds what was said", items.some((i) => i.type === "user") && items.some((i) => /done/i.test(i.text ?? "")));
  }

  say("-- 4. its level and its model from a screen");
  const effort = await call("POST", `/terminals/${id}/effort`, { effort: "low" });
  t = await until("its status line says the level it is at now", (x) => x.effort === "low", id, 10_000);
  check(`/effort low typed for the screen (${effort.status}); the terminal is at it`, effort.status === 200 && t.effort === "low");
  show(scr.lines(), 6);
  const other = (modelOffers.current().agy?.models ?? []).find((m) => m.id !== t.modelNow && m.efforts?.length);
  if (other) {
    const model = await call("POST", `/terminals/${id}/model`, { model: other.id });
    t = await until("its status line says the model it is on now", (x) => x.modelNow === other.id, id, 10_000);
    check(`/model ${other.id} typed for the screen (${model.status}); the terminal is on it`, model.status === 200 && t.modelNow === other.id);
    show(scr.lines(), 6);
  }
  const commands = (await call("GET", `/terminals/${id}/commands`)).json.commands as { name: string }[] | undefined;
  check(`its commands are listed (${commands?.length ?? 0})`, (commands?.length ?? 0) > 20);
  scr.stop(); rec.stop();
  await call("DELETE", `/terminals/${id}`).catch(() => undefined);
  await sleep(1500);

  say("-- 5. a folder trusted in AgentSwitch: no question");
  const second = await call("POST", "/terminals", { harness: "agy", cwd: trusted, mode: "auto" });
  const id2 = second.json.terminal?.id as string; ids.push(id2);
  // (Its first readings name no mode yet: it says `auto` a moment after it rests.)
  t = await until("at rest without having asked, in its automatic mode", (x) => x.status === "idle" && !!x.modelNow && x.modeNow === "auto", id2, 30_000);
  check("no list on its screen; in its automatic mode", !t.choices && t.modeNow === "auto");
  check("the folder is in its own list", ((JSON.parse(read(settingsFile) || "{}") as { trustedWorkspaces?: string[] }).trustedWorkspaces ?? []).includes(trusted));
  await call("DELETE", `/terminals/${id2}`).catch(() => undefined);
  await sleep(1500);

  if (turn && session) {
    say("-- 6. going on with the conversation");
    const again = await call("POST", "/terminals/resume", { harness: "agy", cwd, agentSessionId: session });
    const id3 = again.json.terminal?.id as string; ids.push(id3);
    t = await until("the same conversation, by its title", (x) => x.agentSessionId === session && x.status === "idle" && !!x.modelNow && x.name !== "w", id3, 30_000);
    await sleep(1000);
    check(`it goes on in the same conversation (${again.status})`, t.agentSessionId === session);
    const open = await elsewhereCheck({ agyHome: own })("agy", session, []).catch(() => null);
    check("the conversation's mark is held by its program while it is open", open !== null);
    await call("DELETE", `/terminals/${id3}`).catch(() => undefined);
    await sleep(1500);
  }
} catch (err) {
  say("stopped:", (err as Error).message);
  checks.push(["ran to the end", false]);
} finally {
  for (const one of ids) if (one) await call("DELETE", `/terminals/${one}`).catch(() => undefined);
  await sleep(1500);
  // Its conversation of the turn goes, by the service's own delete (the list leaves out one under the temporary
  // directory, so by its id).
  if (session && daemon.sessions) {
    const gone = await daemon.sessions.remove("agy", session).catch(() => ({ removed: [], failed: ["?"] }));
    say(`   its conversation is deleted again (${gone.removed.length} removed, ${gone.failed.length} failed)`);
  }
}
await sleep(300);
server.close();
daemon.close();
// What it changed of the user's Antigravity, put back.
if (settingsBefore !== null || existsSync(settingsFile)) {
  try {
    const now = JSON.parse(read(settingsFile) || "{}") as Record<string, unknown>;
    const before = settingsBefore ? JSON.parse(settingsBefore) as Record<string, unknown> : {};
    const list = Array.isArray(now.trustedWorkspaces) ? (now.trustedWorkspaces as unknown[]).filter((f) => typeof f !== "string" || !f.startsWith(tmp)) : undefined;
    const next: Record<string, unknown> = { ...now, ...(list ? { trustedWorkspaces: list } : {}) };
    if ("model" in before) next.model = before.model; else delete next.model;
    if (list && !list.length && !("trustedWorkspaces" in before)) delete next.trustedWorkspaces;
    const same = JSON.stringify(next) === JSON.stringify(before);
    if (settingsBefore !== null && same) writeFileSync(settingsFile, settingsBefore);
    else writeFileSync(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    say("   its settings are put back: the probe's folders out of its trusted list, its own model as it was");
  } catch (err) { say(`   its settings were not put back (${(err as Error).message}): ${settingsFile}`); }
}
if (process.env.PROBE_KEEP_MCP !== "1") {
  if (mcpBefore !== null) writeFileSync(mcpFile, mcpBefore); else rmSync(mcpFile, { force: true });
  say("   its MCP configuration is put back as it was");
}
rmSync(tmp, { recursive: true, force: true });
const failed = checks.filter(([, ok]) => !ok);
say(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — failed: ${failed.map(([w]) => w).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
