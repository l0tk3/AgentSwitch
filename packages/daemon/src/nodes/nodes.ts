/** This node among the others (docs/mesh-v0.md): pairing with a node from its link, the way back of a pairing made
 *  with this one, and how the nodes it uses are doing. Every node is the same kind of thing; what differs is what it
 *  has, which it says itself (`GET /node`). */

import type { Devices } from "../remote/deviceStore.js";
import { normalizeCode, pairPayload, parsePairLink, type PairPayload } from "../remote/pairing.js";
import { macName, type RemoteRuntime } from "../remote/runtime.js";
import { peerView, rememberLan, type NodeBook, type Peer, type PeerView } from "./book.js";
import { dialable, type Dialer, type Reachable } from "./dial.js";

/** The other node holds its answer to a pairing while it pairs back; this is how long this one waits for both. */
const PAIR_TIMEOUT_MS = 20_000;
/** The way back, made inside the other node's own request. */
const BACK_TIMEOUT_MS = 8_000;
const TELL_TIMEOUT_MS = 5_000;
const ASK_TIMEOUT_MS = 4_000;
/** How long one look at the nodes serves every screen that asks. */
const STATUS_TTL_MS = 2_000;
/** What a node said of its Live Activity is listed beside this node's own for this long after it was heard. */
const LIVE_KEPT_MS = 10_000;
/** A node's clock is taken to stand as far from this one's as it was last measured, while a new measure is within this
 *  of the old: one answer is a little slower than the next, and a time that moved with it would name a new result. */
const CLOCK_SLACK_MS = 3_000;
/** A node's addresses, name and gate key are asked again this often while it answers. */
const LEARN_EVERY_MS = 5 * 60_000;

/** What a node says about itself: the screens of another node show only what it has, and word things by its kind. */
export type NodeInfo = {
  readonly name: string;
  readonly kind: "mac" | "linux";
  readonly version: string;
  /** Its user's home folder, so a path there can be shown as `~/…`. */
  readonly home: string;
  readonly has: readonly string[];
};

/** How the way back of a pairing ended: made, tried and failed, not taken by the other node, or not offered. */
export type BackOutcome = "paired" | "failed" | "declined" | "none";

export type Added =
  | { readonly ok: true; readonly node: PeerView; readonly back: BackOutcome }
  | { readonly ok: false; readonly status: 400 | 401 | 429 | 502; readonly error: string };

/** `revoked`: it answers, and no longer knows this node's device (removed there). */
/** What a node this one uses said its own Live Activity shows (`GET /live` there), as last heard. */
export type NodeLive = {
  readonly id: string; readonly name: string; readonly at: number; readonly body: Record<string, unknown>;
  /** How far this node's clock is ahead of that one's, by the `now` in its answers; absent while it sends none. */
  readonly ahead?: number;
};

/** How far apart two clocks are taken to be: as before (`held`) while the new measure is near it, else the new one. */
export function steadyAhead(held: number | undefined, measured: number): number {
  return held !== undefined && Math.abs(measured - held) <= CLOCK_SLACK_MS ? held : measured;
}

export type NodeStatus = PeerView & { readonly state: "online" | "offline" | "revoked"; readonly address: string | null; readonly waiting: number | null };

