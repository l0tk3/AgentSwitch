/** The Mac's own coding sessions (docs/control-v0.md §3): what Claude Code, Codex and OpenCode keep of the sessions the
 *  user ran, read-only, so the phone can watch them and the assistant knows where the user is working. */

export type SessionHarness = "claude-code" | "codex" | "opencode";

/** How the session last asked before acting, in the terminals' three words (docs/terminal-v0.md §3): every time, the
 *  agent's automatic mode, or not at all. Continuing the session keeps it. */
export type SessionMode = "manual" | "auto" | "bypass";

export type SessionSummary = {
  readonly harness: SessionHarness;
  readonly id: string;
  readonly cwd: string;
  /** The session's title, else its first real user message (one line, clipped). */
  readonly title: string;
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

/** Text shaped like a credential or personal detail (a gate token, a key, an email address or user@host, a long
 *  secret-looking run) masked, for what the router reads. Best effort: titles are short and clipped as well. */
export function maskSecrets(text: string): string {
  return text
    .replace(/enc:(?:v1|ref):[A-Za-z0-9_=-]+/g, "🔒")
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "🔒")
    .replace(/[\w.+-]+\\?@[\w-]+(?:\.[\w-]+)+/g, "🔒")   // email addresses and user@host (Codex escapes the @)
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) => (isPath(run) ? run : "🔒"));
}

/** `/Users/me/Downloads/report`: an absolute path of ordinary names, not a long random-looking run. */
const PATH_SEGMENT_CHARS = 24;
function isPath(run: string): boolean {
  return run.startsWith("/") && run.split("/").every((part) => part.length < PATH_SEGMENT_CHARS);
}
