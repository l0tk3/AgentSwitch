/** The Mac's own coding sessions (docs/control-v0.md §3): what Claude Code, Codex, OpenCode, pi and Grok keep of the
 *  sessions the user ran, read-only, so the phone can watch them and the assistant knows where the user is working. */

export type SessionHarness = "claude-code" | "codex" | "opencode" | "pi" | "grok" | "agy";

/** How the session last asked before acting, in the terminals' three words (docs/terminal-v0.md §3): every time, the
 *  agent's automatic mode, or not at all. Continuing the session keeps it. */
export type SessionMode = "manual" | "auto" | "bypass";

export type SessionSummary = {
  readonly harness: SessionHarness;
  readonly id: string;
  readonly cwd: string;
  /** The session's title: the name the user gave it in the agent, else the title its agent gave it while it ran in a
   *  terminal here (sessions/titles.ts), else its first real user message (one line, clipped). */
  readonly title: string;
  /** The title is a name the user gave it in the agent itself (Claude Code's `/rename`, pi's, OpenCode's own). */
  readonly named?: true;
  /** The latest assistant text (one line, clipped). */
  readonly lastText: string;
  readonly updatedAt: number;
  /** When it began (its record was made): the tree's order, which activity does not move (terminal-v0 §1). */
  readonly startedAt: number;
  /** Updated within `ACTIVE_MS`. */
  readonly active: boolean;
  /** Codex: desktop / cli / vscode. */
  readonly origin?: string;
  readonly branch?: string;
  readonly model?: string;
  /** Its permission mode at the last turn (Claude Code, Codex); absent when the record does not say. */
  readonly mode?: SessionMode;
  /** Codex: the session this one was forked from (`codex fork`), e.g. by continuing it in an AgentSwitch terminal. */
  readonly forkedFrom?: string;
};

export type SessionMessage = {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly ts: number;
  readonly tool?: string;
  /** Where it stands in its session, the same however much is read before or after it (OpenCode: its row and its
   *  part); absent: its place in what was read. */
  readonly at?: number;
};

export const ACTIVE_MS = 90_000;
export const TITLE_CHARS = 120;
export const MESSAGE_CHARS = 2000;

/** One line, whitespace collapsed, clipped with an ellipsis. */
export function oneLine(text: string, limit: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

export function clipText(text: string, limit = MESSAGE_CHARS): string {
  const s = text.trim();
  return s.length > limit ? `${s.slice(0, limit)}…（共 ${s.length} 字）` : s;
}
