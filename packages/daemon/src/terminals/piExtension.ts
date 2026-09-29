/** AgentSwitch's extension for pi in its terminals (docs/terminal-v0.md §3; pi has no permission layer of its own):
 *  every tool call goes to the service first and is blocked when it touches a protected path; pi's own run events give
 *  the terminal's status — busy from `agent_start`; idle at `agent_settled` (nothing more will run: `agent_end` ends
 *  one run, and a retry, compaction or queued follow-up may start another; `agent_end` still counts for a pi without
 *  `agent_settled`); waiting for you while pi blocks on a question of its own (`ui_prompt_start` … `ui_prompt_end`). It runs inside pi (`pi --extension <this file>`), so it imports nothing of the
 *  service: it only calls the hook route with this terminal's own hook token, as the hook command does. */

type PiEvent = Record<string, unknown>;
type Pi = { on(event: string, handler: (event: PiEvent) => unknown): unknown };

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

export default function agentswitch(pi: Pi): void {
  pi.on("tool_call", async (event) => {
    try {
      const out = await call("PiToolCall", { tool: event.toolName, input: event.input });
      return out?.block ? { block: true, reason: String(out.reason ?? "") } : undefined;
    } catch {
      // No answer, no tool (pi's own rule for a failing handler): the check is not skipped by the service being away.
      return { block: true, reason: NO_ANSWER };
    }
  });
  const say = (event: string) => () => { void call(event, {}).catch(() => undefined); };
  pi.on("agent_start", say("PiAgentStart"));
  pi.on("agent_end", say("PiAgentEnd"));
  pi.on("agent_settled", say("PiAgentEnd"));
  pi.on("ui_prompt_start", say("PiWaiting"));
  pi.on("ui_prompt_end", say("PiAgentStart"));
}
