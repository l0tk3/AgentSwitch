/** A profile's claude.ai session key (docs/profiles-v0.md §3.4): kept as a ciphertext of the gate's, and put into the
 *  profile's own browser as claude.ai's `sessionKey` cookie — so that browser is signed in there, and the page Claude
 *  Code's `/login` opens in it only has to be allowed. Nothing else is done with it: claude.ai is not asked anything
 *  with it, and it is in no agent's files or environment.
 *
 *  The plaintext is in this process for the moment the gate hands it over, and in the browser's own cookies. */

import type { DriverCookie } from "./driver.js";
import { CIPHERTEXT, type FillResolver } from "./fill.js";

/** Where the keys are kept (profiles/store.ts): the ciphertext, and whether the browser is still to be given it
 *  whatever it has. Setting refuses a profile that is not there, and the Mac's own. */
export type SessionKeyStore = {
  sessionKeyOf(agent: string, id: string): { readonly sealed: string; readonly due: boolean } | null;
  setSessionKey(agent: string, id: string, sealed: string | null): void;
  sessionKeyGiven(agent: string, id: string): void;
};

export class SessionKeyError extends Error {}

/** The site the key is sealed for and the cookie belongs to. */
export const CLAUDE_SITE = "https://claude.ai/";
/** A claude.ai session key as it is written (`sk-ant-sid01-…`): not a token of `claude setup-token`, not an API key. */
export const SESSION_KEY = /^sk-ant-sid\d{2}-[A-Za-z0-9_-]{20,400}$/;
const COOKIE_DAYS = 365;

/** claude.ai's own sign-in cookie holding `value`, as the site sets it. */
export function sessionCookie(value: string, now: number = Date.now()): DriverCookie {
  return { name: "sessionKey", value, domain: ".claude.ai", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: Math.floor(now / 1000) + COOKIE_DAYS * 86_400 };
}

/** The part of a profile's browser this needs: its cookie jar while it runs (browser/host.ts `setCookie`). */
export type CookieJar = { setCookie(cookie: DriverCookie, site: string, keep: boolean): Promise<boolean | null> };

export type SessionKeysOptions = {
  readonly store: SessionKeyStore;
  /** The gate's answer for a ciphertext; absent without the gate: no key can be kept. */
  readonly resolve?: FillResolver | undefined;
  /** The profile's own browser if one has been made (it may not run); null: none yet. */
  readonly browser: (agent: string, id: string) => CookieJar | null;
  readonly now?: () => number;
};

export class SessionKeys {
  constructor(private readonly o: SessionKeysOptions) {}

  /** `id`'s key from now on, a ciphertext sealed for claude.ai (null: forgotten; what its browser already has stays).
   *  Refused when the gate will not give it or it is not a session key. Its browser, if it runs, has it at once;
   *  otherwise when it next starts. */
  async set(agent: string, id: string, sealed: string | null): Promise<void> {
    if (sealed === null) { this.o.store.setSessionKey(agent, id, null); return; }
    if (!CIPHERTEXT.test(sealed)) throw new SessionKeyError("Session key 请以密文（enc:v1:）提供。");
    const value = await this.plain(sealed);
    this.o.store.setSessionKey(agent, id, sealed);   // refuses a profile that is not there, and `Default`
    await this.give(agent, id, value, false);
  }

  /** `id`'s browser has just started: it is given the key when one is due to it, or when it has none of its own. */
  async launched(agent: string, id: string): Promise<void> {
    const kept = this.o.store.sessionKeyOf(agent, id);
    if (!kept) return;
    await this.give(agent, id, await this.plain(kept.sealed), !kept.due);
  }

  private async give(agent: string, id: string, value: string, keep: boolean): Promise<void> {
    const wrote = await this.o.browser(agent, id)?.setCookie(sessionCookie(value, this.o.now?.()), CLAUDE_SITE, keep) ?? null;
    // One that was due is in the browser now. (No browser running: it stays due till one starts.)
    if (wrote !== null && !keep) this.o.store.sessionKeyGiven(agent, id);
  }

  private async plain(sealed: string): Promise<string> {
    if (!this.o.resolve) throw new SessionKeyError("凭据网关不可用，无法保存 session key。");
    let value: string;
    try { value = (await this.o.resolve(sealed, [CLAUDE_SITE])).value.trim(); }
    catch { throw new SessionKeyError("凭据网关没有给出这个 session key（它须是为 claude.ai 加密的）。"); }
    if (!SESSION_KEY.test(value)) throw new SessionKeyError("这不是 claude.ai 的 session key（应以 sk-ant-sid 开头）。");
    return value;
  }
}