export type NodesOptions = {
  readonly book: NodeBook;
  readonly dialer: Dialer;
  readonly store: Devices;
  /** This node's own listener: without one it can use other nodes and cannot be used back. */
  readonly remote: RemoteRuntime | null;
  readonly info: () => NodeInfo;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

/** What this node is called in another's device list. */
export const nodePlatform = (): string => (process.platform === "darwin" ? "macos" : process.platform);

const reachable = (p: Pick<Peer, "fingerprint" | "port" | "last" | "lan" | "tailnet">): Reachable => ({ fingerprint: p.fingerprint, port: p.port, last: p.last, lan: p.lan, tailnet: p.tailnet });

export class Nodes {
  readonly book: NodeBook;
  readonly dialer: Dialer;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** Tickets sent with a pairing → the device the other node became here when it redeemed one. */
  private readonly ticketDevices = new Map<string, string>();
  private readonly learned = new Map<string, number>();
  private statusCache: { readonly at: number; readonly value: Promise<NodeStatus[]> } | null = null;
  /** Each node's last answer to `GET /live`, by its id (docs/mesh-v0.md §5.2 跨节点的提醒). */
  private readonly heard = new Map<string, NodeLive>();
  /** How far this node's clock is ahead of each node's, as last taken (`steadyAhead`). */
  private readonly ahead = new Map<string, number>();
  /** When `lives` was last read, and whether the nodes are being looked at for it. */
  private livesRead = 0;
  private looking = false;
  private closed = false;

  constructor(private readonly o: NodesOptions) {
    this.book = o.book;
    this.dialer = o.dialer;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? console.error;
  }

  info(): NodeInfo {
    return this.o.info();
  }

  /** This node as a row above the others. */
  self(): { readonly name: string; readonly kind: string; readonly fingerprint: string | null; readonly port: number | null; readonly listening: boolean } {
    const remote = this.o.remote;
    return { name: this.name(), kind: this.o.info().kind, fingerprint: remote?.tls.fingerprint ?? null, port: remote?.port ?? null, listening: !!remote };
  }

  private name(): string {
    return this.o.remote?.name ?? macName();
  }

  /** Pair with the node a link names, so this node can use it. `back`: offer this node in return, which makes the
   *  pair go both ways unless the other node does not take it. */
  async add(link: string, opts: { readonly back: boolean }): Promise<Added> {
    const payload = parsePairLink(link);
    if (!payload) return { ok: false, status: 400, error: "not a pairing link" };
    const remote = this.o.remote;
    if (remote && payload.fp === remote.tls.fingerprint) return { ok: false, status: 400, error: "this is this node's own pairing link" };
    const where: Reachable = { fingerprint: payload.fp, port: payload.port, last: null, lan: payload.lan, tailnet: payload.tailnet };
    const host = await this.dialer.reach(where, true);
    if (!host) return { ok: false, status: 502, error: `${payload.name} cannot be reached: ${await this.dialer.whyNot(where)}` };
    const ticket = opts.back && remote ? remote.pairing.issueTicket() : null;
    try {
      const own = ticket && remote ? await this.ownPayload(remote, ticket.code) : null;
      const r = await this.dialer.json({ host, port: payload.port, fingerprint: payload.fp }, "POST", "/pair", {
        json: { code: payload.code, name: this.name(), platform: nodePlatform(), ...(own ? { back: own } : {}) }, timeoutMs: PAIR_TIMEOUT_MS,
      });
      if (r.status === 401) return { ok: false, status: 401, error: "pairing failed: the code is wrong, used or expired" };
      if (r.status === 429) return { ok: false, status: 429, error: "too many pairing attempts; wait a minute" };
      const token = r.body.token;
      const deviceId = r.body.deviceId;
      if (r.status !== 200 || typeof token !== "string" || typeof deviceId !== "string") return { ok: false, status: 502, error: `${payload.name} answered ${r.status} to the pairing` };
      // A node that does not know the way back says nothing about it: not taken.
      const back: BackOutcome = !own ? "none" : r.body.back === "paired" ? "paired" : r.body.back === "failed" ? "failed" : "declined";
      const inbound = back === "paired" && ticket ? this.ticketDevices.get(normalizeCode(ticket.code) ?? "") ?? null : null;
      await this.retire(payload.fp, host);
      const peer = this.book.put({ name: payload.name, kind: null, port: payload.port, fingerprint: payload.fp, lan: payload.lan, tailnet: payload.tailnet, last: host, gate: payload.gate, deviceId, token, pairedAt: this.now(), inbound });
      this.statusCache = null;
      this.log(`nodes: paired with "${peer.name}" (${peer.id}) at ${host}; the way back: ${back}`);
      void this.learn(peer, host);
      return { ok: true, node: peerView(this.book.get(peer.id) ?? peer), back };
    } catch (err) {
      return { ok: false, status: 502, error: `${payload.name}: ${(err as Error).message}` };
    } finally {
      if (ticket && remote) {
        remote.pairing.voidTicket(ticket.code);
        this.ticketDevices.delete(normalizeCode(ticket.code) ?? "");
      }
    }
  }

  private async ownPayload(remote: RemoteRuntime, code: string): Promise<PairPayload> {
    const [addresses, gate] = await Promise.all([remote.addresses().catch(() => ({ lan: [], tailnet: [] })), remote.gateKey().catch(() => null)]);
    return pairPayload({ name: remote.name, port: remote.port, fp: remote.tls.fingerprint, code, lan: addresses.lan, tailnet: addresses.tailnet, gate }).payload;
  }

  /** A ticket of this node's was redeemed (remote/app.ts): the other node is that device here. */
  ticketUsed(code: string, deviceId: string): void {
    const raw = normalizeCode(code);
    if (raw) this.ticketDevices.set(raw, deviceId);
  }

  /** The way back of a pairing another node just made with this one: redeem the ticket it sent along, at the address
   *  it came from first. `inbound` is the device it became here. */
  async pairBack(payload: PairPayload, source: string | null, inbound: string): Promise<"paired" | "failed"> {
    const remote = this.o.remote;
    if (remote && payload.fp === remote.tls.fingerprint) return "failed";
    const where: Reachable = { fingerprint: payload.fp, port: payload.port, last: source && dialable(source) ? source : null, lan: payload.lan, tailnet: payload.tailnet };
    try {
      const host = await this.dialer.reach(where, true);
      if (!host) { this.log(`nodes: the way back to "${payload.name}" failed: ${await this.dialer.whyNot(where)}`); return "failed"; }
      const r = await this.dialer.json({ host, port: payload.port, fingerprint: payload.fp }, "POST", "/pair", { json: { code: payload.code, name: this.name(), platform: nodePlatform() }, timeoutMs: BACK_TIMEOUT_MS });
      const token = r.body.token;
      const deviceId = r.body.deviceId;
      if (r.status !== 200 || typeof token !== "string" || typeof deviceId !== "string") { this.log(`nodes: the way back to "${payload.name}" was answered ${r.status}`); return "failed"; }
      await this.retire(payload.fp, host);
      const peer = this.book.put({ name: payload.name, kind: null, port: payload.port, fingerprint: payload.fp, lan: payload.lan, tailnet: payload.tailnet, last: host, gate: payload.gate, deviceId, token, pairedAt: this.now(), inbound });
      this.statusCache = null;
      this.log(`nodes: paired back with "${peer.name}" (${peer.id}) at ${host}`);
      void this.learn(peer, host);
      return "paired";
    } catch (err) {
      this.log(`nodes: the way back to "${payload.name}" failed: ${(err as Error).message}`);
      return "failed";
    }
  }

  /** A node paired again has a new device there: the one this node had before is removed there, so it does not stay in
   *  that node's list as a device that will never come back. */
  private async retire(fingerprint: string, host: string): Promise<void> {
    const before = this.book.list().find((p) => p.fingerprint === fingerprint);
    if (!before) return;
    await this.dialer.json({ host, port: before.port, fingerprint }, "DELETE", "/me", { token: before.token, timeoutMs: TELL_TIMEOUT_MS }).catch(() => undefined);
  }

  /** Stop using a node: it is asked to revoke this node's device there (which it does when it can be reached), and
   *  what was kept of it here is deleted. `both`: its device here is revoked as well, so neither uses the other. */
  async remove(idOrName: string, opts: { readonly both: boolean }): Promise<{ readonly node: PeerView; readonly told: boolean; readonly inboundRevoked: boolean } | null> {
    const peer = this.book.get(idOrName);
    if (!peer) return null;
    const host = await this.dialer.reach(reachable(peer)).catch(() => null);
    const told = host
      ? await this.dialer.json({ host, port: peer.port, fingerprint: peer.fingerprint }, "DELETE", "/me", { token: peer.token, timeoutMs: TELL_TIMEOUT_MS }).then((r) => r.status === 200, () => false)
      : false;
    this.book.remove(peer.id);
    this.dialer.drop(peer.fingerprint);
    this.learned.delete(peer.id);
    this.heard.delete(peer.id);
    this.ahead.delete(peer.id);
    this.statusCache = null;
    let inboundRevoked = false;
    if (opts.both && peer.inbound) {
      inboundRevoked = !!this.o.store.revokeDevice(peer.inbound);
      this.o.remote?.presence.disconnect(peer.inbound);
    }
    this.log(`nodes: removed "${peer.name}" (${peer.id}); told there: ${told}${inboundRevoked ? "; its device here revoked" : ""}`);
    return { node: peerView(peer), told, inboundRevoked };
  }

  /** A device here is revoked: when it was a node's, that node no longer uses this one. */
  inboundGone(deviceId: string): void {
    this.book.inboundGone(deviceId);
    this.statusCache = null;
  }

  /** How the nodes this one uses are doing, each asked at once; one look serves every caller for `STATUS_TTL_MS`. */
  statuses(): Promise<NodeStatus[]> {
    const cached = this.statusCache;
    if (cached && this.now() - cached.at < STATUS_TTL_MS) return cached.value;
    const value = Promise.all(this.book.list().map((peer) => this.status(peer)));
    this.statusCache = { at: this.now(), value };
    return value;
  }

  /** What the nodes this one uses said last of their own Live Activity, without waiting for any of them: this node's
   *  `GET /live` is read every second and must not hang on a node that is slow or gone. While it is being read the
   *  nodes are looked at every `STATUS_TTL_MS` by themselves (`keepLooking`), so what is told is that fresh whenever
   *  it is asked for; an answer older than `LIVE_KEPT_MS` is no longer told. */
  lives(): NodeLive[] {
    this.livesRead = this.now();
    this.keepLooking();
    const since = this.now() - LIVE_KEPT_MS;
    return this.book.list().flatMap((peer) => { const live = this.heard.get(peer.id); return live && live.at >= since ? [live] : []; });
  }

  /** A look at the nodes now and again every `STATUS_TTL_MS`, for as long as `lives` was read lately; nothing while
   *  this node uses no node, or nobody reads. */
  private keepLooking(): void {
    if (this.looking || !this.book.list().length) return;
    this.looking = true;
    const look = (): void => {
      if (this.closed || this.now() - this.livesRead > LIVE_KEPT_MS || !this.book.list().length) { this.looking = false; return; }
      void this.statuses().catch(() => undefined).finally(() => { setTimeout(look, STATUS_TTL_MS).unref(); });
    };
    look();
  }

  private async status(peer: Peer): Promise<NodeStatus> {
    const host = await this.dialer.reach(reachable(peer)).catch(() => null);
    if (!host) { this.heard.delete(peer.id); return { ...peerView(peer), state: "offline", address: null, waiting: null }; }
    const target = { host, port: peer.port, fingerprint: peer.fingerprint };
    // What waits for the user there, by the count the node's own Live Activity shows; a node that does not offer it
    // (404) still says whether it knows this device.
    const live = await this.dialer.json(target, "GET", "/live", { token: peer.token, timeoutMs: ASK_TIMEOUT_MS }).catch(() => null);
    if (!live) { this.dialer.forget(peer.fingerprint); this.heard.delete(peer.id); return { ...peerView(peer), state: "offline", address: null, waiting: null }; }
    if (live.status === 401) { this.heard.delete(peer.id); return { ...peerView(peer), state: "revoked", address: host, waiting: null }; }
    const now = this.book.patch(peer.id, { last: host }) ?? peer;
    if (live.status === 200) this.heard.set(peer.id, this.hear(now, live.body)); else this.heard.delete(peer.id);
    void this.learn(now, host);
    return { ...peerView(now), state: "online", address: host, waiting: live.status === 200 && typeof live.body.waiting === "number" ? live.body.waiting : null };
  }

  /** A node's answer to `GET /live` as kept: with how far its clock stands from this one's, held steady from one
   *  answer to the next (`steadyAhead`) and through a gap in them. */
  private hear(peer: Peer, body: Record<string, unknown>): NodeLive {
    const at = this.now();
    const theirs = body.now;
    if (typeof theirs !== "number" || !Number.isFinite(theirs)) return { id: peer.id, name: peer.name, at, body };
    const ahead = steadyAhead(this.ahead.get(peer.id), at - theirs);
    this.ahead.set(peer.id, ahead);
    return { id: peer.id, name: peer.name, at, body, ahead };
  }

  /** What a node says of itself, asked when it is paired and every `LEARN_EVERY_MS` after: its name and kind, where it
   *  is now, its gate's key. Each answer is kept on its own; none is needed for the node to be used. */
  private async learn(peer: Peer, host: string): Promise<void> {
    const last = this.learned.get(peer.id);
    if (last !== undefined && this.now() - last < LEARN_EVERY_MS) return;
    this.learned.set(peer.id, this.now());
    const target = { host, port: peer.port, fingerprint: peer.fingerprint };
    const ask = (path: string) => this.dialer.json(target, "GET", path, { token: peer.token, timeoutMs: ASK_TIMEOUT_MS }).then((r) => (r.status === 200 ? r.body : null), () => null);
    const [node, addresses, gate] = await Promise.all([ask("/node"), ask("/addresses"), ask("/gate/pubkey")]);
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && dialable(x)).slice(0, 16) : []);
    const tailnet = strings(addresses?.tailnet);
    this.book.patch(peer.id, {
      ...(node && typeof node.name === "string" && node.name.trim() ? { name: node.name.trim().slice(0, 64) } : {}),
      ...(node && (node.kind === "mac" || node.kind === "linux") ? { kind: node.kind } : {}),
      ...(addresses ? { lan: rememberLan(strings(addresses.lan), peer.lan), ...(tailnet.length ? { tailnet } : {}) } : {}),
      ...(gate && typeof gate.publicKey === "string" && typeof gate.keypair === "string" ? { gate: { publicKey: gate.publicKey, keypair: gate.keypair } } : {}),
    });
    this.statusCache = null;
  }

  close(): void {
    this.closed = true;
    this.dialer.close();
  }
}
