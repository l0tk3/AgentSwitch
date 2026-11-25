/** What the remote side keeps while the daemon runs (app-v0 §2): certificate, pairing desk, open-request presence,
 *  address discovery and the gate key reader, shared by the local management routes and the HTTPS listener. */

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Gate } from "../core/gateBin.js";
import { ADDRESS_LIMIT, lanAddresses, lanOverride, overlayAddresses } from "./address.js";
import { Presence } from "./devices.js";
import { gateKeyReader, type GateKeyReader } from "./gateKey.js";
import { PairingDesk } from "./pairing.js";
import { tailnetAddresses } from "./tailscale.js";
import { ensureTls, type TlsMaterial } from "./tls.js";

export const DEFAULT_REMOTE_PORT = 4713;
const SCUTIL = "/usr/sbin/scutil";
const SCUTIL_TIMEOUT_MS = 2_000;

export type Addresses = { readonly lan: readonly string[]; readonly tailnet: readonly string[] };

export type RemoteRuntime = {
  readonly port: number;
  /** The Mac's name in the payload; the Bonjour name is "AgentSwitch on <name>". */
  readonly name: string;
  readonly tls: TlsMaterial;
  readonly pairing: PairingDesk;
  readonly presence: Presence;
  readonly gateKey: GateKeyReader;
  readonly addresses: () => Promise<Addresses>;
};

/** The name Finder shows (`scutil --get ComputerName`), else the host name without `.local`. */
export function macName(run: () => string = () => execFileSync(SCUTIL, ["--get", "ComputerName"], { encoding: "utf8", timeout: SCUTIL_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] })): string {
  try {
    const name = run().trim();
    if (name) return name;
  } catch { /* not macOS, or no ComputerName: fall through */ }
  return hostname().replace(/\.local$/, "");
}

/** LAN from the interface table (or `AGENTSWITCH_LAN`, mesh-v0 §4.7), the overlay from Tailscale's CLI and any other
 *  100.64/10 interface (NetBird, Headscale); each side fails to [] on its own. */
export async function discoverAddresses(env: NodeJS.ProcessEnv = process.env): Promise<Addresses> {
  const tailscale = await tailnetAddresses().catch(() => [] as string[]);
  const lan = lanOverride(env.AGENTSWITCH_LAN) ?? lanAddresses();
  const tailnet = [...new Set([...tailscale, ...overlayAddresses()])].filter((a) => !lan.includes(a)).slice(0, ADDRESS_LIMIT);
  return { lan, tailnet };
}

export type RemoteRuntimeOptions = {
  readonly home: string;
  readonly port: number;
  readonly name?: string;
  readonly gate: () => Gate | null;
  readonly tls?: TlsMaterial;
  readonly addresses?: () => Promise<Addresses>;
  readonly gateKey?: GateKeyReader;
  readonly pairing?: PairingDesk;
};

/** Certificate from $AGENTSWITCH_HOME/remote (generated on first start), everything else fresh. */
export function remoteRuntime(opts: RemoteRuntimeOptions): RemoteRuntime {
  return {
    port: opts.port,
    name: opts.name?.trim() || macName(),
    tls: opts.tls ?? ensureTls(join(opts.home, "remote")),
    pairing: opts.pairing ?? new PairingDesk(),
    presence: new Presence(),
    gateKey: opts.gateKey ?? gateKeyReader(opts.gate),
    addresses: opts.addresses ?? discoverAddresses,
  };
}
