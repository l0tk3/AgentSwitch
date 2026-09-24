/** The remote HTTPS listener (app-v0 §2): node:https with the pinned self-signed certificate, on all interfaces
 *  (`::`, dual-stack; `0.0.0.0` where IPv6 is unavailable), sockets from outside the allowed networks destroyed at
 *  connection time before any TLS. Requests go to the remote app through @hono/node-server's request listener. */

import { getRequestListener, type HttpBindings } from "@hono/node-server";
import { createServer, type Server } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { guardConnection, isAllowedSource } from "./address.js";
import type { TlsMaterial } from "./tls.js";

export type RemoteListener = { readonly server: Server; readonly port: number; close(): Promise<void> };

export type ListenOptions = {
  readonly fetch: (request: Request, env: HttpBindings) => Response | Promise<Response>;
  readonly tls: Pick<TlsMaterial, "cert" | "key">;
  readonly port: number;
  /** Default `::` (falls back to 0.0.0.0); tests bind 127.0.0.1. */
  readonly host?: string;
  readonly allowSource?: (address: string | undefined) => boolean;
  readonly log?: (message: string) => void;
};

function bind(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (err: Error) => { server.off("listening", ok); reject(err); };
    const ok = () => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ok);
    server.listen(port, host);
  });
}

export async function listenRemote(opts: ListenOptions): Promise<RemoteListener> {
  const allow = opts.allowSource ?? isAllowedSource;
  const log = opts.log ?? console.error;
  const listener = getRequestListener(opts.fetch as Parameters<typeof getRequestListener>[0], {
    errorHandler: (err) => { log(`remote listener: ${(err as Error).message}`); return new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "content-type": "application/json" } }); },
  });
  const server = createServer({ key: opts.tls.key, cert: opts.tls.cert, minVersion: "TLSv1.2" }, listener);
  // Ahead of the TLS server's own listener: a refused socket never starts a handshake.
  server.prependListener("connection", (socket: Socket) => { guardConnection(socket, allow); });
  // Handshake failures (a refused socket, a scanner, a phone that does not pin this certificate) are not our errors.
  server.on("tlsClientError", (_err, socket) => socket.destroy());
  const host = opts.host ?? "::";
  try {
    await bind(server, opts.port, host);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (opts.host !== undefined || (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL")) throw err;
    await bind(server, opts.port, "0.0.0.0");
  }
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();   // open event streams would otherwise hold the close forever
    }),
  };
}
