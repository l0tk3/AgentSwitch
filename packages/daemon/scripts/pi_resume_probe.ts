/** A pi session gone on with and forked from AgentSwitch's terminals (docs/terminal-v0.md §5), for real: the service's
 *  own code and YOUR pi's program, on a throw-away agent folder (`PI_CODING_AGENT_DIR`) — not your sessions, settings
 *  or sign-in. No model is called and nothing is typed into pi: a session is made with pi's own session code, and pi
 *  is only started on it and looked at.
 *
 *    npx tsx scripts/pi_resume_probe.ts          # PI_BIN=<another pi> to try another one
 *
 *  What it shows, a line each: the session is listed; "continue" in its own folder is the same session (its words on
 *  pi's screen, no question asked, no file made — what pi writes as it opens goes into that session's own file) and
 *  the same terminal when asked twice; a new pi terminal says which
 *  session it writes (the extension); "continue" in another folder is a fork (a new session under that folder, the
 *  first one's file as it was), and the fork's own id is the terminal's; what pi itself does when asked for the same
 *  session from another folder (it asks — which is why the service asks for the fork); and that your own pi's
 *  sessions, settings and sign-in are as they were. Not a test: it runs the real pi. */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { agentLauncher } from "../src/terminals/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const PI = process.env.PI_BIN ?? join(homedir(), ".local", "bin", "pi");
if (!existsSync(PI)) { console.log(`missing: ${PI}`); process.exit(1); }
// pi's own code, to make the session with: beside the program its launcher starts (a managed install).
const mine = dirname(dirname(realpathSync(PI)));
const version = existsSync(join(mine, "install", "current-version")) ? readFileSync(join(mine, "install", "current-version"), "utf8").trim() : "";
const SDK = join(mine, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
if (!version || !existsSync(SDK)) { console.log(`not a managed pi install (no session code found beside ${PI})`); process.exit(1); }

// The user's own pi: looked at by name, size and time only, to say it is as it was.
const OWN = join(homedir(), ".pi", "agent");
const sha = (f: string) => (existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 12) : "-");
const tree = (dir: string): string => {
  if (!existsSync(dir)) return "-";
  const rows: string[] = [];
  for (const folder of readdirSync(dir).sort()) {
    const at = join(dir, folder);
    if (!statSync(at).isDirectory()) continue;
    for (const name of readdirSync(at).sort()) { const st = statSync(join(at, name)); rows.push(`${folder}/${name}:${st.size}:${st.mtimeMs}`); }
  }
  return createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 12);
};
const own = () => ({ sessions: tree(join(OWN, "sessions")), settings: sha(join(OWN, "settings.json")), models: sha(join(OWN, "models.json")), auth: existsSync(join(OWN, "auth.json")) ? statSync(join(OWN, "auth.json")).mtimeMs : 0 });
const before = own();

const base = join(here, "..", "node_modules", ".cache");
mkdirSync(base, { recursive: true });
const tmp = realpathSync(mkdtempSync(join(base, "as-pi-resume-")));
const home = join(tmp, "as"), agent = join(tmp, "agent"), site = join(tmp, "w", "site"), other = join(tmp, "w", "elsewhere");
for (const dir of [home, agent, join(tmp, "home"), site, other]) mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (what: string, ...rest: unknown[]) => console.log(what, ...rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))));
// What pi and the session-making run with: nothing of this shell's (an AgentSwitch terminal's has the real service's
// settings), pi's folder the throw-away one, no network at start.
const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: join(tmp, "home"), LANG: "en_US.UTF-8", TERM: "xterm-256color", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" };

