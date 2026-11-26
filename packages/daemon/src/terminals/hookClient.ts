/** The hook command of AgentSwitch's terminals (docs/terminal-v0.md §3). The agent runs it with the hook payload on
 *  stdin (Claude Code) or as the last argument (Codex `notify`); it hands the payload to the service with the terminal's
 *  own hook token and prints the service's answer, if any, for the agent to read. It never fails the agent: any problem
 *  (service gone, timeout) prints nothing and exits 0, and the agent carries on as if there were no hook.
 *
 *  Runs as a plain script under the service's own node (no imports beyond node, erasable types only), so the same file
 *  works from dist/ and from src/ under node's type stripping.
 *
 *  It waits as long as the service's longest hook does — a permission or a question may wait half an hour for a
 *  screen's answer — so it asks with node's plain HTTP request, which has no time limit of its own. Not `fetch`: node's
 *  gives up on a server that has sent no response headers after 300 seconds whatever its abort signal says
 *  (`UND_ERR_HEADERS_TIMEOUT`; measured 2026-10-08 on the service's node 24.21: 301 s). With `fetch` every card that
 *  waited five minutes was dropped — this program ended with no answer, the agent asked in its own terminal instead,
 *  and the service, seeing the call go, took the card off the screens (user: 有的时候cc的对话回复也是一会自己消失了，我回cli还在).
 *
 *    node hookClient.js                 Claude Code: event name from the payload's hook_event_name
 *    node hookClient.js codex '<json>'  Codex notify
 *    node hookClient.js agy             Antigravity CLI's status line (terminals/agy.ts): its state on stdin; what the
 *                                       service follows of it is handed on (never the account's e-mail, plan or
 *                                       quota), and the model's name is printed for the line under its input
 *    node hookClient.js status <file>   Claude Code's status line (terminals/meter.ts): its state on stdin; how full
 *                                       the context is and the 5-hour and 7-day allowances are handed on (nothing
 *                                       else of it), and the user's own status line (`command` in <file>) is run with
 *                                       the same input, what it prints printed; with none, nothing
 *    node hookClient.js key             the key this terminal's profile pays by (docs/profiles-v0.md §3.6): Claude
 *                                       Code's `apiKeyHelper`, Codex's provider `auth` command. Printed alone on one
 *                                       line; without one it says why on stderr and fails, so the agent says it has
 *                                       no key instead of sending an empty one.
 *    node hookClient.js wait            Claude Code, left running when a turn ends (`asyncRewake`, docs/chatroom-v0.md
 *                                       §12): waits until a Chat Room message is for this terminal's session, then
 *                                       says it on stderr and exits 2 — which wakes the agent with it. */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";

const url = process.env.AGENTSWITCH_TERMINAL_URL;
const id = process.env.AGENTSWITCH_TERMINAL_ID;
const token = process.env.AGENTSWITCH_TERMINAL_HOOK_TOKEN;
/** Just under the longest hook timeout the service configures (the permission hook's). */
const WAIT_MS = Number(process.env.AGENTSWITCH_TERMINAL_HOOK_WAIT_MS ?? 29 * 60_000);
/** A terminal held outside the service (docs/terminal-v0.md §10): its program outlives a restart, so there are moments
 *  with no service to answer. Then a tool call is refused rather than let through — the protected-path floor
 *  (`PreToolUse`) holds in every mode only while something answers for it — and the agent is told to try again. The
 *  same when the service answers that it does not know this terminal (a token no daemon took up). A terminal that
 *  ends with the service never sees either. */
const HELD = process.env.AGENTSWITCH_TERMINAL_HELD === "1";
const REFUSED_WHILE_AWAY = "AgentSwitch 的服务此刻没有应答，这次工具调用未放行；请稍后再试一次。";

