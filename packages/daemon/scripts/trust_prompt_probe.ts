/** What a real Claude Code and a real Codex draw when they are started in a folder they do not trust yet, and what
 *  the service makes of it for a screen that shows the record (docs/simple-view-v0.md §5.11, §5.17): the list it reads
 *  off their screen, the status, whether there is a session. The service's own code, YOUR agents; no model is asked
 *  anything — the question comes before the first turn.
 *
 *    npx tsx scripts/trust_prompt_probe.ts            # look only, then close
 *    PROBE_PICK=no npx tsx scripts/trust_prompt_probe.ts   # take "No" through the service, as a screen would
 *
 *  Nothing is answered "yes": no folder is added to what your agents trust. The folders are in the system's temporary
 *  directory and deleted at the end. Not a test: it runs the real programs. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import headless from "@xterm/headless";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, type DaemonConfig } from "../src/daemon.js";
import { agentLauncher } from "../src/terminals/launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const bin = (name: string, env: string) => process.env[env] ?? execSync(`command -v ${name}`).toString().trim();
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "as-trust-")));
const home = join(tmp, "as");
mkdirSync(home);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (what: string, ...rest: unknown[]) => console.log(what, ...rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))));

let port = 0;
const cfg = { home, targetsPath: resolve(here, "..", "config", "targets.yaml"), port: 0, opencodeBinary: "" } as unknown as DaemonConfig;
// As the service's own environment is: not a terminal's (this may be run from inside an AgentSwitch terminal).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(CLAUDE|CODEX|AGENTSWITCH_TERMINAL)/.test(k) && !/^(https?_proxy|all_proxy|no_proxy|ssl_cert_file|requests_ca_bundle|node_extra_ca_certs|secret_gate_home)$/i.test(k))) as NodeJS.ProcessEnv;
const launch = agentLauncher({ binaries: { "claude-code": bin("claude", "CLAUDE_BIN"), codex: bin("codex", "CODEX_BIN") } as never, hookUrl: () => `http://127.0.0.1:${port}`, stateDir: join(home, "terminals"), env });
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
/** The screen's rows as they are, blank ones too (the lists are read by where their rows stand), without the blank tail. */
const show = (lines: string[]) => { let end = lines.length; while (end > 0 && !lines[end - 1]!.trim()) end -= 1; for (const l of lines.slice(Math.max(0, end - 30), end)) console.log("     │" + l.trimEnd().slice(0, 150)); };
const brief = (t: Record<string, any>) => ({ status: t.status, attention: t.attention ?? null, session: t.agentSessionId ?? t.sessionId ?? null, choices: t.choices ?? null, prompt: t.prompt ?? null });

for (const harness of (process.env.PROBE_AGENTS ?? "claude-code,codex").split(",")) {
  const cwd = join(tmp, `w-${harness}`);
  mkdirSync(cwd);
  writeFileSync(join(cwd, "notes.md"), "# notes\n");
  // Codex asks only about a folder under version control (a plain folder it opens without asking).
  if (process.env.PROBE_GIT !== "0") execSync("git init -q", { cwd });
  let id = "";
  try {
    say(`\n== ${harness} in a folder it has not seen (${cwd})`);
    const started = await call("POST", "/terminals", { harness, cwd, mode: "manual" });
    if (started.status >= 300) throw new Error(`could not start: ${started.status} ${JSON.stringify(started.json)}`);
    id = started.json.terminal.id as string;
    const scr = follow(id), rec = follow(id, "?view=record");
    for (const at of [1500, 4000, 8000]) {
      await sleep(at === 1500 ? 1500 : at === 4000 ? 2500 : 4000);
      say(`-- ${at / 1000}s: the terminal's entry:`, brief(await info(id)));
    }
    say("its screen:");
    show(scr.lines());
    say("what a screen showing the record was told:");
    for (const e of rec.events) console.log("   " + e.event.padEnd(10) + JSON.stringify(e.data).slice(0, 400));
    const t = await info(id);
    say("the whole entry's keys:", Object.keys(t).sort().join(" "));
    if (process.env.PROBE_PICK === "no" && t.choices) {
      const pick = (t.choices.options as { label: string }[]).findIndex((o) => /^no\b|exit|quit/i.test(o.label));
      if (pick >= 0) {
        const res = await call("POST", `/terminals/${id}/choices`, { pick, label: t.choices.options[pick].label });
        await sleep(2500);
        say(`took "${t.choices.options[pick].label}":`, res.status, "· then:", brief(await info(id)));
        show(scr.lines().slice(-10));
      }
    }
    scr.stop(); rec.stop();
  } catch (err) {
    say("stopped:", (err as Error).message);
  } finally {
    if (id) await call("DELETE", `/terminals/${id}`).catch(() => undefined);
  }
}
await sleep(500);
server.close();
daemon.close();
rmSync(tmp, { recursive: true, force: true });
say("\ncleaned");
process.exit(0);
