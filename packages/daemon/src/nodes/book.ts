/** The other nodes this one uses (docs/mesh-v0.md §2.4): for each, where it is, the certificate it is pinned to, this
 *  node's device there and that device's token. In `$AGENTSWITCH_HOME/nodes/` (0700, files 0600), which agents may not
 *  read — in the terminals too (executors/protected.ts): a token here runs commands on another machine.
 *
 *  Beside it, the nodes key. The routes that act on another node ask for it as well as the local token (api/nodes.ts):
 *  a terminal's agent can read the local token (a terminal is used like any terminal), and that alone must not reach
 *  the next machine. */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NODES_DIR } from "../core/protected.js";
import type { GateKey } from "../remote/pairing.js";

/** Under `$AGENTSWITCH_HOME`; executors/protected.ts keeps the name, with the other places no agent reads. */
export { NODES_DIR };
const PEERS_FILE = "peers.json";
const KEY_FILE = "key";
const KEY_BYTES = 32;
const MIN_KEY_CHARS = 40;
/** The header the acting routes read the nodes key from. */
export const NODES_KEY_HEADER = "x-agentswitch-nodes";
/** Characters of the fingerprint that name a node in a path. */
const ID_CHARS = 12;
/** LAN addresses kept for a node: its current ones first, then where it was before (it comes back to those networks). */
export const REMEMBERED_LAN = 8;

export type Peer = {
  /** The start of its fingerprint: what `/nodes/<id>/…` names it by. */
  readonly id: string;
  readonly name: string;
  /** `mac` | `linux` as it says itself (`GET /node`); null until asked, or for a node that does not say. */
  readonly kind: string | null;
  readonly port: number;
  /** SHA-256 of its certificate's DER, lowercase hex: every connection to it is held to this. */
  readonly fingerprint: string;
  readonly lan: readonly string[];
  readonly tailnet: readonly string[];
  /** The address that last answered. */
  readonly last: string | null;
  readonly gate: GateKey | null;
  /** This node's device there, and its token. */
  readonly deviceId: string;
  readonly token: string;
  readonly pairedAt: number;
  /** That node's device here, when the pairing went both ways: the other direction of the same pair. */
  readonly inbound: string | null;
};

/** A peer as the screens see it: everything but the token. */
export type PeerView = Omit<Peer, "token">;

export const peerView = (peer: Peer): PeerView => {
  const { token: _token, ...view } = peer;
  return view;
};

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class NodeBook {
  private peers: Peer[];
  private readonly secret: string;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.peers = this.load();
    this.secret = this.ensureKey();
  }

  private load(): Peer[] {
    const path = join(this.dir, PEERS_FILE);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { peers?: unknown };
      return Array.isArray(parsed.peers) ? (parsed.peers as Peer[]).filter((p) => typeof p?.fingerprint === "string" && typeof p?.token === "string") : [];
    } catch { return []; }
  }

  private save(): void {
    const path = join(this.dir, PEERS_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ peers: this.peers }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  private ensureKey(): string {
    const path = join(this.dir, KEY_FILE);
    const existing = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (existing.length >= MIN_KEY_CHARS) return existing;
    const key = randomBytes(KEY_BYTES).toString("base64url");
    writeFileSync(path, `${key}\n`, { mode: 0o600 });
    return key;
  }

  /** True when `given` is the nodes key. */
  holdsKey(given: string | undefined | null): boolean {
    return !!given && same(given.trim(), this.secret);
  }

  list(): readonly Peer[] {
    return this.peers;
  }

  /** By id, or by name when exactly one node has it (the command line's `--on <name>`). */
  get(idOrName: string): Peer | undefined {
    const byId = this.peers.find((p) => p.id === idOrName);
    if (byId) return byId;
    const named = this.peers.filter((p) => p.name.toLowerCase() === idOrName.toLowerCase());
    return named.length === 1 ? named[0] : undefined;
  }

  /** A node paired now. One with the same certificate is the same node paired again: the new token and addresses
   *  replace the old, and the other direction is kept unless this pairing brings its own. */
  put(peer: Omit<Peer, "id">): Peer {
    const before = this.peers.find((p) => p.fingerprint === peer.fingerprint);
    const taken = new Set(this.peers.filter((p) => p !== before).map((p) => p.id));
    let chars = ID_CHARS;
    while (taken.has(peer.fingerprint.slice(0, chars)) && chars < peer.fingerprint.length) chars += 4;
    const next: Peer = { ...peer, id: before?.id ?? peer.fingerprint.slice(0, chars), inbound: peer.inbound ?? before?.inbound ?? null };
    this.peers = [...this.peers.filter((p) => p !== before), next];
    this.save();
    return next;
  }

  patch(id: string, changes: Partial<Pick<Peer, "name" | "kind" | "lan" | "tailnet" | "last" | "gate" | "inbound">>): Peer | undefined {
    const before = this.peers.find((p) => p.id === id);
    if (!before) return undefined;
    const next: Peer = { ...before, ...changes };
    if (JSON.stringify(next) === JSON.stringify(before)) return before;
    this.peers = this.peers.map((p) => (p === before ? next : p));
    this.save();
    return next;
  }

  remove(id: string): Peer | undefined {
    const gone = this.peers.find((p) => p.id === id);
    if (!gone) return undefined;
    this.peers = this.peers.filter((p) => p !== gone);
    this.save();
    return gone;
  }

  /** A device here was revoked: the node it belonged to no longer uses this one, whichever side said so. */
  inboundGone(deviceId: string): void {
    for (const p of this.peers.filter((x) => x.inbound === deviceId)) this.patch(p.id, { inbound: null });
  }
}

/** The nodes key for this node's own command line, or null when the service has not made one yet. */
export function readNodesKey(home: string): string | null {
  try { return readFileSync(join(home, NODES_DIR, KEY_FILE), "utf8").trim() || null; } catch { return null; }
}

/** A node's LAN addresses after it reported them: the current ones first, the earlier ones kept behind, at most
 *  `REMEMBERED_LAN`. An empty report keeps what there was. */
export function rememberLan(current: readonly string[], before: readonly string[]): string[] {
  return current.length ? [...new Set([...current, ...before])].slice(0, REMEMBERED_LAN) : [...before];
}
