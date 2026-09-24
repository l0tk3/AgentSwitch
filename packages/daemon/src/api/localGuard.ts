/** The 127.0.0.1 listener's guard against browsers. Any web page can make the browser send requests to 127.0.0.1, so a
 *  request reaches the local API only when
 *  - Host names this listener (127.0.0.1, localhost or [::1] on its own port): a DNS-rebinding page sends its own name;
 *  - Origin, when a browser sends one, is the web UI's own (http://127.0.0.1:<port> or http://localhost:<port>);
 *  - a POST/PUT/PATCH/DELETE with a body is JSON (multipart only for POST /uploads): form and text/plain bodies are what a
 *    cross-site page can send without a CORS preflight.
 *  The CLI, the Mac app and curl send no Origin and pass. The remote listener (app-v0 §2) hands its requests to the API
 *  in process and never comes through here. */

import type { IncomingHttpHeaders } from "node:http";

export type LocalRequest = {
  readonly method: string;
  readonly path: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly contentType: string | undefined;
  readonly hasBody: boolean;
};

export type LocalRefusal = { readonly status: 403 | 415; readonly error: string };

const STATE_CHANGING: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const JSON_TYPE = "application/json";
/** The one route that takes a multipart body (api/files.ts). */
const UPLOAD = { method: "POST", path: "/uploads", type: "multipart/form-data" } as const;

const mediaType = (value: string | undefined): string => (value ?? "").split(";")[0]!.trim().toLowerCase();

/** null when the request may go on, else why not. `port` is the one the request came in on. */
export function localRefusal(req: LocalRequest, port: number | undefined): LocalRefusal | null {
  const host = req.host?.trim().toLowerCase();
  if (!port || !host || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) {
    return { status: 403, error: "forbidden: the local API answers only to Host 127.0.0.1, localhost or [::1] on its own port" };
  }
  if (req.origin !== undefined && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.origin.trim().toLowerCase())) {
    return { status: 403, error: "forbidden: cross-origin request" };
  }
  if (STATE_CHANGING.has(req.method.toUpperCase()) && req.hasBody) {
    const type = mediaType(req.contentType);
    const upload = req.method.toUpperCase() === UPLOAD.method && req.path === UPLOAD.path && type === UPLOAD.type;
    if (type !== JSON_TYPE && !upload) return { status: 415, error: `request body must be ${JSON_TYPE}` };
  }
  return null;
}

/** The part of @hono/node-server's env (HTTP/1 or HTTP/2) the guard reads. */
type Incoming = { readonly method?: string | undefined; readonly headers: IncomingHttpHeaders; readonly socket: { readonly localPort?: number | undefined } };
type Env = { readonly incoming: Incoming };
type Fetch<E extends Env> = (request: Request, env: E) => Response | Promise<Response>;

/** What the guard looks at, from the raw request line and headers Node parsed (not the URL built from them). */
function describe(request: Request, env: Env): { req: LocalRequest; port: number | undefined } {
  const headers = env.incoming.headers;
  const length = headers["content-length"];
  return {
    req: {
      method: env.incoming.method ?? request.method,
      path: new URL(request.url).pathname,
      host: headers.host,
      origin: headers.origin,
      contentType: headers["content-type"],
      hasBody: headers["transfer-encoding"] !== undefined || (length !== undefined && Number(length) > 0),
    },
    port: env.incoming.socket.localPort,
  };
}

/** `fetch` behind the guard, for the 127.0.0.1 listener only. */
export function guardLocal<E extends Env>(fetch: Fetch<E>): Fetch<E> {
  return (request, env) => {
    const { req, port } = describe(request, env);
    const refusal = localRefusal(req, port);
    if (!refusal) return fetch(request, env);
    return new Response(JSON.stringify({ error: refusal.error }), { status: refusal.status, headers: { "content-type": "application/json" } });
  };
}
