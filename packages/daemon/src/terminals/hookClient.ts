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
 *    node hookClient.js key             the key this terminal's profile pays by (docs/profiles-v0.md §3.6): Claude
 *                                       Code's `apiKeyHelper`, Codex's provider `auth` command. Printed alone on one
 *                                       line; without one it says why on stderr and fails, so the agent says it has
 *                                       no key instead of sending an empty one. */

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

if (process.argv[2] === "key") {
  key().then((value) => process.stdout.write(`${value}\n`, () => process.exit(0)),
    (err: Error) => process.stderr.write(`AgentSwitch: no API key for this terminal (${err.message})\n`, () => process.exit(1)));
}
// A pipe write is asynchronous on macOS: exit only once the answer is out.
else main().catch(() => "").then((out) => {
  if (out) process.stdout.write(out, () => process.exit(0));
  else process.exit(0);
});
