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
 *    node hookClient.js codex '<json>'  Codex notify */

import { request } from "node:http";

const url = process.env.AGENTSWITCH_TERMINAL_URL;
const id = process.env.AGENTSWITCH_TERMINAL_ID;
const token = process.env.AGENTSWITCH_TERMINAL_HOOK_TOKEN;
/** Just under the longest hook timeout the service configures (the permission hook's). */
const WAIT_MS = Number(process.env.AGENTSWITCH_TERMINAL_HOOK_WAIT_MS ?? 29 * 60_000);

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
  const res = await post(`${url}/terminals/hook`, { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id }, JSON.stringify({ event, payload }));
  if (res.status < 200 || res.status >= 300) return "";
  const body = JSON.parse(res.text) as { output?: unknown };
  return body.output ? JSON.stringify(body.output) : "";
}

/** One POST to the service (plain HTTP on this Mac), waited for up to `WAIT_MS` and no less. */
function post(to: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(to, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString("utf8") }));
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("no answer in time")), WAIT_MS);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body);
  });
}

// A pipe write is asynchronous on macOS: exit only once the answer is out.
main().catch(() => "").then((out) => {
  if (out) process.stdout.write(out, () => process.exit(0));
  else process.exit(0);
});
