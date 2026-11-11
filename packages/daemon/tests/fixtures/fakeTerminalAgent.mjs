// A stand-in for an agent CLI in an AgentSwitch terminal (tests/terminals.test.ts): sets its title, answers each line,
// and on "perm" asks for a permission through the real hook command, the way Claude Code does, printing the answer.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.stdout.write("\x1b]0;fake agent\x07fake agent ready\r\n");

function hook(payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.env.FAKE_HOOK_SCRIPT], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(out));
    child.stdin.end(JSON.stringify(payload));
  });
}

let blink = null;
let daybreak = false;

async function handle(line) {
  if (!line) return;
  if (line === "exit") process.exit(3);
  // The turn ends, as Claude Code says it (its Stop hook): the terminal rests.
  if (line === "stop") { await hook({ hook_event_name: "Stop" }); process.stdout.write("stopped\r\n"); return; }
  // Keys one at a time, as a full-screen program takes them (a key that ends no line — ⇧Tab — arrives at once).
  if (line === "raw") { process.stdin.setRawMode?.(true); process.stdout.write("raw on\r\n"); return; }
  // A full-screen program with the mouse on, as Claude Code's current screen is; "normal" goes back.
  if (line === "fullscreen") { process.stdout.write("\x1b[?1049h\x1b[?1003h\x1b[?1006hfullscreen on\r\n"); return; }
  if (line === "kitty") { process.stdout.write("\x1b[?u\x1b[>7ukitty on\r\n"); return; }
  if (line === "nokitty") { process.stdout.write("\x1b[<ukitty off\r\n"); return; }
  if (line === "normal") { process.stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1049lnormal again\r\n"); return; }
  if (line === "perm") {
    await hook({ hook_event_name: "SessionStart", session_id: "11111111-2222-3333-4444-555555555555" });
    const out = await hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build" } });
    process.stdout.write(`answer: ${out || "(none)"}\r\n`);
    return;
  }
  // Claude Code's AskUserQuestion: a PermissionRequest too (2.1.286); the answers come back in updatedInput.
  if (line === "ask") {
    const out = await hook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: [
      { question: "日期格式化用哪个库？", header: "Library", multiSelect: false, options: [{ label: "date-fns", description: "体积小" }, { label: "Luxon", description: "自带时区" }] },
      { question: "发布前跑哪些检查？", header: "Checks", multiSelect: true, options: [{ label: "单元测试", description: "" }, { label: "类型检查", description: "" }] },
    ] } });
    process.stdout.write(`answer: ${out || "(none)"}\r\n`);
    return;
  }
  // Claude Code's `/model <name>`: asks first unless the hook lets it through, then says which model it is on.
  if (line.startsWith("/model ")) {
    const to = line.slice(7).trim();
    const out = await hook({ hook_event_name: "PreModelSwitch", from_model: "claude-opus-5-5", to_model: to });
    const allowed = /"permissionDecision":"allow"/.test(out ?? "");
    process.stdout.write(allowed ? `model set: ${to}\r\n` : `confirm switch to ${to}?\r\n`);
    if (allowed) await hook({ hook_event_name: "PostModelSwitch", from_model: "claude-opus-5-5", to_model: to });
    return;
  }
  // A turn that uses a tool: what the screens that show the record are told it is doing.
  if (line === "tool") {
    await hook({ hook_event_name: "UserPromptSubmit" });
    await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
    process.stdout.write("tool used\r\n");
    return;
  }
  // Busy a while, as an agent at work: a spinner frame every 150 ms for 1.2 s.
  if (line === "work") {
    for (let i = 0; i < 8; i++) { process.stdout.write(`\rworking ${"|/-\\"[i % 4]}`); await new Promise((r) => setTimeout(r, 150)); }
    process.stdout.write("\r\nwork done\r\n");
    return;
  }
  // Codex when its screen waits for you (an app's form, an approval): its notification (OSC 9), the title marker
  // blinking, and redraws while it waits; "answered" ends it.
  if (line === "form") {
    process.stdout.write("\x1b]9;Approval requested: Computer Use\x07\x1b]0;[ ! ] Action Required | 查看进程 | Codex\x07Allow Computer Use?\r\n");
    let n = 0;
    blink = setInterval(() => process.stdout.write(`\x1b]0;[ ${n++ % 2 ? "!" : "."} ] Action Required | 查看进程 | Codex\x07\r> 1. Allow`), 60);
    return;
  }
  if (line === "answered") { clearInterval(blink); process.stdout.write("\x1b]0;查看进程 | Codex\x07\r\nallowed\r\n"); return; }
  // Codex's Daybreak switch: its command flips it and says how it stands, as its TUI does.
  // (`FAKE_DAYBREAK_FILE`: where it also keeps the choice, as the TUI saves it on its server.)
  if (line === "/daybreak") {
    daybreak = !daybreak;
    if (process.env.FAKE_DAYBREAK_FILE) writeFileSync(process.env.FAKE_DAYBREAK_FILE, daybreak ? "on" : "off");
    process.stdout.write(`• Daybreak ${daybreak ? "on" : "off"}. Applies to new turns.\r\n`);
    return;
  }
  // A list of its own to choose from (Codex's `/model`): numbered rows, the selection's mark on one; the keys it gets
  // while the list is up move the mark and enter it.
  if (line === "menu") { menu = 0; drawMenu(); return; }
  // Claude Code's question about a folder it has not seen (2.1.299): rows without numbers, the mark on "No".
  if (line === "trust") { trust = 0; drawTrust(); return; }
  // Its service not reached: it says it tries again, counts, then the line is gone (`retry`).
  if (line === "retry") { process.stdout.write("\x1b[2J\x1b[H✻ Working…\r\n  ⎿  API Error (Connection error.) · Retrying in 5 seconds… (attempt 2/10)\r\n"); return; }
  if (line === "retry3") { process.stdout.write("\x1b[2J\x1b[H✻ Working…\r\n  ⎿  API Error (Connection error.) · Retrying in 9 seconds… (attempt 3/10)\r\n"); return; }
  if (line === "reached") { process.stdout.write("\x1b[2J\x1b[H✻ Working…\r\n"); return; }
  // Any agent: its window's title set to what follows (Grok says in its title what it does and that it waits).
  if (line.startsWith("title ")) { process.stdout.write(`\x1b]0;${line.slice(6)}\x07titled\r\n`); return; }
  // Grok's question before a tool (1.0.77): numbered rows with a round mark, the filled one where the selection is.
  if (line === "grokperm") { perm = 2; drawPerm(); return; }
  // Grok's question about a folder it does not trust: two rows, each taken by the key at its end; Enter takes the first.
  if (line === "groktrust") { folder = true; drawFolder(); return; }
  // Claude Code while it works: its line with a clock and the tokens so far, on a row it redraws (`working 1.3k`).
  if (line.startsWith("working ")) { process.stdout.write(`\r\x1b[2K✻ Pondering… (12s · ↓ ${line.slice(8)} tokens · thought for 2s)`); return; }
  // Claude Code while it compacts its context: its own line with a clock, on a row it redraws; gone when done.
  if (line === "compacting") { process.stdout.write("\r\x1b[2K✻ Compacting conversation… (1s)"); return; }
  // (What was typed to say so was echoed onto that row: it is the one above by now.)
  if (line === "compacted") { process.stdout.write("\x1b[1A\r\x1b[2K  ⎿  Compacted (ctrl+o to see full summary)\r\n"); return; }
  // Claude Code's input line as it rests: empty, with dim words it offers as the next message, or with typing in it.
  if (line.startsWith("suggest ")) { process.stdout.write(`❯ \x1b[2m${line.slice(8)}\x1b[22m\r\n`); return; }
  if (line.startsWith("typed ")) { process.stdout.write(`❯ ${line.slice(6)}\r\n`); return; }
  process.stdout.write(`got: ${line}\r\n`);
}

