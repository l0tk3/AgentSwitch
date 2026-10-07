/** The forwarder Camoufox's traffic goes through first (docs/browser-v0.md §7.3 转发层): a proxy of the service's own on
 *  this Mac's loopback. Firefox gives no way to refuse a request on the page itself once a redirect is under way, and
 *  its routes are not asked about a redirect's next hop (measured 2026-10-05: a page reached a refused port of this
 *  Mac by way of one 302) — but the browser asks its proxy for every hop, every tunnel and every WebSocket. So here:
 *
 *  - AgentSwitch's own ports on this Mac are never reached, however the Mac is named (a loopback name or address, or a
 *    name that resolves to one);
 *  - everything else goes straight out, or to the upstream proxy the person set — which can change while the browser
 *    runs (§7.2 第 5 条); what stays on this Mac or its own network never goes to the upstream;
 *  - only the browser it was started for is served: it is given a password made for this run.
 *
 *  What a page of whose tab may open (`file:`, the dev servers) is still the routes' and the host's to say. */

import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { RequestError, Server } from "proxy-chain";
import { isLoopbackAddress, isLoopbackHost, OWN_PORT_REFUSAL } from "./rules.js";

export type ForwarderOptions = {
  readonly ownPorts: () => readonly number[];
  /** The proxy what leaves this Mac goes to (`http://…`, `socks5://…`), or null: straight out. Asked for every request;
   *  throwing refuses the request (502). */
  readonly upstream?: () => string | null;
  /** The addresses a name stands for (the system's by default). */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  readonly log?: (line: string) => void;
};

/** What the browser is told: the proxy and the name and password to give it. */
export type ForwarderAddress = { readonly server: string; readonly username: string; readonly password: string };

const USER = "agentswitch";

async function systemResolve(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true })).map((a) => a.address);
}

const bare = (hostname: string): string => hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

/** This Mac, or its own network: a loopback name or address, a private or link-local IPv4 address, a `.local` name. */
export function isLocalDestination(hostname: string): boolean {
  const h = bare(hostname);
  if (isLoopbackHost(h) || h.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export class Forwarder {
  private server: Server | null = null;
  private readonly password = randomBytes(24).toString("base64url");
  private readonly resolve: (hostname: string) => Promise<readonly string[]>;

  constructor(private readonly opts: ForwarderOptions) {
    this.resolve = opts.resolve ?? systemResolve;
  }

  /** Listens (once) and answers what the browser is to be given. */
  async start(): Promise<ForwarderAddress> {
    if (!this.server) {
      const server = new Server({ port: 0, host: "127.0.0.1", verbose: false, prepareRequestFunction: (req) => this.prepare(req.hostname, req.port, req.password) });
      await server.listen();
      this.server = server;
    }
    return { server: `http://127.0.0.1:${this.server.port}`, username: USER, password: this.password };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.close(true);
  }

  /** Requests and tunnels asked for so far. */
  stats(): { readonly requests: number } {
    const s = this.server?.stats;
    return { requests: (s?.httpRequestCount ?? 0) + (s?.connectRequestCount ?? 0) };
  }

  /** `hostname:port` is one of AgentSwitch's own ports on this Mac. A name that cannot be resolved is not this Mac. */
  async isOwn(hostname: string, port: number): Promise<boolean> {
    if (!this.opts.ownPorts().includes(port)) return false;
    const h = bare(hostname);
    if (isLoopbackHost(h) || isLoopbackAddress(h)) return true;
    try { return (await this.resolve(h)).some(isLoopbackAddress); } catch { return false; }
  }

  private async prepare(hostname: string, port: number, password: string): Promise<{ requestAuthentication?: boolean; upstreamProxyUrl: string | null }> {
    if (password !== this.password) return { requestAuthentication: true, upstreamProxyUrl: null };
    if (await this.isOwn(hostname, port)) {
      this.opts.log?.("browser: a request to one of AgentSwitch's own ports was refused by the forwarder");
      throw new RequestError(OWN_PORT_REFUSAL, 403);
    }
    if (isLocalDestination(hostname)) return { upstreamProxyUrl: null };
    // A proxy that is set but cannot be used (its password not to be had): nothing leaves, not straight either.
    let upstream: string | null;
    try { upstream = this.opts.upstream?.() ?? null; } catch (err) { throw new RequestError((err as Error).message, 502); }
    return { upstreamProxyUrl: upstream };
  }
}