/** What a tool call gets while the service is away, when the terminal is held: a refusal, else nothing. */
function whileAway(event: string): string {
  if (!HELD || event !== "PreToolUse") return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REFUSED_WHILE_AWAY } });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) parts.push(chunk as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

/** The answer to print, or "" for none. */
async function main(): Promise<string> {
  if (!url || !id || !token) return "";
  let event: string;
  let payload: Record<string, unknown>;
  if (process.argv[2] === "codex") {
    event = "CodexNotify";
    payload = JSON.parse(process.argv[3] ?? "{}") as Record<string, unknown>;
  } else {
    payload = JSON.parse((await readStdin()) || "{}") as Record<string, unknown>;
    event = String(payload.hook_event_name ?? "");
  }
  if (!event) return "";
  let res: { status: number; text: string };
  try { res = await post(`${url}/terminals/hook`, { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id }, JSON.stringify({ event, payload })); }
  catch (err) {
    // Not reached at all: the service is restarting (or gone). A card that waited its time out is not that: the agent
    // asks in its own terminal then, as before.
    if ((err as Error).message === NO_ANSWER_IN_TIME) return "";
    return whileAway(event);
  }
  if (res.status < 200 || res.status >= 300) return whileAway(event);
  const body = JSON.parse(res.text) as { output?: unknown };
  return body.output ? JSON.stringify(body.output) : "";
}

const NO_ANSWER_IN_TIME = "no answer in time";

/** One POST to the service (plain HTTP on this Mac), waited for up to `WAIT_MS` and no less. */
function post(to: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(to, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString("utf8") }));
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error(NO_ANSWER_IN_TIME)), WAIT_MS);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body);
  });
}

/** The key, asked of the service with this terminal's hook token; it waits a short while only. */
async function key(): Promise<string> {
  if (!url || !id || !token) throw new Error("not in an AgentSwitch terminal");
  const res = await Promise.race([
    post(`${url}/terminals/key`, { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id }, "{}"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the service did not answer")), 20_000).unref()),
  ]);
  const body = JSON.parse(res.text || "{}") as { key?: unknown; error?: unknown };
  if (res.status !== 200 || typeof body.key !== "string" || !body.key) throw new Error(typeof body.error === "string" ? body.error : `the service answered ${res.status}`);
  return body.key;
}

/** Waits for a room message for this terminal; the text to wake the agent with, or "" when there is nothing to wait
 *  for any more (another program waits in this one's place, the terminal is gone, the service stayed away). */
async function mail(): Promise<string> {
  if (!url || !id || !token) return "";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let away = 0; away < 60;) {
    let res: { status: number; text: string };
    try { res = await post(`${url}/terminals/room`, { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id }, JSON.stringify({ op: "wait" })); }
    catch { away += 1; await sleep(4000); continue; }   // the service is restarting: asked again for a few minutes
    if (res.status !== 200) return "";
    away = 0;
    const body = JSON.parse(res.text || "{}") as { text?: unknown; again?: unknown };
    if (typeof body.text === "string" && body.text) return body.text;
    if (body.again !== true) return "";
  }
  return "";
}

/** Antigravity's status line: the line to show is printed at once (it waits for it), then the service is told. Of
 *  what the program says only this is passed on: its state, whether it waits for an answer, the conversation's id and
 *  title, the folder, how it asks, the model's name, and how full its context and its allowances are. */
const AGY_WAIT_MS = 4000;
async function agy(): Promise<string> {
  const said = JSON.parse((await readStdin()) || "{}") as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const model = said.model && typeof said.model === "object" ? said.model as Record<string, unknown> : {};
  const workspace = said.workspace && typeof said.workspace === "object" ? said.workspace as Record<string, unknown> : {};
  const name = text(model.display_name) || text(model.id);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const cw = said.context_window && typeof said.context_window === "object" ? said.context_window as Record<string, unknown> : {};
  const quota = said.quota && typeof said.quota === "object" ? said.quota as Record<string, unknown> : {};
  const line = name.slice(0, 80);
  if (!url || !id || !token) return line;
  const payload: Record<string, unknown> = {
    at: Date.now(), agent_state: text(said.agent_state), tool_confirmation_pending: said.tool_confirmation_pending === true,
    session_id: text(said.conversation_id) || text(said.session_id), conversation_title: text(said.conversation_title).slice(0, 300),
    cwd: text(workspace.current_dir) || text(said.cwd), model: name.slice(0, 200),
    // How full its context and its allowances are (meter.ts `agyMeter`): the numbers only.
    context: { used_percentage: num(cw.used_percentage), size: num(cw.context_window_size), used: num(cw.total_input_tokens) },
    quota: Object.fromEntries(Object.entries(quota).slice(0, 12).map(([k, v]) => {
      const q = v && typeof v === "object" ? v as Record<string, unknown> : {};
      return [k.slice(0, 40), { remaining_fraction: num(q.remaining_fraction), reset_time: text(q.reset_time).slice(0, 40) }];
    })),
    // Said only while it is in a mode other than asking each time.
    ...(typeof said.cycle_mode === "string" ? { cycle_mode: said.cycle_mode.slice(0, 40) } : {}),
  };
  await Promise.race([
    post(`${url}/terminals/hook`, { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id }, JSON.stringify({ event: "AgyStatus", payload })).catch(() => null),
    new Promise((r) => setTimeout(r, AGY_WAIT_MS).unref()),
  ]);
  return line;
}