// A session as pi writes one: a question and an answer, under the folder it "ran" in.
const made = spawnSync(process.execPath, ["--input-type=module", "-e", `
  const { SessionManager } = await import(process.argv[1]);
  const sm = SessionManager.create(process.cwd());
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  sm.appendMessage({ role: "user", content: [{ type: "text", text: "PROBE-QUESTION one" }], timestamp: Date.now() });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "PROBE-ANSWER one" }], api: "openai-completions", provider: "probe", model: "probe-model", usage, stopReason: "stop", timestamp: Date.now() });
  console.log(JSON.stringify({ id: sm.getSessionId(), file: sm.getSessionFile() }));
`, SDK], { cwd: site, env, encoding: "utf8" });
const seed = (() => { try { return JSON.parse(made.stdout.trim().split("\n").pop() ?? "") as { id: string; file: string }; } catch { return null; } })();
if (!seed || !existsSync(seed.file) || !seed.file.startsWith(agent)) {
  console.log("could not make a session with pi's own code:", made.stderr.slice(0, 400) || made.stdout.slice(0, 400));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
const files = () => readdirSync(join(agent, "sessions")).sort().flatMap((folder) => readdirSync(join(agent, "sessions", folder)).sort().map((name) => `${folder}/${name}`));
const stamp = (f: string) => { const st = statSync(f); return `${st.size}:${st.mtimeMs}`; };
const first = { files: files(), stamp: stamp(seed.file) };
say(`pi ${version}: a session made with its own code`, { id: seed.id, files: first.files.length });

let port = 0;
const cfg = { home, targetsPath: resolve(here, "..", "config", "targets.yaml"), port: 0, opencodeBinary: "", watchSessions: true } as unknown as DaemonConfig;
const daemon = buildDaemon(cfg, {
  terminalLauncher: agentLauncher({ binaries: { pi: PI }, hookUrl: () => `http://127.0.0.1:${port}`, stateDir: join(home, "terminals"), env }),
  // Only the throw-away pi folder is read: not this Mac's Claude Code, Codex, OpenCode or pi sessions.
  sessionSources: { claudeProjects: join(tmp, "no-claude"), codexSessions: join(tmp, "no-codex"), opencodeDb: join(tmp, "no.db"), piSessions: join(agent, "sessions"), excluded: [] },
});
const token = ensureLocalToken(home);
const server = await new Promise<ReturnType<typeof listenLocal>>((done) => { const s = listenLocal(daemon, 0, (info: AddressInfo) => { port = info.port; done(s); }, new LocalAuth(token)); });
daemon.setLocalPort(port);
const host = daemon.terminals!;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};
/** Everything the terminal holds, scrolled-off lines too, as text. */
type Shown = { buffer: { active: { length: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined } } };
const screen = (id: string): string => {
  const s = (host as unknown as { sessions: Map<string, { term: Shown }> }).sessions.get(id);
  if (!s) return "";
  const lines: string[] = [];
  for (let y = 0; y < s.term.buffer.active.length; y++) lines.push(s.term.buffer.active.getLine(y)?.translateToString(true) ?? "");
  return lines.join("\n");
};
const info = (id: string) => host.list().find((t) => t.id === id);
/** Waits for `seen` on the terminal, or for it to end; never types. */
const wait = async (id: string, seen: () => boolean, ms = 40_000): Promise<boolean> => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(250)) {
    if (seen()) return true;
    if (!info(id) || info(id)!.status === "exited") return false;
  }
  return false;
};
const asks = (id: string) => /Fork this session into current directory/.test(screen(id));
const tail = (id: string) => screen(id).split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-6).join(" ⏎ ").slice(0, 400);
const close = async (id: string) => { await call("DELETE", `/terminals/${id}`); for (let i = 0; i < 40 && info(id); i++) await sleep(100); };

