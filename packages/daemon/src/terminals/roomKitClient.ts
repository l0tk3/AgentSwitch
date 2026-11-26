/** The agent's end of the Chatroom Kit (docs/chatroom-v0.md §6): an MCP server on stdio with the tools a session has
 *  in AgentSwitch's Chat Room. It keeps nothing and decides nothing: which tools there are and what each call answers
 *  is asked of the service, with this terminal's own hook token — so the service knows which session speaks, and the
 *  session never says so itself. When the tools change (the session was seated in its first room, or left its last)
 *  the agent is told to list them again.
 *
 *    node roomKitClient.js      with AGENTSWITCH_TERMINAL_URL, AGENTSWITCH_TERMINAL_ID, AGENTSWITCH_TERMINAL_HOOK_TOKEN
 *
 *  Runs as a plain script under the service's own node (no imports beyond node, erasable types only), so the same file
 *  works from dist/ and from src/ under node's type stripping. */

import { request } from "node:http";
import { createInterface } from "node:readline";

const url = process.env.AGENTSWITCH_TERMINAL_URL ?? "";
const id = process.env.AGENTSWITCH_TERMINAL_ID ?? "";
const token = process.env.AGENTSWITCH_TERMINAL_HOOK_TOKEN ?? "";

type Rpc = { readonly jsonrpc?: string; readonly id?: string | number; readonly method?: string; readonly params?: Record<string, unknown> };

const AWAY = "AgentSwitch's Chat Room did not answer (its service may be restarting). Try again in a moment.";
/** A watch is held by the service for minutes; a call is answered at once. */
const WATCH_WAIT_MS = 7 * 60_000, CALL_WAIT_MS = 60_000, RETRY_MS = 4000;

function ask(body: unknown, waitMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = request(`${url}/terminals/room`, { method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), authorization: `Bearer ${token}`, "x-agentswitch-terminal": id } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") as Record<string, unknown> }); } catch (err) { reject(err as Error); } });
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("no answer in time")), waitMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(text);
  });
}

const say = (message: unknown): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let known = "";       // the tools the agent was last given, as the service names that set
let watching = false;
let over = false;

/** Asks the service again and again whether the tools are still the ones the agent knows; tells the agent when not. */
async function watch(): Promise<void> {
  if (watching) return;
  watching = true;
  while (!over) {
    try {
      const res = await ask({ op: "watch", version: known }, WATCH_WAIT_MS);
      if (res.status === 403) return;   // the terminal is not one the service knows any more
      if (res.status !== 200) { await sleep(RETRY_MS); continue; }
      const now = String(res.body.version ?? "");
      if (now !== known) { known = now; say({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); }
    } catch { await sleep(RETRY_MS); }
  }
}

async function answer(m: Rpc): Promise<void> {
  const reply = (result: unknown): void => { if (m.id !== undefined) say({ jsonrpc: "2.0", id: m.id, result }); };
  switch (m.method) {
    case "initialize":
      reply({
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "agentswitch-chatroom", version: "1" },
      });
      return;
    case "notifications/initialized": if (!outside) void watch(); return;
    case "ping": reply({}); return;
    case "tools/list": {
      if (outside) { reply({ tools: [] }); return; }
      try {
        const res = await ask({ op: "tools" }, CALL_WAIT_MS);
        if (res.status === 200) known = String(res.body.version ?? "");
        reply({ tools: res.status === 200 && Array.isArray(res.body.tools) ? res.body.tools : [] });
      } catch { reply({ tools: [] }); }
      void watch();
      return;
    }
    case "tools/call": {
      if (outside) { reply({ content: [{ type: "text", text: "AgentSwitch's Chat Room is there only in an AgentSwitch terminal." }], isError: true }); return; }
      try {
        const res = await ask({ op: "call", name: String(m.params?.name ?? ""), args: m.params?.arguments && typeof m.params.arguments === "object" ? m.params.arguments : {} }, CALL_WAIT_MS);
        if (res.status !== 200) { reply({ content: [{ type: "text", text: typeof res.body.error === "string" ? `AgentSwitch's Chat Room: ${res.body.error}` : AWAY }], isError: true }); return; }
        reply({ content: [{ type: "text", text: String(res.body.text ?? "") }], ...(res.body.isError === true ? { isError: true } : {}) });
      } catch { reply({ content: [{ type: "text", text: AWAY }], isError: true }); }
      return;
    }
    default:
      if (m.id !== undefined && m.method) say({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

/** `--quiet-outside`: where the agent's own configuration names this server for every start of it (Grok's config.toml,
 *  Antigravity's mcp_config.json: neither takes a server for one start), a start outside an AgentSwitch terminal has
 *  a server with no tools instead of one that fails. */
const outside = !url || !id || !token;
if (outside && !process.argv.includes("--quiet-outside")) { process.stderr.write("AgentSwitch's Chatroom Kit runs inside an AgentSwitch terminal.\n"); process.exit(1); }
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: Rpc;
  try { message = JSON.parse(line) as Rpc; } catch { return; }
  void answer(message);
});
lines.on("close", () => { over = true; process.exit(0); });
