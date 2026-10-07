/** What Claude Code's prompt suggestion looks like on its screen (docs/simple-view-v0.md §5.6). It is kept nowhere
 *  else: not in the session file, not in a hook. This runs the real `claude` once in a throw-away folder — ONE SMALL
 *  REAL TURN on your account (Haiku) — and prints the last lines of its screen once the turn has ended, the dim cells
 *  marked ⟦so⟧, so the reader in src/terminals/host.ts can be checked against the real thing.
 *
 *    npx tsx scripts/claude_suggestion_probe.ts
 *    FOCUS=in|out …   # telling it first that the terminal has, or has lost, the focus
 *    FORCE=1 …        # CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1, where the account has them off
 *
 *  It asks twice: no suggestion comes before the second answer. Seen 2026-10-07 on 2.1.292: `❯ ⟦add both⟧` — also with
 *  FOCUS=out (typing to it counts as having the focus), and without FORCE on this account.
 *
 *  Not a test: it uses the real model. The folder and the session it leaves are deleted at the end. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import headless from "@xterm/headless";
import * as pty from "node-pty";
import { modeOnScreen, screenRows, suggestionOnScreen } from "../src/terminals/host.js";

// Under this repository (in a folder git ignores): a folder Claude Code already trusts, so it asks nothing and
// nothing is added to its list of trusted folders.
const base = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".cache");
mkdirSync(base, { recursive: true });
const cwd = realpathSync(mkdtempSync(join(base, "as-suggest-")));
writeFileSync(join(cwd, "notes.md"), "# notes\n\n- buy milk\n- call the plumber\n");
const cols = 110, rows = 34;
const term = new headless.Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
// As a terminal of its own, not as a child of the session this may be run from.
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, TERM: "xterm-256color" })
  .filter(([k, v]) => v !== undefined && !/^CLAUDE(CODE|_CODE)?_|^CLAUDECODE$/.test(k))) as Record<string, string>;
if (process.env.FORCE) env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "1";
const proc = pty.spawn("claude", ["--model", "haiku"], { name: "xterm-256color", cols, rows, cwd, env });
proc.onData((d) => term.write(d));
term.onData((d) => proc.write(d));   // its answers to what the program asks of a terminal

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines = (marked = false): string[] => {
  const b = term.buffer.active, out: string[] = [];
  for (let y = b.baseY; y < b.baseY + rows; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    let text = "", dim = false;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      const d = !!cell.isDim();
      if (marked && d !== dim) { text += d ? "⟦" : "⟧"; dim = d; }
      text += cell.getChars() || " ";
    }
    if (marked && dim) text += "⟧";
    out.push(text.replace(/\s+$/, ""));
  }
  return out;
};
const screen = () => lines().join("\n");
const until = async (what: string, ok: () => boolean, ms: number) => {
  for (let t = 0; t < ms; t += 250) { if (ok()) return true; await sleep(250); }
  console.log(`(waited ${ms} ms for ${what})`);
  return false;
};

try {
  await until("its first screen", () => /trust|❯|>/.test(screen()), 20000);
  if (/trust this folder/i.test(screen())) throw new Error("it asks whether to trust the folder: run this from a checkout Claude Code already trusts");
  await until("its prompt", () => /❯|\? for shortcuts/.test(screen()), 15000);
  if (process.env.FOCUS === "in") proc.write("\x1b[I");
  if (process.env.FOCUS === "out") proc.write("\x1b[O");
  await sleep(500);
  proc.write(process.env.ASK ?? "Read notes.md. Propose one more item for the list in a sentence, and ask me whether to add it. Do not edit anything yet.");
  await sleep(400);
  proc.write("\r");
  // The turn has ended once its screen has stopped changing for a while.
  const settle = async () => {
    let last = "", still = 0;
    for (let t = 0; t < 90000 && still < 8000; t += 500) { await sleep(500); const now = screen(); if (now === last) still += 500; else { still = 0; last = now; } }
  };
  await settle();
  // It gives no suggestion before its second answer (read from the program: `early_conversation`).
  proc.write(process.env.ASK2 ?? "Good. Now propose a second one the same way, and ask me again.");
  await sleep(400);
  proc.write("\r");
  await settle();
  // A suggestion comes a moment after the turn ends, when it comes.
  await sleep(Number(process.env.WAIT ?? 12000));
  console.log(`focus ${process.env.FOCUS ?? "not said"} · forced ${process.env.FORCE ? "yes" : "no"} · the last lines of its screen, dim cells ⟦marked⟧:`);
  for (const l of lines(true).filter((l) => l.trim()).slice(-14)) console.log(`  │${l}`);
  // What the service's own readers make of this screen.
  const read = screenRows(term);
  console.log(`the service reads: suggestion ${JSON.stringify(suggestionOnScreen(read))} · mode ${modeOnScreen(read.map((r) => r.text))} · asked for focus reports ${term.modes.sendFocusMode}`);
} catch (error) {
  console.log(String(error));
} finally {
  proc.kill();
  await sleep(300);
  rmSync(cwd, { recursive: true, force: true });
  const kept = join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (existsSync(kept) && kept.includes("as-suggest-")) rmSync(kept, { recursive: true, force: true });
  process.exit(0);
}
