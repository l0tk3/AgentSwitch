/** Whether the rules do what they are for, seen on the running core (docs/clash-v0.md §7.9): a connection to a known
 *  name is sent through the core's own proxy port, and the core is asked what it made of it — the rule it matched and
 *  the way out it took, node by node. A name the core rejects is cut off at once and never listed. For Claude and
 *  OpenAI the far end is asked as well where the connection came from (Cloudflare's trace on their own names).
 *
 *  Nothing of Clash's is changed; these are a few ordinary connections, as a browser's would be. */

import { request } from "node:http";
import { connect as tlsConnect } from "node:tls";
import type { ClashConnection } from "./controller.js";

export type Observed = {
  /** `proxied`: through a node; `direct`; `rejected`: cut off by a rule; `unknown`: the core listed nothing and did
   *  not cut it off (the node did not answer, or the core has no proxy port). */
  readonly outcome: "proxied" | "direct" | "rejected" | "unknown";
  /** The rule that matched, as the core names it (`RuleSet as-claude`, `DomainSuffix cn`, `Match`). */
  readonly rule: string | null;
  /** The way out, from the group the rule names down to the node (`Claude`, `Claude自动选择`, `日本家宽-02`). */
  readonly path: readonly string[];
  /** Where the far end saw it come from, where that was asked: an address and a country code. */
  readonly exit?: { readonly ip: string; readonly loc: string };
  /** How long the far end took to answer through it, ms, where it was asked. */
  readonly ms?: number;
};

export type CheckDeps = {
  /** The core's proxy port on this Mac. */
  readonly port: number;
  /** What the core has open now. */
  readonly connections: () => Promise<readonly ClashConnection[]>;
  /** How long to wait for the core to list the connection, ms. */
  readonly listMs?: number;
  /** Where a connection came from, asked of the far end through the open tunnel (tests give their own). */
  readonly trace?: (socket: import("node:net").Socket, host: string) => Promise<{ ip: string; loc: string } | null>;
};

const LIST_MS = 1_500, STEP_MS = 120, CUT_MS = 400, TRACE_MS = 6_000;

/** One connection to `host:port` through the core, and what the core made of it. `far`: ask the far end too. */
export function observe(deps: CheckDeps, host: string, port: number, far: boolean): Promise<Observed> {
  const target = `${host}:${port}`, started = Date.now();
  return new Promise((resolve) => {
    const nothing: Observed = { outcome: "unknown", rule: null, path: [] };
    const req = request({ host: "127.0.0.1", port: deps.port, method: "CONNECT", path: target, headers: { host: target }, timeout: 5_000 });
    req.on("error", () => resolve(nothing));
    req.on("timeout", () => { req.destroy(); resolve(nothing); });
    req.on("connect", (res, socket) => {
      let cut: number | null = null;
      socket.on("close", () => { cut ??= Date.now() - started; });
      socket.on("error", () => undefined);
      if (res.statusCode !== 200) { socket.destroy(); resolve(nothing); return; }
      void (async () => {
        let seen: ClashConnection | null = null;
        const until = Date.now() + (deps.listMs ?? LIST_MS);
        while (!seen && Date.now() < until) {
          await sleep(STEP_MS);
          const open = await deps.connections().catch(() => []);
          // This very connection, by the port it left from: an app of the user's may have one open to the same name.
          seen = open.find((c) => c.sourcePort === socket.localPort && c.port === port) ?? null;
          // Cut off at once and never listed: a rule rejected it.
          if (!seen && cut !== null && cut < CUT_MS) { resolve({ outcome: "rejected", rule: null, path: [] }); return; }
        }
        if (!seen) { socket.destroy(); resolve(nothing); return; }
        const path = [...seen.chains].reverse();
        const direct = path.length === 1 && path[0] === "DIRECT", rejected = /^REJECT/.test(path[path.length - 1] ?? "");
        const base: Observed = { outcome: rejected ? "rejected" : direct ? "direct" : "proxied", rule: [seen.rule, seen.payload].filter(Boolean).join(" ") || null, path };
        if (!far || rejected) { socket.destroy(); resolve(base); return; }
        const asked = Date.now();
        const exit = await Promise.race([(deps.trace ?? trace)(socket, host).catch(() => null), sleep(TRACE_MS).then(() => null)]);
        socket.destroy();
        resolve(exit ? { ...base, exit, ms: Date.now() - asked } : base);
      })();
    });
    req.end();
  });
}

/** Cloudflare's trace, asked over TLS through an open tunnel: the address and the country the far end saw. */
function trace(socket: import("node:net").Socket, host: string): Promise<{ ip: string; loc: string } | null> {
  return new Promise((resolve) => {
    const tls = tlsConnect({ socket, servername: host });
    let text = "";
    tls.setEncoding("utf8");
    tls.on("secureConnect", () => tls.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: curl/8.7.1\r\nAccept: */*\r\nConnection: close\r\n\r\n`));
    tls.on("data", (chunk: string) => { text += chunk; if (text.length > 16_384) tls.destroy(); });
    tls.on("error", () => resolve(parseTrace(text)));
    tls.on("close", () => resolve(parseTrace(text)));
  });
}

/** `ip=…` and `loc=…` out of a trace's answer. */
export function parseTrace(text: string): { ip: string; loc: string } | null {
  const ip = /^ip=([0-9a-fA-F:.]{3,45})\s*$/m.exec(text)?.[1], loc = /^loc=([A-Z]{2})\s*$/m.exec(text)?.[1];
  return ip ? { ip, loc: loc ?? "" } : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
