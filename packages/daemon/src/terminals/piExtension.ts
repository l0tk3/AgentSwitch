/** AgentSwitch's extension for pi in its terminals (docs/terminal-v0.md §3; pi has no permission layer of its own):
 *  every tool call goes to the service first and is blocked when it touches a protected path; pi's own run events give
 *  the terminal's status — busy from `agent_start`; idle at `agent_settled` (nothing more will run: `agent_end` ends
 *  one run, and a retry, compaction or queued follow-up may start another; `agent_end` still counts for a pi without
 *  `agent_settled`); waiting for you while pi blocks on a question of its own (`ui_prompt_start` … `ui_prompt_end`).
 *  It also says which session pi writes — at `session_start` (pi's start, and `/new`, `/resume`, `/fork` typed in it)
 *  and with every call after — so the service knows a session open in one of its terminals (docs/terminal-v0.md §5:
 *  one writer; pi keeps no list or lock of its own to look at). It runs inside pi (`pi --extension <this file>`), so
 *  it imports nothing of the service: it only calls the hook route with this terminal's own hook token, as the hook
 *  command does. */

type PiEvent = Record<string, unknown>;
/** What pi hands a handler beside the event; only the session's id is read (pi 0.87.1 and 1.1.0 both have it). */
type PiContext = { sessionManager?: { getSessionId?: () => unknown } };
type Pi = {
  on(event: string, handler: (event: PiEvent, ctx?: PiContext) => unknown): unknown;
  /** pi 1.6: a message of the extension's own put into the session; `triggerTurn` starts a turn with it when pi rests,
   *  `followUp` takes it after the turn at work. */
  sendMessage?(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: "followUp" }): unknown;
  /** pi 1.6: an MCP server for this session, connected at once when registered after the start. */
  registerMcpServer?(name: string, config: Record<string, unknown>): unknown;
  unregisterMcpServer?(name: string): unknown;
};

/** Same budget as the quick hooks: the check answers from memory. */
const WAIT_MS = 10_000;
const NO_ANSWER = "AgentSwitch 服务无响应，已拦截此次工具调用。";

