/** A seat as it is now (docs/chatroom-v0.md §1 名片, §6.1). The rooms keep none of this: whoever knows the sessions
 *  says it (the terminals, through the composition root). */

import type { SeatWas } from "./store.js";

/** A seat's state in the room. The first four are the terminal's own; the rest say what is wrong with it. */
export type SeatState = "busy" | "waiting" | "idle" | "exited" | "reconnecting" | "limited" | "signed_out" | "blocked" | "error" | "offline";

/** A seat's card: no account, no address. */
export type SeatCard = SeatWas & {
  /** How it asks, in its agent's own word. */
  readonly mode: string | null;
  /** The node it runs on; null: this one. */
  readonly node: string | null;
};

export type SeatLive = { readonly state: SeatState; readonly card: SeatCard };

/** The session behind a terminal now; null: there is no such terminal any more. */
export type SeatLookup = (terminal: string) => SeatLive | null;

/** What a message addressed to a seat in this state meets (§6.1), for whoever sent it. */
export const STATE_MEETS: Readonly<Record<SeatState, string>> = {
  idle: "idle: it gets the message now",
  busy: "busy: it gets the message when its current turn ends",
  waiting: "waiting for the user's answer: it gets the message after the user has answered",
  exited: "its session has ended: the message can not be given to it",
  reconnecting: "reconnecting to its service: it gets the message once it is back",
  limited: "out of quota or rate limited: it gets the message when that passes",
  signed_out: "signed out: the message can not be given until the user signs it in again",
  blocked: "its last turn was stopped by a safeguard: it may not handle the message",
  error: "its last turn ended in an error: delivery is tried once more",
  offline: "its node is unreachable: it gets the message when the node is back",
};

const AGENTS: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi", grok: "Grok", agy: "Antigravity" };
export const agentName = (agent: string): string => AGENTS[agent] ?? agent;
