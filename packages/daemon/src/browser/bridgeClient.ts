/** The agent's end of the shared browser (docs/browser-v0.md §2 给 agent): an MCP server on stdio that carries every
 *  message to the daemon and back. The agent's browser tool is `secret-gate browser -- <this>`: the gate sits in front,
 *  this is its downstream, and Playwright MCP runs in the daemon on the agent's own tabs (agents.ts, agentMcp.ts).
 *
 *    node bridgeClient.js --url http://127.0.0.1:4711 --session <id> --token-file <file>
 *    agentswitch browser-mcp --session <id> --token-file <file>          (the same, through the CLI)
 *
 *  The session's token is read from its file (or `AGENTSWITCH_BROWSER_TOKEN`), never taken from the command line, and
 *  sent only to the daemon. `--output-dir`, which the gate adds for a Playwright MCP of its own, is accepted and unused:
 *  Playwright MCP's files are written in the daemon's private folder for this connection.
 *
 *  Wire: `GET /browser/agent/mcp` opens the connection (SSE: `endpoint {connection}`, then `message` events, each one
 *  JSON-RPC message for the agent); each message from the agent is `POST /browser/agent/mcp/<connection>`. Both carry
 *  `Authorization: Bearer <token>` and `X-AgentSwitch-Browser-Session: <id>`.
 *
 *  Runs as a plain script under the service's own node (no imports beyond node, erasable types only), so the same file
 *  works from dist/ and from src/ under node's type stripping. */

import { readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export type BridgeOptions = { readonly url: string; readonly session: string; readonly token: string };

type Message = { readonly id?: string | number; readonly method?: string };

const SESSION_HEADER = "x-agentswitch-browser-session";
/** One message from the agent, at most (a form with many fields is far smaller). */
const MAX_MESSAGE_CHARS = 4 * 1024 * 1024;

/** `--name value` and `--name=value`; unknown flags (the gate's `--output-dir`) are skipped. */
export function bridgeArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): BridgeOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) { values.set(arg.slice(2, eq), arg.slice(eq + 1)); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { values.set(arg.slice(2), next); i += 1; }
  }
  const url = (values.get("url") ?? env.AGENTSWITCH_BROWSER_URL ?? "").replace(/\/+$/, "");
  const session = values.get("session") ?? env.AGENTSWITCH_BROWSER_SESSION ?? "";
  const file = values.get("token-file");
  let token = env.AGENTSWITCH_BROWSER_TOKEN ?? "";
  if (file) {
    try { token = readFileSync(file, "utf8").trim(); } catch { throw new Error(`cannot read the token file ${file}`); }
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(url)) throw new Error("--url must be the daemon's local address (http://127.0.0.1:<port>)");
  if (!/^[\w-]{1,64}$/.test(session)) throw new Error("--session is required");
  if (!token) throw new Error("no token (--token-file or AGENTSWITCH_BROWSER_TOKEN)");
  return { url, session, token };
}

/** The error answer the agent gets for a message the daemon did not take (so a call does not hang). */
function undelivered(message: Message, why: string): string | null {
  if (message.id === undefined || !message.method) return null;
  return JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `AgentSwitch's shared browser: ${why}` } });
}

/** Runs until stdin ends (the agent stops the tool) or the daemon ends the connection; resolves with the exit code. */
export async function runBridge(opts: BridgeOptions, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Promise<number> {
  const headers = { authorization: `Bearer ${opts.token}`, [SESSION_HEADER]: opts.session };
  const abort = new AbortController();
  let res: Response;
  try {
    res = await fetch(`${opts.url}/browser/agent/mcp`, { headers: { ...headers, accept: "text/event-stream" }, signal: abort.signal });
  } catch (err) {
    log(`agentswitch browser: the daemon at ${opts.url} did not answer (${(err as Error).message})`);
    return 1;
  }
  if (!res.ok || !res.body) {
    log(`agentswitch browser: the daemon refused the connection (${res.status}${res.status === 401 ? ": the session ended or the token is wrong" : ""})`);
    return 1;
  }
  let connection: string | null = null;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const write = (line: string) => new Promise<void>((resolve) => { output.write(`${line}\n`, () => resolve()); });

  // Daemon → agent.
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "message";
    let data: string[] = [];
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line === "") {
          const body = data.join("\n");
          if (event === "endpoint") { connection = (JSON.parse(body) as { connection: string }).connection; markReady(); }
          else if (event === "message" && body) await write(body);
          event = "message";
          data = [];
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  })().catch(() => undefined);

  // Agent → daemon, one message at a time, in order.
  const lines = createInterface({ input, crlfDelay: Infinity });
  let sending = Promise.resolve();
  const send = async (line: string) => {
    let message: Message;
    try { message = JSON.parse(line) as Message; } catch { return; }
    await Promise.race([ready, reading]);
    const refused = async (why: string) => { const answer = undelivered(message, why); if (answer) await write(answer); };
    if (!connection) { await refused("the connection to the daemon ended"); return; }
    if (line.length > MAX_MESSAGE_CHARS) { await refused("the message is too large"); return; }
    try {
      const r = await fetch(`${opts.url}/browser/agent/mcp/${connection}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: line });
      if (!r.ok) await refused(`the daemon did not take the message (${r.status})`);
    } catch {
      await refused("the daemon did not answer");
    }
  };
  lines.on("line", (line) => { if (line.trim()) sending = sending.then(() => send(line)); });
  const stdinClosed = new Promise<"stdin">((resolve) => lines.on("close", () => resolve("stdin")));
  const ended = await Promise.race([stdinClosed, reading.then(() => "daemon" as const)]);
  if (ended === "stdin") await sending;
  abort.abort();
  lines.close();
  return ended === "stdin" ? 0 : 1;
}

/** As a script: run with this process's arguments, then exit (stdout flushed first). */
const entry = (() => { try { return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : ""; } catch { return ""; } })();
if (import.meta.url === entry) {
  let opts: BridgeOptions | null = null;
  try { opts = bridgeArgs(process.argv.slice(2)); } catch (err) { process.stderr.write(`agentswitch browser: ${(err as Error).message}\n`); process.exitCode = 2; }
  if (opts) void runBridge(opts).then((code) => { process.stdout.write("", () => process.exit(code)); });
}
