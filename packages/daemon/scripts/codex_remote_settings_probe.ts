/** Codex's model and reasoning effort changed from outside its TUI (docs/simple-view-v0.md §5.4). Codex has no command
 *  that sets them (`/model` opens two lists), but its app-server has `thread/settings/update`, and its TUI can be
 *  attached to an app-server of ours (`--remote`). This starts the real `codex app-server` on a loopback WebSocket,
 *  attaches the real TUI, and as a second client lists the models, finds the thread the TUI is on and changes its
 *  model and effort — then prints the TUI's footer, which follows.
 *
 *    npx tsx scripts/codex_remote_settings_probe.ts
 *
 *  A throw-away CODEX_HOME with a made-up key, in a folder git ignores: no account of yours is read, nothing is sent
 *  to a model, and everything it starts is stopped and removed at the end. Seen 2026-10-07 on 0.160–0.162: the footer
 *  went from "GPT-6.1-Sol default" to "GPT-6-Astra high". Not a test: it runs the real program. */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import headless from "@xterm/headless";
import * as pty from "node-pty";

const CODEX = process.env.CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const base = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".cache");
mkdirSync(base, { recursive: true });
const tmp = realpathSync(mkdtempSync(join(base, "as-codex-remote-")));
const home = join(tmp, "h"), cwd = join(tmp, "w");
mkdirSync(home); mkdirSync(cwd);
writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-made-up-for-a-protocol-check" }));
const env = Object.fromEntries(Object.entries({ ...process.env, TERM: "xterm-256color", CODEX_HOME: home })
  .filter(([k, v]) => v !== undefined && !/^(CLAUDE|OPENAI|CODEX_(?!HOME))/.test(k))) as Record<string, string>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (v: unknown, n = 420) => JSON.stringify(v)?.slice(0, n);
const port = await new Promise<number>((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => done(p)); }); });
const url = `ws://127.0.0.1:${port}`;
const server = spawn(CODEX, ["app-server", "--listen", url], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; server.stdout!.on("data", (d) => { log += String(d); }); server.stderr!.on("data", (d) => { log += String(d); });
let tui: pty.IPty | null = null, ws: WebSocket | null = null;
try {
  await sleep(2500);
  console.log("app-server said:", short(log.trim().split("\n").slice(-3).join(" | "), 300), "alive:", server.exitCode === null);
  const cols = 110, rows = 36;
  const term = new headless.Terminal({ cols, rows, allowProposedApi: true });
  tui = pty.spawn(CODEX, ["--remote", url], { name: "xterm-256color", cols, rows, cwd, env });
  const shown = tui;
  shown.onData((d: string) => term.write(d));
  term.onData((d: string) => shown.write(d));
  const lines = (): string[] => { const b = term.buffer.active, out: string[] = []; for (let y = b.baseY; y < b.baseY + rows; y++) out.push(b.getLine(y)?.translateToString(true) ?? ""); return out; };
  const foot = () => lines().filter((l) => l.trim() && !/[⣀-⣿]/.test(l)).slice(-3).map((l) => l.trim().slice(0, 100));
  await sleep(4000);
  if (/Trust this folder\?/.test(lines().join("\n"))) { shown.write("\r"); await sleep(4000); }   // kept in the throw-away home
  console.log("TUI foot:", short(foot(), 400));
  // A second client on the same server.
  const socket = new WebSocket(url);   // Node's own client
  ws = socket;
  await new Promise<void>((ok, fail) => { socket.addEventListener("open", () => ok(), { once: true }); socket.addEventListener("error", () => fail(new Error("no connection")), { once: true }); });
  const waiting = new Map<number, (m: any) => void>(); let id = 0; const notes: any[] = [];
  socket.addEventListener("message", (ev) => { let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; } if (m.id !== undefined && !m.method) waiting.get(m.id)?.(m); else notes.push(m); });
  const call = (method: string, params: unknown, ms = 8000) => new Promise<any>((done) => {
    const n = ++id; const t = setTimeout(() => done({ timeout: true }), ms);
    waiting.set(n, (m) => { clearTimeout(t); done(m.result ?? { error: m.error }); });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
  });
  console.log("initialize:", short(await call("initialize", { clientInfo: { name: "agentswitch-probe", version: "0" }, capabilities: { experimentalApi: true } }), 160));
  socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
  const models = await call("model/list", {});
  console.log("model/list:", short((models.data ?? []).slice(0, 5).map((m: any) => `${m.model ?? m.id}${m.isDefault ? "*" : ""} [${(m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort).join(",")}]`), 500), models.error ? short(models.error, 200) : "");
  // The TUI makes its thread a moment after it shows its prompt.
  let loaded = await call("thread/loaded/list", {});
  for (let t = 0; t < 20000 && !(loaded.data ?? []).length; t += 1000) { await sleep(1000); loaded = await call("thread/loaded/list", {}); }
  console.log("thread/loaded/list:", short(loaded, 240), "| TUI foot:", short(foot(), 300));
  const thread = (loaded.data ?? [])[0];
  if (thread) {
    const first = (models.data ?? []).find((m: any) => !m.isDefault && !m.hidden);
    const want = { threadId: thread, ...(first ? { model: first.model ?? first.id } : {}), effort: "high" };
    console.log("thread/settings/update →", short(want), "⇒", short(await call("thread/settings/update", want), 400));
    await sleep(1500);
    console.log("notified:", short(notes.filter((n) => /settings/.test(n.method ?? "")).map((n) => ({ method: n.method, model: n.params?.threadSettings?.model, effort: n.params?.threadSettings?.effort })), 300), "others:", short([...new Set(notes.map((n) => n.method))].slice(0, 8)));
    console.log("TUI foot after:", short(foot(), 400));
  } else console.log("no thread is loaded yet; notifications:", short([...new Set(notes.map((n) => n.method))].slice(0, 8)));
} catch (e) {
  console.log("failed:", String(e), "| app-server said:", short(log.trim().split("\n").slice(-2).join(" | "), 300));
} finally {
  try { ws?.close(); } catch { /* gone */ }
  tui?.kill();
  server.kill("SIGKILL");
  await sleep(500);
  try { execSync(`pkill -9 -f ${JSON.stringify(tmp)} || true`); } catch { /* none */ }
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
  console.log("cleaned:", !existsSync(tmp));
  process.exit(0);
}