// Claude Code's ⇧Tab: the next permission mode, named on a line of its own as its screen names it. `FAKE_MODES` is
// the round this session offers (one started without skipping permissions has no bypass in it).
const FOOT = { default: "? for shortcuts", acceptEdits: "⏵⏵ accept edits on (shift+tab to cycle)", plan: "⏸ plan mode on (shift+tab to cycle)",
  auto: "⏵⏵ auto mode on (shift+tab to cycle)", bypassPermissions: "⏵⏵ bypass permissions on (shift+tab to cycle)" };
const round = (process.env.FAKE_MODES ?? "default,acceptEdits,plan").split(",");
let mode = 0;

// The list to choose from (`menu`): where its mark stands, or null when none is up.
let menu = null;
const MENU = ["gpt-6-sol (current)   Frontier model", "gpt-6-luna            Fast and light", "gpt-5.6-codex         Older"];
function drawMenu() {
  process.stdout.write("\r\n  Select Model and Effort\r\n" + MENU.map((row, i) => `${i === menu ? "› " : "  "}${i + 1}. ${row}`).join("\r\n") + "\r\n  Press enter to confirm or esc to go back\r\n");
}
// The folder question (`trust`): where its mark stands, or null when it is not up.
let trust = null;
const TRUST = ["No, exit", "Yes, I trust this folder"];
function drawTrust() {
  process.stdout.write("\x1b[2J\x1b[H" + "─".repeat(60) + "\r\n Accessing workspace:\r\n\r\n /tmp/somewhere\r\n\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n Security guide\r\n\r\n"
    + TRUST.map((row, i) => ` ${i === trust ? "❯" : " "} ${row}`).join("\r\n") + "\r\n\r\n Enter to confirm · Esc to cancel\r\n");
}
// Grok's question before a tool (`grokperm`): where its mark stands, or null when it is not up.
let perm = null;
const PERM = ["Yes, and don't ask again for anything (always-approve mode)", "Always allow: rm probe-file.txt", "Yes, proceed", "No, reject (type to add feedback)", "Never allow: rm probe-file.txt"];
function drawPerm() {
  process.stdout.write("\x1b[2J\x1b[H   ◆ Remove probe-file.txt as requested… 1.5s\r\n  ┃\r\n  ┃  ›  Remove probe-file.txt as requested\r\n  ┃  │ rm probe-file.txt\r\n  ┃  ← → narrow scope  ·  e edit pattern\r\n  ┃\r\n"
    + PERM.map((row, i) => `  ┃  ${i + 1} (${i === perm ? "●" : "○"}) ${row}`).join("\r\n") + "\r\n  ┃\r\n  1/5:select  │  Tab:next option  │  ←/→:scope  │  e:edit pattern  │  Ctrl+o:always-approve  │  Ctrl+c:cancel\r\n");
}
// Grok's folder question (`groktrust`): up or not.
let folder = false;
function drawFolder() {
  const mid = (s) => " ".repeat(Math.max(0, Math.floor((100 - s.length) / 2))) + s;
  process.stdout.write("\x1b[2J\x1b[H\r\n" + mid("⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀") + "\r\n" + mid("⠀⠀⣿⡇⠀⠀⠀⠔⠁⠀⠀⣿⡇⠀") + "\r\n\r\n\r\n" + mid("Do you trust the contents of this directory?") + "\r\n" + mid("/tmp/somewhere") + "\r\n\r\n"
    + mid("Grok Build may run or modify contents in this directory,") + "\r\n" + mid("posing security risks.") + "\r\n\r\n"
    + " ".repeat(40) + "Yes, proceed                 y\r\n" + " ".repeat(40) + "No, quit                     n\r\n\r\n\r\n" + " ".repeat(80) + "Grok Build  1.0.77\r\n");
}
// Its own list of commands (`FAKE_SLASH=1`): `/` typed into the empty input pops it up, three rows at a time; the
// arrow keys walk it, a backspace takes the `/` out.
const SLASH = [["model", "choose what model and reasoning effort to use"], ["daybreak", "turn Daybreak on or off"], ["new", "start a new chat"], ["compact", "summarize the conversation"],
  ["status", "show current session configuration"], ["diff", "show git diff"], ["quit", "exit Codex"]];
