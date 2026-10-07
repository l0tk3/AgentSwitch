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

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
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
