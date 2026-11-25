/** Whether this node's gate runs as the system service (gate-simple-v0 §5) or as the login user, decided exactly as the
 *  gate decides it (secret-gate `service_paths.client_socket`): `gate-service.json` next to the public directory, which
 *  `secret-gate system install` writes as root and `uninstall` removes. Never by the socket: the rpc service removes it
 *  whenever it stops, and a keeper that started a gate of its own in that window would undo the isolation.
 *
 *  On Linux the service is installed with one `sudo` (`sudo …/secret-gate system install …`). Nothing here runs it: the
 *  keeper, `agentswitch doctor`, `agentswitch gate` and the Keys page print the exact command for the user to run. */

import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GATE_PUBLIC_DIR } from "../core/protected.js";
import type { Messages } from "../i18n/index.js";
import type { Layout, Ports } from "./plan.js";

export const SERVICE_CONFIG = "gate-service.json";

export type GateMode =
  /** The gate runs under its own account; this account reads only `publicDir` (keys.json, ca.pem, gate.sock). */
  | { readonly kind: "service"; readonly publicDir: string; readonly ca: string; readonly proxyPort: number | null; readonly ownerUid: number | null; readonly error?: string }
  /** The gate runs as the login user, its keys in its home: it guards against seeing a value by mistake only. */
  | { readonly kind: "user" };

/** `$SECRET_GATE_PUBLIC`, else the service's public directory on this system. */
export function gatePublicDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SECRET_GATE_PUBLIC || GATE_PUBLIC_DIR;
}

type Fs = { lstat: (p: string) => unknown; read: (p: string) => string };
const REAL_FS: Fs = { lstat: (p) => lstatSync(p), read: (p) => readFileSync(p, "utf8") };

/** The mode, from `<root>/gate-service.json`. A file that is there but cannot be checked or read counts as the service
 *  (fail closed: never a gate of the user's own beside an installed service), with `error` saying why. */
export function gateMode(env: NodeJS.ProcessEnv = process.env, fs: Fs = REAL_FS): GateMode {
  const publicDir = gatePublicDir(env);
  const config = join(dirname(publicDir), SERVICE_CONFIG);
  try { fs.lstat(config); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return { kind: "user" };
  }
  const base = { kind: "service" as const, publicDir, ca: join(publicDir, "ca.pem") };
  try {
    const raw = JSON.parse(fs.read(config)) as { proxyPort?: unknown; ownerUid?: unknown };
    const port = Number.isInteger(raw.proxyPort) && (raw.proxyPort as number) > 0 && (raw.proxyPort as number) < 65536 ? raw.proxyPort as number : null;
    const owner = Number.isInteger(raw.ownerUid) ? raw.ownerUid as number : null;
    return { ...base, proxyPort: port, ownerUid: owner, ...(port === null ? { error: `${config}: no valid proxyPort` } : {}) };
  } catch (e) {
    return { ...base, proxyPort: null, ownerUid: null, error: `${config}: ${(e as Error).message}` };
  }
}

/** A word of a shell command line, quoted when it has to be. */
const sh = (s: string): string => /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

export type GateCommands = { readonly install: string; readonly update: string; readonly rotateKey: string; readonly uninstall: string };

/** The exact `sudo` commands that manage the gate service with this node's runtime (null from a checkout: the service
 *  copies a built runtime, packages/linux/scripts/install.sh). `runtime` is copied by root into
 *  /opt/agentswitch/gate-runtime with the same hardening as on macOS; the units run only that copy. */
export function gateCommands(l: Layout, ports: Ports, uid: number): GateCommands | null {
  if (!l.runtime) return null;
  const gate = sh(l.gate), runtime = sh(l.runtime);
  return {
    install: `sudo ${gate} system install --owner-uid ${uid} --port ${ports.gate} --runtime ${runtime}`,
    update: `sudo ${gate} system update --runtime ${runtime}`,
    rotateKey: `sudo ${gate} system rotate-key`,
    uninstall: `sudo ${gate} system uninstall`,
  };
}

/** The proxy's port in this mode: the service's (gate-service.json), else node.json's. */
export function gatePort(mode: GateMode, ports: Ports): number {
  return mode.kind === "service" && mode.proxyPort ? mode.proxyPort : ports.gate;
}

/** `secret-gate system status --json` (no root needed): whether the service answers and its runtime is older than this
 *  node's. Null when it could not be asked. */
export type ServiceStatus = { readonly installed: boolean; readonly running: boolean; readonly updateAvailable: boolean; readonly error: string | null };

export type Exec = (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;

const realExec: Exec = (bin, args, env) => new Promise((done, fail) => {
  execFile(bin, [...args], { env, timeout: 15_000 }, (err, stdout) => (err && !stdout ? fail(err) : done(String(stdout))));
});

/** `secret-gate system status --json`, compared with the runtime that secret-gate is part of. */
export async function serviceStatus(gate: string, env: NodeJS.ProcessEnv = process.env, exec: Exec = realExec): Promise<ServiceStatus | null> {
  try { return parseServiceStatus(await exec(gate, ["system", "status", "--json"], env)); } catch { return null; }
}

/** What this node says about its gate, for doctor, `agentswitch gate` and the Keys page: the mode, and the command to
 *  run when there is one (install as the user; update or rotate-key with the service). */
export type GateReport = {
  readonly mode: GateMode;
  readonly status: ServiceStatus | null;
  readonly commands: GateCommands | null;
  /** The user mode is said on Linux only: a Mac's gate service is installed from the Mac app. */
  readonly platform: NodeJS.Platform;
};

export async function gateReport(input: { env?: NodeJS.ProcessEnv; layout: Layout; ports: Ports; uid: number; exec?: Exec }): Promise<GateReport> {
  const env = input.env ?? process.env;
  const mode = gateMode(env);
  const status = mode.kind === "service" ? await serviceStatus(input.layout.gate, env, input.exec) : null;
  return { mode, status, commands: gateCommands(input.layout, input.ports, input.uid), platform: process.platform };
}

/** The report as lines in the node's language: what the gate guards against, then the command to run (indented). */
export function reportLines(r: GateReport, t: Messages["gateMode"]): string[] {
  if (r.mode.kind === "service") {
    const lines = [t.service];
    if (r.status && !r.status.running) lines.push(t.notAnswering + (r.status.error ? ` (${r.status.error})` : ""));
    if (r.status?.updateAvailable && r.commands) lines.push(t.update, `  ${r.commands.update}`);
    if (r.commands) lines.push(t.rotate, `  ${r.commands.rotateKey}`);
    return lines;
  }
  if (r.platform !== "linux") return [];
  return [t.user, ...(r.commands ? [t.install, `  ${r.commands.install}`] : [t.noRuntime])];
}

export function parseServiceStatus(stdout: string): ServiceStatus | null {
  try {
    const r = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof r.installed !== "boolean" || typeof r.running !== "boolean") return null;
    return { installed: r.installed, running: r.running, updateAvailable: r.updateAvailable === true, error: typeof r.error === "string" ? r.error : null };
  } catch { return null; }
}
