/** What Claude Code hands its status line, and whether AgentSwitch's own status line (terminals/meter.ts,
 *  hookClient.js `status`) tells the service the numbers while the user's own line is still drawn. This runs the real
 *  `claude` once in a throw-away folder — ONE SMALL REAL TURN on your account (Haiku) — with a status line of ours whose
 *  "own" line saves its input and prints `OWN-LINE` (OWN=hud: the user's own status line from their settings instead),
 *  and a stand-in service that collects what it is told.
 *
 *    npx tsx scripts/claude_statusline_probe.ts
 *
 *  Seen 2026-11-26 on 2.1.332: see docs/simple-view-v0.md §5.25.
 *
 *  Not a test: it uses the real model. The folder and the session it leaves are deleted at the end. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import headless from "@xterm/headless";
import * as pty from "node-pty";
import { hookCommandOf } from "../src/terminals/launch.js";
import { claudeMeter, claudeStatusLine, ownStatusLine } from "../src/terminals/meter.js";

const base = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".cache");
mkdirSync(base, { recursive: true });
const cwd = realpathSync(mkdtempSync(join(base, "as-status-")));
const cols = 120, rows = 34;
const term = new headless.Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });

const told: Record<string, unknown>[] = [];
const server = createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on("data", (c: Buffer) => parts.push(c));
  req.on("end", () => { const b = JSON.parse(Buffer.concat(parts).toString("utf8")); if (b.event === "ClaudeMeter") told.push(b.payload); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

// As a terminal of its own, not as a child of the session this may be run from; the account's own config folder kept.
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, TERM: "xterm-256color" })
  .filter(([k, v]) => v !== undefined && (k === "CLAUDE_CONFIG_DIR" || !/^CLAUDE(CODE|_CODE)?_|^CLAUDECODE$/.test(k)))) as Record<string, string>;
Object.assign(env, { AGENTSWITCH_TERMINAL_URL: `http://127.0.0.1:${port}`, AGENTSWITCH_TERMINAL_ID: "probe", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "probe" });
const dump = join(cwd, "said.json");
const own = process.env.OWN === "hud" ? ownStatusLine(cwd, env.CLAUDE_CONFIG_DIR) : { type: "command", command: `cat > ${JSON.stringify(dump)}; echo OWN-LINE` };
const statusLine = claudeStatusLine(hookCommandOf({}), join(cwd, "statusline.json"), own);
const settings = join(cwd, "settings.json");
writeFileSync(settings, JSON.stringify({ statusLine }));
const proc = pty.spawn("claude", ["--model", "haiku", "--settings", settings], { name: "xterm-256color", cols, rows, cwd, env });
proc.onData((d) => term.write(d));
term.onData((d) => proc.write(d));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const screen = (): string => {
  const b = term.buffer.active, out: string[] = [];
  for (let y = b.baseY; y < b.baseY + rows; y++) out.push(b.getLine(y)?.translateToString(true) ?? "");
  return out.join("\n");
};
const until = async (what: string, ok: () => boolean, ms: number) => {
  for (let t = 0; t < ms; t += 250) { if (ok()) return true; await sleep(250); }
  console.log(`(waited ${ms} ms for ${what})`);
  return false;
};

try {
  await until("its first screen", () => /trust|❯|>/.test(screen()), 20000);
  if (/trust this folder/i.test(screen())) { proc.write("\r"); await sleep(1500); }
  await until("its prompt", () => /❯/.test(screen()), 15000);
  await sleep(2500);
  console.log(`before the first turn: ${told.length} reading(s); last ${JSON.stringify(told.at(-1))}`);
  proc.write("Reply with the single word ok.");
  await sleep(400);
  proc.write("\r");
  let last = "", still = 0;
  for (let t = 0; t < 90000 && still < 6000; t += 500) { await sleep(500); const now = screen(); if (now === last) still += 500; else { still = 0; last = now; } }
  await sleep(2000);
  console.log("the last lines of its screen:");
  for (const l of screen().split("\n").filter((l) => l.trim()).slice(-8)) console.log(`  │${l}`);
  if (existsSync(dump)) {
    const said = JSON.parse(readFileSync(dump, "utf8")) as Record<string, unknown>;
    console.log(`its input's keys: ${Object.keys(said).join(", ")}`);
    console.log(`context_window: ${JSON.stringify(said.context_window)}`);
    console.log(`rate_limits: ${JSON.stringify(said.rate_limits)}`);
  }
  console.log(`readings told: ${told.length}; the last: ${JSON.stringify(told.at(-1))}`);
  if (told.length) console.log(`kept: ${JSON.stringify(claudeMeter(told.at(-1)!))}`);
} catch (error) {
  console.log(String(error));
} finally {
  proc.kill();
  server.close();
  await sleep(300);
  rmSync(cwd, { recursive: true, force: true });
  for (const root of [env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude")]) {
    const kept = root ? join(root, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")) : "";
    if (kept && existsSync(kept) && kept.includes("as-status-")) { rmSync(kept, { recursive: true, force: true }); console.log(`deleted its session: ${kept}`); }
  }
  process.exit(0);
}
