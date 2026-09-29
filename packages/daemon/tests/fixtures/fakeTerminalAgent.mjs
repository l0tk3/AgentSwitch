// A stand-in for an agent CLI in an AgentSwitch terminal (tests/terminals.test.ts): sets its title, answers each line,
// and on "perm" asks for a permission through the real hook command, the way Claude Code does, printing the answer.
import { spawn } from "node:child_process";

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

async function handle(line) {
  if (!line) return;
  if (line === "exit") process.exit(3);
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
  process.stdout.write(`got: ${line}\r\n`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.search(/[\r\n]/)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    void handle(line);
  }
});
