/** The other nodes, from this node's own screens (docs/mesh-v0.md §5.2). On the 127.0.0.1 listener only — the remote
 *  list names none of this, so a node paired with this one cannot go on through it to a third.
 *
 *  `GET /nodes` lists them; `POST /nodes` pairs with one from its link; `DELETE /nodes/:id` stops using one; and
 *  `/nodes/:id/<route>` is that node's `<route>`: the request goes to its remote listener as it is, on a connection
 *  held to its certificate, with this node's device token in place of whatever the caller showed, and the answer comes
 *  back as it is — event streams and pictures included. What that node lets a paired node do is its own list's to say.
 *
 *  Pairing, removing and using a node take the nodes key as well as the local token (nodes/book.ts). */

import type { Context, Hono } from "hono";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { z } from "zod";
import { NODES_KEY_HEADER, type Peer } from "../nodes/book.js";
import type { Nodes } from "../nodes/nodes.js";
import { loadMesh, saveMesh } from "../nodes/settings.js";
import { issues } from "./shared.js";

/** On every answer that came through another node: its id. */
export const NODE_HEADER = "x-agentswitch-node";
/** On an answer the node did not give itself: `unreachable` (502), or `revoked` (401: it no longer knows this node). */
export const NODE_ERROR_HEADER = "x-agentswitch-node-error";

const NEEDS_KEY = { error: `the nodes key is needed (${NODES_KEY_HEADER})` } as const;
/** What a caller's request carries on to the node. Its `Authorization` is this node's own token and stays here. */
const REQUEST_HEADERS = ["accept", "content-type", "content-length", "if-none-match", "range", "last-event-id"] as const;
const RESPONSE_HEADERS = ["content-type", "content-length", "etag", "cache-control", "content-disposition", "last-modified", "retry-after", "accept-ranges", "content-range"] as const;
/** Until the node starts to answer; with something sent along (JSON) longer. */
const HEAD_TIMEOUT_MS = 30_000;
const UPLOAD_HEAD_TIMEOUT_MS = 120_000;
/** A file sent along (multipart, read whole by the node before it answers) may take as long as it keeps moving: this
 *  long standing still ends it, and its answer has what any request has (`HEAD_TIMEOUT_MS`) from its last byte — which
 *  is "handed to the system", so what is still on its way over a slow link is inside that wait. Until 2026-10-11 a file
 *  had the 120 s whatever happened, and one sent into a link that had just gone quiet without closing — the other Mac
 *  asleep, a Wi-Fi left — waited all of them (measured with scripts/mesh_upload_probe.ts; user: 粘贴图片有的时候卡半天). */
const FILE_STALL_MS = 15_000;
const FILE_LONGEST_MS = 15 * 60_000;

const AddBody = z.object({ link: z.string().min(1).max(8192), back: z.boolean().optional() });
/** Any of the switches; what is not named stays as it is (an older screen that knows only `keyboard` leaves the rest). */
const MeshBody = z.object({ keyboard: z.boolean().optional(), files: z.boolean().optional(), changes: z.boolean().optional(), tools: z.boolean().optional() })
  .refine((b) => b.keyboard !== undefined || b.files !== undefined || b.changes !== undefined || b.tools !== undefined, "keyboard, files, changes or tools");

export type NodesApiDeps = { readonly nodes: Nodes; readonly home: string };

export function mountNodes<A extends Hono>(app: A, deps: NodesApiDeps): A {
  const { nodes, home } = deps;
  const keyed = (c: Context): boolean => nodes.book.holdsKey(c.req.header(NODES_KEY_HEADER));

  app.get("/node", (c) => c.json(nodes.info()));

  app.get("/nodes", async (c) => c.json({ self: nodes.self(), nodes: await nodes.statuses() }));

  app.post("/nodes", async (c) => {
    if (!keyed(c)) return c.json(NEEDS_KEY, 403);
    const body = AddBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const added = await nodes.add(body.data.link, { back: body.data.back ?? true });
    return added.ok ? c.json({ ok: true, node: added.node, back: added.back }) : c.json({ error: added.error }, added.status);
  });

  app.delete("/nodes/:id", async (c) => {
    if (!keyed(c)) return c.json(NEEDS_KEY, 403);
    const removed = await nodes.remove(c.req.param("id"), { both: c.req.query("both") === "1" });
    return removed ? c.json({ ok: true, ...removed }) : c.json({ error: "not found" }, 404);
  });

  // What paired nodes may do here beyond the list's own rules; this node's own to set.
  // The devices' own scopes are told with the devices (`GET /devices`), not here.
  const switches = () => { const m = loadMesh(home); return { keyboard: m.keyboard, files: m.files, changes: m.changes, tools: m.tools }; };
  app.get("/settings/mesh", (c) => c.json(switches()));
  app.put("/settings/mesh", async (c) => {
    const body = MeshBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const now = loadMesh(home);
    const set = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined));
    saveMesh(home, { ...now, ...set });
    return c.json(switches());
  });

  app.all("/nodes/:id/*", async (c) => {
    if (!keyed(c)) return c.json(NEEDS_KEY, 403);
    const peer = nodes.book.get(c.req.param("id"));
    if (!peer) return c.json({ error: "not found" }, 404);
    return forward(c, nodes, peer);
  });
  return app;
}

