/** What AgentSwitch itself sends to a harness only to read something back (not work the user asked for). The session
 *  monitor leaves sessions that opened with it out of the user's list (docs/control-v0.md §3). */
export const RATE_LIMIT_PROBE_PROMPT = "Reply with the single word: ok";

/** OpenCode agents the old Dispatch defined for its own model calls (removed 2026-11-25). The sessions they made are
 *  still in the user's OpenCode database, so the monitor uses these names to leave them out. Its executors ran
 *  OpenCode's own `build` agent, like the user; those sessions are told apart by the ids it recorded (daemon.ts
 *  `oldDispatchSessionIds`). */
export const OWN_OPENCODE_AGENTS: readonly string[] = [
  "router", "dispatcher", "oracle", "summarizer", "supervisor", "question-translator", "sealer" /* removed 2026-11-23; its old sessions remain */, "credential-repair", "assistant",
];
