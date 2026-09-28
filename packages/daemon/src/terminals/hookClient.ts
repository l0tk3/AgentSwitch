/** The hook command of AgentSwitch's terminals (docs/terminal-v0.md §3). The agent runs it with the hook payload on
 *  stdin (Claude Code) or as the last argument (Codex `notify`); it hands the payload to the service with the terminal's
 *  own hook token and prints the service's answer, if any, for the agent to read. It never fails the agent: any problem
 *  (service gone, timeout) prints nothing and exits 0, and the agent carries on as if there were no hook.
 *
 *  Runs as a plain script under the service's own node (no imports beyond node, erasable types only), so the same file
 *  works from dist/ and from src/ under node's type stripping.
 *
 *    node hookClient.js                 Claude Code: event name from the payload's hook_event_name
 *    node hookClient.js codex '<json>'  Codex notify */

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
  const res = await fetch(`${url}/terminals/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id },
    body: JSON.stringify({ event, payload }),
    signal: AbortSignal.timeout(WAIT_MS),
  });
  if (!res.ok) return "";
  const body = (await res.json()) as { output?: unknown };
  return body.output ? JSON.stringify(body.output) : "";
}

// A pipe write is asynchronous on macOS: exit only once the answer is out.
main().catch(() => "").then((out) => {
  if (out) process.stdout.write(out, () => process.exit(0));
  else process.exit(0);
});