let failed = 0;
const check = (ok: boolean, what: string, ...rest: unknown[]) => { if (!ok) failed++; say(`${ok ? "ok  " : "FAIL"} ${what}`, ...rest); };
try {
  const listed = ((await call("GET", "/sessions")).json.sessions as { harness: string; id: string; cwd: string }[]).find((s) => s.harness === "pi" && s.id === seed.id);
  check(listed?.cwd === site, "listed", { harness: listed?.harness, in: listed?.cwd === site ? "its folder" : listed?.cwd });

  // The same session, in its own folder.
  const one = await call("POST", "/terminals/resume", { harness: "pi", cwd: site, agentSessionId: seed.id, cols: 110, rows: 40 });
  const a = one.json.terminal?.id as string;
  check(one.status === 201 && one.json.terminal?.forked === false, "continue in its folder: started", { status: one.status, forked: one.json.terminal?.forked, error: one.json.error });
  const shown = await wait(a, () => screen(a).includes("PROBE-ANSWER one"));
  check(shown, "  its words are on pi's screen", shown ? "" : tail(a));
  check(!asks(a), "  pi asked nothing about a fork");
  check(info(a)?.agentSessionId === seed.id, "  the terminal's session is that one", { status: info(a)?.status });
  // pi may write into the session as it opens it (a line for the model it is on now): into that file, no other.
  check(JSON.stringify(files()) === JSON.stringify(first.files), "  no file made: what pi writes goes into that session's own file", { files: files().length, grew: statSync(seed.file).size - Number(first.stamp.split(":")[0]) });
  const twice = await call("POST", "/terminals/resume", { harness: "pi", cwd: site, agentSessionId: seed.id });
  check(twice.json.existing === true && twice.json.terminal?.id === a, "  asked again: the same terminal");

  // A new pi terminal says which session it writes.
  const fresh = await call("POST", "/terminals", { harness: "pi", cwd: other, cols: 110, rows: 40 });
  const n = fresh.json.terminal?.id as string;
  const told = await wait(n, () => Boolean(info(n)?.agentSessionId));
  check(told && info(n)!.agentSessionId !== seed.id, "a new pi terminal says which session it writes", { session: told ? "an id of its own" : null, screen: told ? "" : tail(n) });
  await close(n);

  // Another folder: the terminal it is open in first; once that is closed, a fork.
  const open = await call("POST", "/terminals/resume", { harness: "pi", cwd: other, agentSessionId: seed.id });
  check(open.json.existing === true && open.json.terminal?.id === a, "continue in another folder while it is open here: the terminal it is open in");
  await close(a);
  const kept = stamp(seed.file);
  const moved = await call("POST", "/terminals/resume", { harness: "pi", cwd: other, agentSessionId: seed.id, cols: 110, rows: 40 });
  const b = moved.json.terminal?.id as string;
  check(moved.status === 201 && moved.json.terminal?.forked === true, "continue in another folder: started as a fork", { status: moved.status, forked: moved.json.terminal?.forked, error: moved.json.error });
  const forkShown = await wait(b, () => screen(b).includes("PROBE-ANSWER one") && Boolean(info(b)?.agentSessionId));
  check(forkShown, "  the first session's words are on pi's screen", forkShown ? "" : tail(b));
  check(!asks(b), "  pi asked nothing");
  const forkId = info(b)?.agentSessionId ?? null;
  check(Boolean(forkId) && forkId !== seed.id && host.ownSession(b) === forkId, "  the terminal's session is the fork's own", { own: host.ownSession(b) === forkId });
  const now = files();
  const added = now.filter((f) => !first.files.includes(f));
  check(added.length === 1 && Boolean(forkId) && added[0]!.includes(forkId!) && !added[0]!.startsWith(first.files[0]!.split("/")[0]!), "  one new file, under the other folder, named by the fork's id", { files: now.length });
  check(stamp(seed.file) === kept, "  the first session's file is as it was");
  const again = await call("POST", "/terminals/resume", { harness: "pi", cwd: other, agentSessionId: forkId });
  check(again.json.existing === true && again.json.terminal?.id === b, "  continue the fork: the terminal it is open in");
  await close(b);

  // A fork asked for, in the session's own folder.
  const asked = await call("POST", "/terminals/resume", { harness: "pi", cwd: site, agentSessionId: seed.id, fork: true, cols: 110, rows: 40 });
  const c = asked.json.terminal?.id as string;
  const askedOk = await wait(c, () => Boolean(info(c)?.agentSessionId));
  check(asked.status === 201 && askedOk && info(c)!.agentSessionId !== seed.id && stamp(seed.file) === kept, "a fork asked for in its own folder: a session of its own, the first as it was", { files: files().length });
  await close(c);

  // What pi does by itself when the same session is asked for from another folder (not through the route).
  const bare = await host.spawn({ harness: "pi", cwd: other, resume: seed.id, cols: 110, rows: 40 });
  const question = await wait(bare.id, () => asks(bare.id), 20_000);
  say(`${question ? "seen" : "NOT SEEN"} pi itself, asked for the session from another folder, asks in the terminal:`, question ? (screen(bare.id).split("\n").find((l) => /Fork this session/.test(l)) ?? "").trim() : tail(bare.id));
  host.remove(bare.id);
} finally {
  host.closeAll();
  server.close();
  daemon.close();
  await sleep(500);
  const left = (() => { try { return execFileSync("pgrep", ["-f", tmp], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } })();
  for (const pid of left) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  rmSync(tmp, { recursive: true, force: true });
  const after = own();
  check(JSON.stringify(after) === JSON.stringify(before), "your own pi is as it was: its sessions (names, sizes, times), settings, models and sign-in", { left: left.length });
}
console.log(failed ? `${failed} FAILED` : "all as expected");
process.exit(failed ? 1 : 0);
