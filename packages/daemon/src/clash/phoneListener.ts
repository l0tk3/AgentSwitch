/** Where a phone's Clash or Stash takes the subscription (docs/clash-v0.md §12): plain HTTP on every interface, one
 *  address (`/clash/phone.yaml?k=<token>`), from the networks a paired phone may come from (home networks, Tailscale)
 *  and no other. Plain, because those apps take no certificate they were not shipped with: the token and what is
 *  answered can be read by whoever sees the network's traffic — over Tailscale nobody, at home whoever is on it. */

import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import type { ClashIntegration } from "./integration.js";

export const DEFAULT_PHONE_PORT = 4714;
export const PHONE_PATH = "/clash/phone.yaml";

export type PhoneListener = { readonly port: number; close(): Promise<void> };

function bind(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (err: Error) => { server.off("listening", ok); reject(err); };
    const ok = () => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ok);
    server.listen(port, host);
  });
}

const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function listenPhone(clash: Pick<ClashIntegration, "phone" | "phoneOn" | "phoneToken">, port: number,
  /** `allowSource`: the networks a caller may come from (whoever listens says: the remote listener's own table). */
  opts: { readonly host?: string; readonly allowSource: (address: string | undefined) => boolean; readonly log?: (message: string) => void }): Promise<PhoneListener> {
  const allow = opts.allowSource;
  const server = createServer((req, res) => {
    const say = (status: number, text: string, headers: Record<string, string> = {}): void => { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(req.method === "HEAD" ? undefined : text); };
    try {
      const url = new URL(req.url ?? "/", "http://phone");
      // Anything but the one address with the token of now is not there, whatever was asked.
      if ((req.method !== "GET" && req.method !== "HEAD") || url.pathname !== PHONE_PATH || !clash.phoneOn() || !same(url.searchParams.get("k") ?? "", clash.phoneToken())) return say(404, "not found\n");
      const agent = req.headers["user-agent"];
      const made = clash.phone(typeof agent === "string" ? agent : undefined, url.searchParams.get("for") ?? undefined);
      if (!made) return say(503, "# AgentSwitch: no subscription to work from yet (Clash, in the AgentSwitch window)\n");
      // Who took it is said without the address it was asked by: that carries the token.
      (opts.log ?? console.error)(`clash phone subscription (${made.app}) to ${req.socket.remoteAddress ?? "?"}`);
      say(200, made.text, { "content-type": "text/yaml; charset=utf-8", ...made.headers });
    } catch (err) {
      say(500, "internal error\n");
      (opts.log ?? console.error)(`clash phone listener: ${(err as Error).message}`);
    }
  });
  // A caller from anywhere else is gone before it says a word.
  server.prependListener("connection", (socket: Socket) => { if (!allow(socket.remoteAddress)) socket.destroy(); });
  const host = opts.host ?? "::";
  try { await bind(server, port, host); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (opts.host !== undefined || (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL")) throw err;
    await bind(server, port, "0.0.0.0");
  }
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
