/** Reading what is typed into `agentswitch config`, the same way the Mac's sheets read it (mac-app
 *  `BrowserProxyDraft.split`, `BrowserIdentityText.proxySite`, `SessionKeyText`), so a proxy or a session key pasted on
 *  either is taken alike. Pure. */

import { DEFAULT_PORTS, type Ports } from "../keeper/plan.js";

export type ProxyDraft = { readonly server: string; readonly username: string; readonly password: string };

const PLACE = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;

/** A proxy as typed taken apart (user, 2026-10-09: 这个代理要支持直接输入一个http代理（http 开头 带用户名密码 服务器的那种）):
 *  `http://user:pass@host:port` — the name and the password apart, the server `http://host:port`. Also the same without
 *  a scheme (`http` meant), `host:port` alone, and the `host:port:user:pass` that proxy sellers hand out. A name or a
 *  password written with `%` escapes is read as what it stands for. Anything else is left as it is. */
export function splitProxy(typed: string, username = "", password = ""): ProxyDraft {
  let text = typed.trim().replace(/\/+$/, "");
  const sold = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5}):([^:\s]+):(\S+)$/.exec(text);
  if (sold) return { server: `http://${sold[1]}:${sold[2]}`, username: sold[3]!, password: sold[4]! };
  let scheme = "http";
  const named = /^(https?|socks4|socks5):\/\//i.exec(text);
  if (named) { scheme = named[1]!.toLowerCase(); text = text.slice(named[0].length); }
  else if (text.includes("://")) return { server: typed.trim(), username, password };
  // What stands before the last `@` is who asks; the first `:` in it parts the name from the password.
  let name: string | undefined, word: string | undefined;
  const at = text.lastIndexOf("@");
  if (at >= 0) {
    const who = text.slice(0, at), colon = who.indexOf(":");
    name = colon >= 0 ? who.slice(0, colon) : who;
    word = colon >= 0 ? who.slice(colon + 1) : undefined;
    text = text.slice(at + 1);
  }
  if (!PLACE.test(text)) return { server: typed.trim(), username, password };
  const plain = (s: string | undefined) => { if (!s) return undefined; try { return decodeURIComponent(s); } catch { return s; } };
  return { server: `${scheme}://${text}`, username: plain(name) ?? username, password: plain(word) ?? password };
}

/** `host:port` of a proxy written `scheme://host:port`: the site its password is sealed for. Null when not written so. */
export function proxySite(server: string): string | null {
  const m = /^(http|https|socks4|socks5):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(server.trim());
  if (!m) return null;
  const port = Number(m[3]);
  return port > 0 && port < 65536 ? `${m[2]}:${port}` : null;
}

/** A proxy line as the screen shows it while it is typed: the password hidden, one `•` per character, so the line keeps
 *  its length and the cursor its place; everything else as typed. The password is what `splitProxy` would take as one —
 *  what follows the first `:` before the `@` of `scheme://user:pass@host:port`, or the third `:` of the sellers'
 *  `host:port:user:pass`. Before the `@` is typed, what follows a name's `:` is hidden already, unless it reads as a port
 *  (`host:8080`), so a password typed by hand is not shown until an `@` arrives. Pure. */
export function maskProxyPassword(typed: string): string {
  const hide = (from: number, to: number) => typed.slice(0, from) + "•".repeat(Math.max(0, to - from)) + typed.slice(to);
  const end = typed.trimEnd().length;
  const sold = /^\s*(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):\d{1,5}:[^:\s]+:/.exec(typed);
  if (sold) return hide(sold[0].length, end);
  const start = /^\s*(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?/.exec(typed)![0].length;
  const authority = typed.slice(start, end);
  if (authority.startsWith("[")) return typed;        // an IPv6 host's own colons are no password
  const at = authority.lastIndexOf("@");
  const who = at >= 0 ? authority.slice(0, at) : authority;
  const colon = who.indexOf(":");
  if (colon < 0) return typed;
  const word = who.slice(colon + 1);
  if (at < 0 && (!word || /^\d{1,5}([:/]|$)/.test(word))) return typed;
  return hide(start + colon + 1, start + who.length);
}

/** The site a claude.ai session key is sealed for. */
export const SESSION_KEY_SITE = "claude.ai";

/** A claude.ai session key as typed (docs/profiles-v0.md §3.4): pasted as a cookie (`sessionKey=sk-ant-sid01-…;`) it is
 *  taken down to the key. */
export function cleanSessionKey(typed: string): string {
  let text = typed.trim();
  if (text.startsWith("sessionKey=")) text = text.slice("sessionKey=".length);
  const end = text.indexOf(";");
  if (end >= 0) text = text.slice(0, end);
  return text.replace(/^["' ]+|["' ]+$/g, "");
}

export function validSessionKey(typed: string): boolean {
  return /^sk-ant-sid\d{2}-[A-Za-z0-9_-]{20,400}$/.test(cleanSessionKey(typed));
}

export type PortProblem = "number" | "range" | "distinct";

/** What is wrong with four ports as typed (keeper/plan.ts `portsOf` holds the same rules), or the ports. */
export function portsFrom(typed: Readonly<Record<keyof Ports, string>>): Ports | PortProblem {
  const ports = { ...DEFAULT_PORTS } as Ports;
  for (const k of Object.keys(DEFAULT_PORTS) as (keyof Ports)[]) {
    const text = typed[k].trim();
    if (!/^\d+$/.test(text)) return "number";
    const n = Number(text);
    if (n < 1024 || n > 65535) return "range";
    ports[k] = n;
  }
  return new Set(Object.values(ports)).size === 4 ? ports : "distinct";
}
