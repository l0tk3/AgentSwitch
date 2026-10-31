/** The agents and executors by the names their makers give them: the same in every language. */

const NAMES: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi", echo: "Echo" };

export function agentName(id: string): string {
  return NAMES[id] ?? id;
}
