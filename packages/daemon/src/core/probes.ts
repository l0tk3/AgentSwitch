/** What AgentSwitch itself sends to a harness only to read something back (not work the user asked for). The session
 *  monitor leaves sessions that opened with it out of the user's list (docs/control-v0.md §3). */
export const RATE_LIMIT_PROBE_PROMPT = "Reply with the single word: ok";

/** OpenCode agents AgentSwitch defines for its own model calls (router/routers/opencode.ts and opencodeServe.ts, the
 *  `oracle(...)` names in daemon.ts, and older names). They share the user's OpenCode database, so the monitor uses
 *  these names to leave those sessions out. The executor runs OpenCode's own `build` agent, like the user; those
 *  sessions are told apart by the ids AgentSwitch records. */
export const OWN_OPENCODE_AGENTS: readonly string[] = [
  "router", "dispatcher", "oracle", "summarizer", "supervisor", "question-translator", "sealer", "credential-repair", "assistant",
];