/** Claude Code's status line: the user's own runs with the same input while the service is told the numbers. The
 *  line is printed as the user's printed it (colours, several lines); the service is waited for a moment at most. */
const OWN_LINE_MS = 10_000;
const METER_WAIT_MS = 2000;
async function status(file: string): Promise<string> {
  const input = await readStdin();
  let said: Record<string, unknown> = {};
  try { said = JSON.parse(input || "{}") as Record<string, unknown>; } catch { /* the user's own line still gets it */ }
  let command = "";
  try { const own = JSON.parse(readFileSync(file, "utf8")) as { command?: unknown }; if (typeof own.command === "string") command = own.command; } catch { /* none */ }
  const told = url && id && token
    ? Promise.race([
      post(`${url}/terminals/hook`, { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id }, JSON.stringify({ event: "ClaudeMeter", payload: meterOf(said) })).catch(() => null),
      new Promise((r) => setTimeout(r, METER_WAIT_MS).unref()),
    ])
    : null;
  const [line] = await Promise.all([command ? ownLine(command, input) : "", told]);
  return line;
}

/** Of the status line's input only these cross: the context's size and fill, the two allowances' fill and reset. */
function meterOf(said: Record<string, unknown>): Record<string, unknown> {
  const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const cw = o(said.context_window), cu = o(cw.current_usage), rl = o(said.rate_limits);
  const used = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((a, k) => a + (n(cu[k]) ?? 0), 0);
  const limit = (v: unknown) => { const l = o(v); return { used_percentage: n(l.used_percentage), resets_at: n(l.resets_at) ?? (typeof l.resets_at === "string" ? l.resets_at.slice(0, 40) : null) }; };
  return {
    at: Date.now(),
    context: { used_percentage: n(cw.used_percentage), size: n(cw.context_window_size), used: used || null },
    ...(said.rate_limits !== undefined ? { five_hour: limit(rl.five_hour), seven_day: limit(rl.seven_day) } : {}),
  };
}

/** The user's own status line, run as Claude Code runs it (a shell, the same folder and environment, the input on
 *  stdin); what it printed in its time. */
function ownLine(command: string, input: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "ignore"] });
    const parts: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), OWN_LINE_MS);
    child.stdout.on("data", (c: Buffer) => parts.push(c));
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(parts).toString("utf8")); });
    child.stdin.on("error", () => { /* it did not read its input */ });
    child.stdin.end(input);
  });
}

if (process.argv[2] === "status") {
  status(process.argv[3] ?? "").catch(() => "").then((out) => {
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
}
else if (process.argv[2] === "agy") {
  agy().catch(() => "").then((out) => {
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
}
else if (process.argv[2] === "wait") {
  mail().catch(() => "").then((text) => {
    if (text) process.stderr.write(`${text}\n`, () => process.exit(2));
    else process.exit(0);
  });
}
else if (process.argv[2] === "key") {
  key().then((value) => process.stdout.write(`${value}\n`, () => process.exit(0)),
    (err: Error) => process.stderr.write(`AgentSwitch: no API key for this terminal (${err.message})\n`, () => process.exit(1)));
}
// A pipe write is asynchronous on macOS: exit only once the answer is out.
else main().catch(() => "").then((out) => {
  if (out) process.stdout.write(out, () => process.exit(0));
  else process.exit(0);
});