async function call(event: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const { AGENTSWITCH_TERMINAL_URL: url, AGENTSWITCH_TERMINAL_ID: id, AGENTSWITCH_TERMINAL_HOOK_TOKEN: token } = process.env;
  if (!url || !id || !token) throw new Error("not in an AgentSwitch terminal");
  const res = await fetch(`${url}/terminals/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id },
    body: JSON.stringify({ event, payload }),
    signal: AbortSignal.timeout(WAIT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { output?: Record<string, unknown> | null }).output ?? null;
}

/** The session pi writes now, as the hook route reads it from any call (`session_id`); nothing when pi does not say. */
function session(ctx: PiContext | undefined): { session_id?: string } {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id ? { session_id: id } : {};
  } catch {
    return {};
  }
}

export default function agentswitch(pi: Pi): void {
  pi.on("tool_call", async (event, ctx) => {
    try {
      const out = await call("PiToolCall", { tool: event.toolName, input: event.input, ...session(ctx) });
      return out?.block ? { block: true, reason: String(out.reason ?? "") } : undefined;
    } catch {
      // No answer, no tool (pi's own rule for a failing handler): the check is not skipped by the service being away.
      return { block: true, reason: NO_ANSWER };
    }
  });
  const say = (event: string) => (_event: PiEvent, ctx?: PiContext) => { void call(event, session(ctx)).catch(() => undefined); };
  pi.on("session_start", say("PiSession"));
  pi.on("agent_start", say("PiAgentStart"));
  pi.on("agent_end", say("PiAgentEnd"));
  pi.on("agent_settled", say("PiAgentEnd"));
  pi.on("ui_prompt_start", say("PiWaiting"));
  pi.on("ui_prompt_end", say("PiAgentStart"));
  writing(pi);
  room(pi);
}

/** Chat Room (docs/chatroom-v0.md §5, §6, §12). Two things run for as long as pi does, both asked of the service with
 *  this terminal's hook token: the Chatroom Kit's tool server is registered while the session sits in a room and taken
 *  away when it sits in none (and registered anew when its tools change), and a message for this session is put into
 *  it as a message of this extension's own — never as the user's — which starts a turn when pi rests. A pi that can do
 *  neither (before 1.6) is left as it is: it gets no messages it could not answer. */
function room(pi: Pi): void {
  const { AGENTSWITCH_TERMINAL_URL: url, AGENTSWITCH_TERMINAL_ID: id, AGENTSWITCH_TERMINAL_HOOK_TOKEN: token, AGENTSWITCH_ROOM_KIT_NODE: node, AGENTSWITCH_ROOM_KIT_SCRIPT: script } = process.env;
  if (!url || !id || !token || !node || !script || !pi.sendMessage || !pi.registerMcpServer || !pi.unregisterMcpServer) return;
  const SERVER = "chatroom";
  const ask = async (body: Record<string, unknown>, waitMs: number): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${url}/terminals/room`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agentswitch-terminal": id },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(waitMs),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });

  // The tools: there while the session sits in a room. A watch is held by the service for minutes (well under the
  // five of the runtime's own patience with a silent server).
  void (async () => {
    let known = "";
    for (;;) {
      try {
        const res = await ask({ op: "watch", version: known }, 4 * 60_000);
        if (res.status === 403) return;
        if (res.status !== 200) { await sleep(4000); continue; }
        const now = String(res.body.version ?? "");
        if (now === known) continue;
        known = now;
        try { pi.unregisterMcpServer!(SERVER); } catch { /* it was not registered */ }
        if (now) pi.registerMcpServer!(SERVER, { command: node, args: [script], env: { AGENTSWITCH_TERMINAL_ID: id, AGENTSWITCH_TERMINAL_URL: url, AGENTSWITCH_TERMINAL_HOOK_TOKEN: token }, exposure: "direct", description: "AgentSwitch's Chat Room: talk with the other sessions in the rooms you sit in." });
      } catch { await sleep(4000); }
    }
  })();

  // The messages.
  void (async () => {
    for (;;) {
      try {
        const res = await ask({ op: "wait" }, 4 * 60_000);
        if (res.status === 403) return;
        if (res.status !== 200) { await sleep(4000); continue; }
        if (typeof res.body.text === "string" && res.body.text) pi.sendMessage!({ customType: "agentswitch-room", content: res.body.text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
        else if (res.body.again !== true) await sleep(2000);   // another waits in this one's place: asked again shortly
      } catch { await sleep(4000); }
    }
  })();
}

/** How often what it is writing goes to the service at most (the service's own `WRITING_MS`). */
const WRITING_MS = 150;

/** What it is writing (docs/simple-view-v0.md §5.14): pi's own pieces of its answer (`message_update`, `text_delta` and
 *  `thinking_delta`), as the part's text so far, at most every WRITING_MS; `done` once its message ends (measured
 *  2026-10-16 with pi 1.1.0, scripts/partial_probe.ts: 90 pieces). */
function writing(pi: Pi): void {
  let part: { index: number; thinking: boolean; text: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  let sent = false;
  let ctxNow: PiContext | undefined;
  const send = () => {
    timer = null;
    if (!part) return;
    last = Date.now();
    sent = true;
    void call("PiWriting", { text: part.text, ...(part.thinking ? { thinking: true } : {}), ...session(ctxNow) }).catch(() => undefined);
  };
  pi.on("message_update", (event, ctx) => {
    const e = event.assistantMessageEvent as { type?: string; contentIndex?: number; delta?: unknown } | undefined;
    if (!e || (e.type !== "text_delta" && e.type !== "thinking_delta") || typeof e.delta !== "string" || !e.delta) return;
    const thinking = e.type === "thinking_delta", index = Number(e.contentIndex ?? 0);
    if (!part || part.index !== index || part.thinking !== thinking) part = { index, thinking, text: "" };
    part.text += e.delta;
    ctxNow = ctx;
    if (timer) return;
    const wait = last + WRITING_MS - Date.now();
    if (wait <= 0) send(); else timer = setTimeout(send, wait);
  });
  pi.on("message_end", (_event, ctx) => {
    if (timer) { clearTimeout(timer); timer = null; }
    part = null;
    if (!sent) return;
    sent = false;
    void call("PiWriting", { done: true, ...session(ctx) }).catch(() => undefined);
  });
}
