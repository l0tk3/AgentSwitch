/** Pairing (app-v0 §2 配对): one-time codes of 8 Crockford base32 characters shown as XXXX-XXXX, valid 5 minutes, used
 *  once, void after 5 wrong attempts; a per-source rate limit on POST /pair; the QR payload and its agentswitch:// link.
 *  In memory only: a restart voids the code, which is what a one-time code should do anyway. */

import { randomBytes, timingSafeEqual } from "node:crypto";

export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 8;
export const PAIRING_TTL_MS = 5 * 60_000;
export const MAX_WRONG_ATTEMPTS = 5;
/** POST /pair per source address: at most this many attempts in the window, right or wrong. */
export const PAIR_RATE_LIMIT = 10;
export const PAIR_RATE_WINDOW_MS = 60_000;

export type PairingCode = { readonly code: string; readonly expiresAt: number };

/** XXXXXXXX → XXXX-XXXX. */
export function formatCode(raw: string): string {
  return `${raw.slice(0, CODE_CHARS / 2)}-${raw.slice(CODE_CHARS / 2)}`;
}

/** Crockford decoding rules: case-insensitive, hyphens and spaces ignored, O → 0, I and L → 1. Null when the result is
 *  not exactly 8 symbols of the alphabet. */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return s.length === CODE_CHARS && [...s].every((ch) => CROCKFORD.includes(ch)) ? s : null;
}

/** 8 symbols, 5 bits each from one random byte (256 is a multiple of 32, so every symbol is equally likely). */
export function newCode(random: (n: number) => Buffer = randomBytes): string {
  return [...random(CODE_CHARS)].map((b) => CROCKFORD[b & 31]).join("");
}

export type Redeem = "ok" | "rejected" | "rate_limited";

export type PairingOptions = { readonly now?: () => number; readonly random?: (n: number) => Buffer };

/** The active code and the per-source attempt log. Issuing a code voids the previous one: only the code on the Mac's
 *  screen right now can pair. */
export class PairingDesk {
  private readonly now: () => number;
  private readonly random: (n: number) => Buffer;
  private active: { readonly raw: string; readonly expiresAt: number; readonly wrong: number } | null = null;
  private attempts = new Map<string, readonly number[]>();

  constructor(opts: PairingOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? randomBytes;
  }

  issue(): PairingCode {
    const raw = newCode(this.random);
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.active = { raw, expiresAt, wrong: 0 };
    return { code: formatCode(raw), expiresAt };
  }

  /** The code a phone may still use, if any (not expired, not used, fewer than 5 wrong attempts). */
  current(): PairingCode | null {
    return this.active && this.active.expiresAt > this.now() ? { code: formatCode(this.active.raw), expiresAt: this.active.expiresAt } : null;
  }

  /** Count an attempt from `source` and report whether it is over the limit. Old entries are dropped on the way. */
  limited(source: string): boolean {
    const now = this.now();
    const recent = (list: readonly number[]) => list.filter((t) => now - t < PAIR_RATE_WINDOW_MS);
    this.attempts = new Map([...this.attempts].map(([k, v]) => [k, recent(v)] as const).filter(([, v]) => v.length > 0));
    const mine = [...(this.attempts.get(source) ?? []), now];
    this.attempts.set(source, mine);
    return mine.length > PAIR_RATE_LIMIT;
  }

  /** Check a code from a phone. Success consumes the code; a wrong code is one strike, the fifth voids it. */
  redeem(input: string): Exclude<Redeem, "rate_limited"> {
    const active = this.active;
    if (!active || active.expiresAt <= this.now()) { this.active = null; return "rejected"; }
    const given = normalizeCode(input);
    const match = given !== null && timingSafeEqual(Buffer.from(given), Buffer.from(active.raw));
    if (match) { this.active = null; return "ok"; }
    const wrong = active.wrong + 1;
    this.active = wrong >= MAX_WRONG_ATTEMPTS ? null : { ...active, wrong };
    return "rejected";
  }
}

export type GateKey = { readonly publicKey: string; readonly keypair: string };

export type PairPayload = {
  readonly v: 1;
  readonly name: string;
  readonly port: number;
  readonly fp: string;
  readonly code: string;
  readonly lan: readonly string[];
  readonly tailnet: readonly string[];
  readonly bonjour: string;
  /** Null when the gate or its current keypair could not be read; the phone can ask GET /gate/pubkey later. */
  readonly gate: GateKey | null;
};

export const PAIR_LINK_PREFIX = "agentswitch://pair?p=";

/** The Bonjour service name the Mac app publishes: "AgentSwitch on <Mac name>". */
export function bonjourName(macName: string): string {
  return `AgentSwitch on ${macName}`;
}

/** The payload in the doc's key order, and its QR link: agentswitch://pair?p=<base64url(JSON), no padding>. */
export function pairPayload(input: Omit<PairPayload, "v" | "bonjour">): { readonly payload: PairPayload; readonly link: string } {
  const payload: PairPayload = { v: 1, name: input.name, port: input.port, fp: input.fp, code: input.code, lan: input.lan, tailnet: input.tailnet, bonjour: bonjourName(input.name), gate: input.gate };
  return { payload, link: PAIR_LINK_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") };
}
