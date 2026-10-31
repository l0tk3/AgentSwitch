/** One request through an HTTP proxy that asks for a user name and a password — a profile's forwarder on this
 *  machine's loopback (browser/forwarder.ts), through which what runs under the profile leaves. Plain for `http:`, a
 *  CONNECT tunnel with TLS inside it for `https:`. No redirect is followed: a 3xx comes back as it is, and what was
 *  sent with the request (a key) goes nowhere else. */

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";

/** Where the proxy is and what it asks for (a `ForwarderAddress` fits). */
export type ProxyWay = { readonly server: string; readonly username: string; readonly password: string };

export type ViaRequest = { readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly maxChars?: number };
export type ViaAnswer = { readonly status: number; readonly body: string };

const DEFAULT_MAX_CHARS = 1 << 20;

function read(res: IncomingMessage, maxChars: number): Promise<ViaAnswer> {
  return new Promise((resolve, reject) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (d: string) => { body += d; if (body.length > maxChars) res.destroy(new Error("the answer is too long")); });
    res.on("error", reject);
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
  });
}

/** `url` asked through `via`: the status and the body as they came. Rejects when the proxy or the address cannot be
 *  reached, or when nothing came in `timeoutMs`. */
export function requestVia(url: URL, via: ProxyWay, o: ViaRequest): Promise<ViaAnswer> {
  const proxy = new URL(via.server);
  const auth = `Basic ${Buffer.from(`${via.username}:${via.password}`).toString("base64")}`;
  const method = o.method ?? "GET", headers = o.headers ?? {}, maxChars = o.maxChars ?? DEFAULT_MAX_CHARS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), o.timeoutMs);
    const done = (p: Promise<ViaAnswer>) => p.then(resolve, reject).finally(() => clearTimeout(timer));
    if (url.protocol === "http:") {
      const req = httpRequest({ host: proxy.hostname, port: proxy.port, method, path: url.href, timeout: o.timeoutMs, headers: { ...headers, host: url.host, "proxy-authorization": auth } }, (res) => done(read(res, maxChars)));
      req.on("error", reject).on("timeout", () => req.destroy(new Error("timed out"))).end();
      return;
    }
    const port = url.port || "443";
    const tunnel = httpRequest({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: `${url.hostname}:${port}`, timeout: o.timeoutMs, headers: { host: `${url.hostname}:${port}`, "proxy-authorization": auth } });
    tunnel.on("error", reject).on("timeout", () => tunnel.destroy(new Error("timed out")));
    tunnel.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`the proxy answered ${res.statusCode}`)); return; }
      // No `agent`: with one Node would open its own connection, past the tunnel (browser/exit.ts, 2026-10-14).
      const req = httpsRequest({ host: url.hostname, port, method, path: `${url.pathname}${url.search}`, headers: { ...headers, connection: "close" }, timeout: o.timeoutMs,
        createConnection: () => tlsConnect({ socket, servername: url.hostname }) }, (r) => done(read(r, maxChars).finally(() => socket.destroy())));
      req.on("error", (err) => { socket.destroy(); reject(err); }).on("timeout", () => req.destroy(new Error("timed out"))).end();
    });
  });
}

/** `fetch` as far as a caller that reads `status`, `ok` and the body needs it, through `via`. */
export function fetchVia(via: ProxyWay, timeoutMs: number): (url: string, init?: { headers?: Record<string, string>; method?: string }) => Promise<Response> {
  return async (url, init) => {
    const { status, body } = await requestVia(new URL(url), via, { ...(init?.method ? { method: init.method } : {}), headers: init?.headers ?? {}, timeoutMs });
    // A Response takes no body with these; nothing is lost, there is none.
    return new Response(status === 204 || status === 205 || status === 304 ? null : body, { status: status >= 200 && status <= 599 ? status : 502 });
  };
}
