/** Tailscale addresses for the pairing payload (app-v0 §2 配对: `tailnet`): `tailscale ip -4` plus the MagicDNS name
 *  from `tailscale status --json`. Not installed, not running or not logged in → []. The command runner is injectable. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isIPv4 } from "node:net";
import { which } from "../util/which.js";

/** The CLI inside the Mac App Store / standalone app, when `tailscale` is not on PATH. */
export const TAILSCALE_APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
/** One CLI call; the daemon never waits longer than this for an address list. */
const TAILSCALE_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Runs the CLI with args and resolves stdout; rejects on a non-zero exit, a timeout or a missing binary. */
export type CommandRunner = (bin: string, args: readonly string[]) => Promise<string>;

export const execRunner: CommandRunner = (bin, args) => new Promise((resolve, reject) => {
  // Started from Finder there is no TERM, and the app bundle's binary then opens the GUI instead of acting as the CLI.
  execFile(bin, [...args], { timeout: TAILSCALE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, TAILSCALE_BE_CLI: "1" } },
    (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

/** The tailscale CLI: `tailscale` on PATH, else the app bundle's binary when it exists, else null. */
export function tailscaleBin(env: NodeJS.ProcessEnv = process.env, appBin: string = TAILSCALE_APP_BIN, exists: (path: string) => boolean = existsSync): string | null {
  return which("tailscale", env.PATH) ?? (exists(appBin) ? appBin : null);
}

/** `Self.DNSName` without its trailing dot, only while the backend is running (logged in). */
export function parseStatus(json: string): { readonly running: boolean; readonly dnsName: string | null } {
  try {
    const status = JSON.parse(json) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    const running = status.BackendState === "Running";
    const name = typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : "";
    return { running, dnsName: running && name ? name : null };
  } catch {
    return { running: false, dnsName: null };
  }
}

/** IPv4 lines of `tailscale ip -4`. */
export function parseIps(stdout: string): string[] {
  return stdout.split(/\s+/).map((s) => s.trim()).filter((s) => isIPv4(s));
}

/** Tailnet IPv4 addresses then the MagicDNS name; [] when there is no CLI or the node is not logged in. */
export async function tailnetAddresses(bin: string | null = tailscaleBin(), run: CommandRunner = execRunner): Promise<string[]> {
  if (!bin) return [];
  const status = await run(bin, ["status", "--json"]).then(parseStatus, () => ({ running: false, dnsName: null }));
  if (!status.running) return [];
  const ips = await run(bin, ["ip", "-4"]).then(parseIps, () => [] as string[]);
  return [...new Set([...ips, ...(status.dnsName ? [status.dnsName] : [])])];
}