async function forward(c: Context, nodes: Nodes, peer: Peer): Promise<Response> {
  const url = new URL(c.req.url);
  const method = c.req.method.toUpperCase();
  // The rest of the path as it was written (a node named by a name with a space in it is `%20` here, not in the param).
  const afterNodes = url.pathname.slice("/nodes/".length);
  const path = afterNodes.slice(afterNodes.indexOf("/")) + url.search;
  const headers: Record<string, string> = { authorization: `Bearer ${peer.token}` };
  for (const name of REQUEST_HEADERS) { const v = c.req.header(name); if (v !== undefined) headers[name] = v; }
  const raw = method === "GET" || method === "HEAD" ? null : c.req.raw.body;
  const body = raw ? Readable.fromWeb(raw as unknown as NodeWebStream<Uint8Array>) : null;
  const unreachable = (why: string): Response => c.json({ error: `${peer.name} cannot be reached: ${why}`, node: peer.id }, 502, { [NODE_HEADER]: peer.id, [NODE_ERROR_HEADER]: "unreachable" });
  const where = { fingerprint: peer.fingerprint, port: peer.port, last: peer.last, lan: peer.lan, tailnet: peer.tailnet };
  // A file on its way (a reply's attachments, or one sent into a folder, docs/files-v0.md §12.8) may take long.
  const type = (c.req.header("content-type") ?? "").trim().toLowerCase();
  const file = body !== null && (type.startsWith("multipart/form-data") || type.startsWith("application/octet-stream"));
  const waits = file ? { headTimeoutMs: FILE_LONGEST_MS, stallTimeoutMs: FILE_STALL_MS, answerTimeoutMs: HEAD_TIMEOUT_MS }
    : { headTimeoutMs: body ? UPLOAD_HEAD_TIMEOUT_MS : HEAD_TIMEOUT_MS };
  const ask = async (fresh: boolean) => {
    const host = await nodes.dialer.reach(where, fresh);
    return host ? nodes.dialer.send({ host, port: peer.port, fingerprint: peer.fingerprint }, { method, path, headers, body, signal: c.req.raw.signal, ...waits }) : null;
  };
  let res;
  try {
    res = await ask(false);
  } catch (err) {
    nodes.dialer.forget(peer.fingerprint);
    // The address that answered a moment ago may be the one it just left: a request that sent nothing of its own is
    // asked once more, wherever the node answers now.
    if (body || c.req.raw.signal.aborted) return unreachable((err as Error).message);
    try { res = await ask(true); } catch (again) { nodes.dialer.forget(peer.fingerprint); return unreachable((again as Error).message); }
  }
  if (!res) return unreachable(await nodes.dialer.whyNot(where));
  const status = res.statusCode ?? 502;
  const out = new Headers({ [NODE_HEADER]: peer.id });
  for (const name of RESPONSE_HEADERS) { const v = res.headers[name]; if (typeof v === "string") out.set(name, v); }
  if (status === 401) {
    res.resume();
    out.delete("content-length");
    out.set("content-type", "application/json");
    out.set(NODE_ERROR_HEADER, "revoked");
    return new Response(JSON.stringify({ error: `${peer.name} no longer knows this node; pair with it again`, node: peer.id }), { status: 401, headers: out });
  }
  if (method === "HEAD" || status === 204 || status === 304) { res.resume(); return new Response(null, { status, headers: out }); }
  return new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, { status, headers: out });
}