let slash = null;
function drawSlash() {
  const top = Math.min(Math.max(0, slash - 1), SLASH.length - 3);
  process.stdout.write("\x1b[2J\x1b[H" + SLASH.slice(top, top + 3).map(([n, d], i) => `${top + i === slash ? "› " : "  "}/${n.padEnd(10)}  ${d}`).join("\r\n") + "\r\n\r\n› /\r\n");
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  if (process.env.FAKE_SLASH && slash === null && String(d) === "/" && !buf) { slash = 0; drawSlash(); return; }
  if (slash !== null) {
    for (const key of String(d).match(/\x1b[\[O][AB]|\x7f/g) ?? []) {
      if (slash === null) break;
      if (key === "\x7f") { slash = null; process.stdout.write("\x1b[2J\x1b[H› \x1b[2mAsk anything\x1b[22m\r\n"); }
      else { slash = (slash + (key.endsWith("B") ? 1 : SLASH.length - 1)) % SLASH.length; drawSlash(); }
    }
    return;
  }
  if (folder) {
    // A key takes a row; Enter the first; anything else it does not hear.
    for (const key of String(d)) {
      if (key !== "y" && key !== "n" && key !== "\r" && key !== "\n") continue;
      folder = false;
      process.stdout.write(`\x1b[2J\x1b[Hfolder: ${key === "n" ? "No, quit" : "Yes, proceed"}\r\n`);
      break;
    }
    return;
  }
  if (perm !== null) {
    // The arrow keys move the mark and Enter takes the row; a row's number takes it at once.
    for (const key of String(d).match(/\x1b[\[O][AB]|\r|\n|[1-5]/g) ?? []) {
      if (perm === null) break;
      if (/[1-5]/.test(key)) perm = Number(key) - 1;
      if (key === "\r" || key === "\n" || /[1-5]/.test(key)) { process.stdout.write(`\x1b[2J\x1b[Hpermission: ${PERM[perm]}\r\n`); perm = null; }
      else { perm = Math.max(0, Math.min(PERM.length - 1, perm + (key.endsWith("B") ? 1 : -1))); drawPerm(); }
    }
    return;
  }
  if (trust !== null) {
    for (const key of String(d).match(/\x1b[\[O][AB]|\r|\n/g) ?? []) {
      if (trust === null) break;
      if (key === "\r" || key === "\n") { process.stdout.write(`\x1b[2J\x1b[Hfolder: ${TRUST[trust]}\r\n`); trust = null; }
      else { trust = Math.max(0, Math.min(TRUST.length - 1, trust + (key.endsWith("B") ? 1 : -1))); drawTrust(); }
    }
    return;
  }
  if (menu !== null) {
    // Arrow keys move the mark (either cursor-key mode); enter takes the row and the list is gone.
    for (const key of String(d).match(/\x1b[\[O][AB]|\r|\n/g) ?? []) {
      if (menu === null) break;
      if (key === "\r" || key === "\n") { process.stdout.write(`\x1b[2J\x1b[H• Model changed to ${MENU[menu].split(" ")[0]}\r\n`); menu = null; }
      else { menu = Math.max(0, Math.min(MENU.length - 1, menu + (key.endsWith("B") ? 1 : -1))); process.stdout.write("\x1b[2J\x1b[H"); drawMenu(); }
    }
    return;
  }
  if (String(d).includes("\x1b[Z") && process.env.FAKE_MODES !== "none") {
    for (const _ of String(d).split("\x1b[Z").slice(1)) { mode = (mode + 1) % round.length; process.stdout.write(`${FOOT[round[mode]]}\r\n`); }
    d = String(d).split("\x1b[Z").join("");
    if (!d) return;
  }
  buf += d;
  let i;
  while ((i = buf.search(/[\r\n]/)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    void handle(line);
  }
});
