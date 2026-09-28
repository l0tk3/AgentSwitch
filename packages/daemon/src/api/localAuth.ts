/** A token on the 127.0.0.1 listener (2026-09-25, user decision). The browser guard (localGuard.ts) keeps web pages
 *  out; this keeps out any other program that can reach the port: sandboxed apps (they cannot read the token file) and,
 *  above all, the executors, which run as the same user and could otherwise call the local API to loosen their own
 *  approval policy or pair a device. The token lives in `$AGENTSWITCH_HOME/local-token` (0600), which executors may not
 *  read (protected.ts readDenied).
 *
 *  Who presents what:
 *  - the Mac app and the CLI: `Authorization: Bearer <token>`, read from the file;
 *  - the web console: a session cookie, got through a one-time link the Mac app asks for (`POST /local/console-link`
 *    with the token) — the link carries a code valid for a minute and once, never the token itself;
 *  - no proof needed: `GET /healthz` (the Mac app's liveness probe) and the console's static files (`/`, `/ui`,
 *    `/ui/*`), which hold no data; their API calls carry the cookie;
 *  - the terminals' hook command (`POST /terminals/hook`) shows its own terminal's hook token instead, which the route
 *    checks (docs/terminal-v0.md §3): the agent in the terminal can read that token, so it must never be the local one.
 *  The remote listener hands requests to the API in process and never comes through here (device tokens there). */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_TOKEN_NAME } from "../executors/protected.js";

export const LOCAL_TOKEN_FILE = LOCAL_TOKEN_NAME;
export const CONSOLE_COOKIE = "agentswitch_console";
const TOKEN_BYTES = 32;
const MIN_TOKEN_CHARS = 40;
const CODE_TTL_MS = 60_000;
const MAX_SESSIONS = 50;
/** Where a console link may land after signing in: a page of the console itself (`?next=`), never another site. */
const CONSOLE_PAGE = /^\/ui(\/(?!\.\.?(?:\/|$))[A-Za-z0-9._-]+)*$/;

/** The token in `home`, made on first use; a file too short to be one is replaced. */
export function ensureLocalToken(home: string): string {
  const path = join(home, LOCAL_TOKEN_FILE);
  const existing = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (existing.length >= MIN_TOKEN_CHARS) return existing;
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

/** The token for a client on this Mac (CLI), or null when the daemon has not made one yet. */
export function readLocalToken(home: string): string | null {
  try { return readFileSync(join(home, LOCAL_TOKEN_FILE), "utf8").trim() || null; } catch { return null; }
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const json = (status: number, body: object, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export class LocalAuth {
  /** One-time console codes → when they expire. */
  private readonly codes = new Map<string, number>();
  /** Console sessions, until the daemon restarts (the Mac app hands out a new link any time). */
  private readonly sessions = new Set<string>();

  constructor(private readonly token: string, private readonly now: () => number = Date.now) {}

  /** null when the request may go on; otherwise the answer (a refusal, a console link, the login redirect). */
  check(request: Request): Response | null {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (method === "GET" && path === "/ui/login") return this.login(url);
    if (method === "GET" && (path === "/healthz" || path === "/" || path === "/ui" || path.startsWith("/ui/"))) return null;
    if (method === "POST" && path === "/terminals/hook") return null;
    if (method === "POST" && path === "/local/console-link") {
      if (!this.bearer(request)) return this.refuse();
      const next = url.searchParams.get("next");
      return json(200, { path: `/ui/login?code=${this.mint()}${next && CONSOLE_PAGE.test(next) ? `&next=${encodeURIComponent(next)}` : ""}` });
    }
    return this.bearer(request) || this.session(request) ? null : this.refuse();
  }

  private bearer(request: Request): boolean {
    const m = /^Bearer\s+(\S+)\s*$/.exec(request.headers.get("authorization") ?? "");
    return !!m && same(m[1]!, this.token);
  }

  private session(request: Request): boolean {
    const cookies = request.headers.get("cookie") ?? "";
    const m = new RegExp(`(?:^|;\\s*)${CONSOLE_COOKIE}=([A-Za-z0-9_-]+)`).exec(cookies);
    return !!m && this.sessions.has(m[1]!);
  }

  private mint(): string {
    const now = this.now();
    for (const [code, expires] of this.codes) if (expires <= now) this.codes.delete(code);
    const code = randomBytes(18).toString("base64url");
    this.codes.set(code, now + CODE_TTL_MS);
    return code;
  }

  private login(url: URL): Response {
    const code = url.searchParams.get("code") ?? "";
    const expires = this.codes.get(code);
    this.codes.delete(code);
    if (expires === undefined || expires <= this.now()) {
      return new Response("链接已失效。请从菜单栏的 AgentSwitch 重新打开网页控制台。", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.values().next().value!);
    const session = randomBytes(TOKEN_BYTES).toString("base64url");
    this.sessions.add(session);
    const next = url.searchParams.get("next");
    const location = next && CONSOLE_PAGE.test(next) ? next : "/ui";
    return new Response(null, { status: 302, headers: { location, "set-cookie": `${CONSOLE_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/` } });
  }

  private refuse(): Response {
    return json(401, { error: "the local API needs its token (Authorization: Bearer, from $AGENTSWITCH_HOME/local-token); the web console opens from the Mac menu bar" });
  }
}
