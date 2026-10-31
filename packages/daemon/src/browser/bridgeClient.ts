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
  // With `/profile-browser/<key>` after it: a profile's own browser rather than the shared one (docs/profiles-v0.md §5.1).
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(\/profile-browser\/[a-z0-9.-]+)?$/.test(url)) throw new Error("--url must be the daemon's local address (http://127.0.0.1:<port>)");
  if (!/^[\w-]{1,64}$/.test(session)) throw new Error("--session is required");
  if (!token) throw new Error("no token (--token-file or AGENTSWITCH_BROWSER_TOKEN)");
  return { url, session, token };
}

/** The error answer the agent gets for a message the daemon did not take (so a call does not hang). */
function undelivered(message: Message, why: string): string | null {
  if (message.id === undefined || !message.method) return null;
  return JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `AgentSwitch's shared browser: ${why}` } });
}

/** How long the bridge keeps trying to reach the daemon again after its connection ended (a restart or an update of the
 *  service, docs/terminal-v0.md §10), and how long it waits between tries at most. */
const RECONNECT_FOR_MS = 120_000;
const RECONNECT_STEP_MS = 4_000;
/** The id the bridge's own `initialize` goes under when it greets a new connection for the agent (its answer is not
 *  the agent's: dropped). */
const REINIT_ID = "agentswitch-bridge-reinit";

type Wire = { readonly connection: string; readonly ended: Promise<void>; readonly abort: AbortController };

/** Runs until stdin ends (the agent stops the tool), or until the daemon is gone for good; resolves with the exit code.
 *  When its connection ends — the service restarting — it connects again with the same session and greets the new
 *  connection as the agent greeted the first (its `initialize`, sent again; the answer dropped), so the agent's
 *  browser tool goes on working. What the agent asks meanwhile is answered with an error at once. */
export async function runBridge(opts: BridgeOptions, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`), timing: { reconnectForMs?: number; stepMs?: number } = {}): Promise<number> {
  const headers = { authorization: `Bearer ${opts.token}`, [SESSION_HEADER]: opts.session };
  const write = (line: string) => new Promise<void>((resolve) => { output.write(`${line}\n`, () => resolve()); });
  let greeting: string | null = null;     // the agent's initialize, as it sent it
  let dropAnswer = false;

  /** One connection: its id once the daemon names it, and when it ends. "refused": the session is not (any more) one
  *  the daemon knows — revoked when the agent's program ended; null: not reached (yet). */
  const connect = async (first: boolean): Promise<Wire | "refused" | null> => {
    const abort = new AbortController();
    let res: Response;
    try {
      res = await fetch(`${opts.url}/browser/agent/mcp`, { headers: { ...headers, accept: "text/event-stream" }, signal: abort.signal });
    } catch (err) {
      if (first) log(`agentswitch browser: the daemon at ${opts.url} did not answer (${(err as Error).message})`);
      return null;
    }
    if (!res.ok || !res.body) {
      if (first || res.status === 401) log(`agentswitch browser: the daemon refused the connection (${res.status}${res.status === 401 ? ": the session ended or the token is wrong" : ""})`);
      abort.abort();
      return res.status === 401 || res.status === 403 ? "refused" : null;
    }
    let named: (id: string | null) => void = () => undefined;
    const name = new Promise<string | null>((resolve) => { named = resolve; });
    const ended = (async () => {
      const decoder = new TextDecoder();
      let buffer = "", event = "message";
      let data: string[] = [];
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line === "") {
            const body = data.join("\n");
            if (event === "endpoint") named((JSON.parse(body) as { connection: string }).connection);
            else if (event === "message" && body) {
              // The answer to the bridge's own greeting of a new connection is not the agent's.
              if (dropAnswer && body.includes(REINIT_ID)) { try { if ((JSON.parse(body) as Message).id === REINIT_ID) { dropAnswer = false; event = "message"; data = []; continue; } } catch { /* the agent's */ } }
              await write(body);
            }
            event = "message";
            data = [];
          } else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    })().catch(() => undefined).finally(() => named(null));
    const connection = await name;
    if (!connection) { abort.abort(); return null; }
    return { connection, ended, abort };
  };

  const post = (wire: Wire, line: string) => fetch(`${opts.url}/browser/agent/mcp/${wire.connection}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: line });

  const firstWire = await connect(true);
  if (!firstWire || firstWire === "refused") return 1;
  let wire: Wire | null = firstWire;
  let gone = false;

  // Agent → daemon, one message at a time, in order.
  const lines = createInterface({ input, crlfDelay: Infinity });
  let sending = Promise.resolve();
  const send = async (line: string) => {
    let message: Message;
    try { message = JSON.parse(line) as Message; } catch { return; }
    if (message.method === "initialize") greeting = line;
    const refused = async (why: string) => { const answer = undelivered(message, why); if (answer) await write(answer); };
    if (!wire) { await refused(gone ? "the connection to the daemon ended" : "AgentSwitch's service is restarting; try again in a moment"); return; }
    if (line.length > MAX_MESSAGE_CHARS) { await refused("the message is too large"); return; }
    try {
      const r = await post(wire, line);
      if (!r.ok) await refused(`the daemon did not take the message (${r.status})`);
    } catch {
      await refused("the daemon did not answer");
    }
  };
  lines.on("line", (line) => { if (line.trim()) sending = sending.then(() => send(line)); });
  let stdinOpen = true;
  const stdinClosed = new Promise<"stdin">((resolve) => lines.on("close", () => { stdinOpen = false; resolve("stdin"); }));

  for (;;) {
    const ended = await Promise.race([stdinClosed, wire.ended.then(() => "daemon" as const)]);
    if (ended === "stdin") { await sending; wire.abort.abort(); lines.close(); return 0; }
    // The daemon went: the service restarting. Connect again with the same session, for a while.
    wire = null;
    const until = Date.now() + (timing.reconnectForMs ?? RECONNECT_FOR_MS);
    let step = 250;
    let refused = false;
    while (!wire && !refused && stdinOpen && Date.now() < until) {
      await new Promise((r) => setTimeout(r, step));
      step = Math.min(step * 2, timing.stepMs ?? RECONNECT_STEP_MS);
      const got = await connect(false);
      if (got === "refused") refused = true; else wire = got;
    }
    if (!stdinOpen) { lines.close(); return 0; }
    // The session was ended on purpose (the terminal's program ended, or it was deleted): no other try.
    if (refused) { gone = true; lines.close(); return 1; }
    if (!wire) { gone = true; log("agentswitch browser: the daemon did not come back"); lines.close(); return 1; }
    log("agentswitch browser: connected to the daemon again");
    // The new connection is greeted as the agent greeted the first; its answer is dropped.
    if (greeting) {
      try {
        const again = { ...(JSON.parse(greeting) as Record<string, unknown>), id: REINIT_ID };
        dropAnswer = true;
        await post(wire, JSON.stringify(again));
        await post(wire, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      } catch { /* the next message finds out */ }
    }
  }
}

/** As a script: run with this process's arguments, then exit (stdout flushed first). */
const entry = (() => { try { return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : ""; } catch { return ""; } })();
if (import.meta.url === entry) {
  let opts: BridgeOptions | null = null;
  try { opts = bridgeArgs(process.argv.slice(2)); } catch (err) { process.stderr.write(`agentswitch browser: ${(err as Error).message}\n`); process.exitCode = 2; }
  if (opts) void runBridge(opts).then((code) => { process.stdout.write("", () => process.exit(code)); });
}
