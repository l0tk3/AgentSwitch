/** Where a proxy lets the browser's traffic out (docs/browser-v0.md §7.2 第 5 条): its address, the place and the time
 *  zone there, asked of a public lookup the way the browser's own traffic goes — through the forwarder, so through the
 *  proxy. One small request, made when a proxy is set and when the service starts with one; never without a proxy.
 *  `AGENTSWITCH_BROWSER_EXIT_LOOKUP` names another lookup, or `off` for none. */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { ForwarderAddress } from "./forwarder.js";

export type ExitInfo = { readonly ip: string; readonly place: string | null; readonly timezone: string | null };
export type ExitProbe = () => Promise<ExitInfo>;

export const DEFAULT_EXIT_LOOKUP = "https://ipinfo.io/json";
const TIMEOUT_MS = 8_000;
const MAX_ANSWER_CHARS = 16 * 1024;

const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null;

function zone(v: unknown): string | null {
  const name = text(typeof v === "object" && v !== null ? (v as Record<string, unknown>).id : v);
  if (!name) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return name; } catch { return null; }
}

/** A lookup's answer (`{ip, city, country, timezone}`; the zone may be `{id}`): throws when it names no address. */
export function parseExit(body: string): ExitInfo {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new Error("the lookup's answer is not JSON"); }
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const ip = text(o.ip);
  if (!ip || !isIP(ip)) throw new Error("the lookup's answer names no address");
  return { ip, place: text(o.city) ?? text(o.country), timezone: zone(o.timezone) };
}

/** The lookup named by the environment: the default, another, or none (`off`). */
export function exitLookup(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.AGENTSWITCH_BROWSER_EXIT_LOOKUP?.trim();
  if (!v) return DEFAULT_EXIT_LOOKUP;
  return /^https?:\/\//.test(v) ? v : null;
}

function read(res: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (d: string) => { body += d; if (body.length > MAX_ANSWER_CHARS) res.destroy(new Error("the lookup's answer is too long")); });
    res.on("error", reject);
    res.on("end", () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`the lookup answered ${res.statusCode}`))));
  });
}

/** One GET of `url` through the forwarder: plain for `http:`, a tunnel and TLS inside it for `https:`. */
function get(url: URL, via: ForwarderAddress, timeoutMs: number): Promise<string> {
  const proxy = new URL(via.server);
  const auth = `Basic ${Buffer.from(`${via.username}:${via.password}`).toString("base64")}`;
  const headers = { accept: "application/json", "user-agent": "curl/8" };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the lookup timed out")), timeoutMs);
    const done = (p: Promise<string>) => p.then(resolve, reject).finally(() => clearTimeout(timer));
    if (url.protocol === "http:") {
      const req = httpRequest({ host: proxy.hostname, port: proxy.port, method: "GET", path: url.href, timeout: timeoutMs, headers: { ...headers, host: url.host, "proxy-authorization": auth } }, (res) => done(read(res)));
      req.on("error", reject).on("timeout", () => req.destroy(new Error("the lookup timed out"))).end();
      return;
    }
    const port = url.port || "443";
    const tunnel = httpRequest({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: `${url.hostname}:${port}`, timeout: timeoutMs, headers: { host: `${url.hostname}:${port}`, "proxy-authorization": auth } });
    tunnel.on("error", reject).on("timeout", () => tunnel.destroy(new Error("the lookup timed out")));
    tunnel.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`the proxy answered ${res.statusCode}`)); return; }
      const req = httpsRequest({ host: url.hostname, port, method: "GET", path: `${url.pathname}${url.search}`, headers, timeout: timeoutMs, agent: false,
        createConnection: () => tlsConnect({ socket, servername: url.hostname }) }, (r) => done(read(r).finally(() => socket.destroy())));
      req.on("error", (err) => { socket.destroy(); reject(err); }).on("timeout", () => req.destroy(new Error("the lookup timed out"))).end();
    });
    tunnel.end();
  });
}

export function exitProbe(opts: { readonly forwarder: () => Promise<ForwarderAddress>; readonly url: string; readonly timeoutMs?: number }): ExitProbe {
  return async () => parseExit(await get(new URL(opts.url), await opts.forwarder(), opts.timeoutMs ?? TIMEOUT_MS));
}
