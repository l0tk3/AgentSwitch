/** The daemon's end of a terminal's holder (native/pty-hold.c, docs/terminal-v0.md §10): the program runs on a pty that
 *  a small process of its own holds, outside the service, so that it outlives a restart. `startHeld` starts a holder
 *  and connects; `attachHeld` connects to one a daemon before this one started. Either gives a `HeldPty`, which the
 *  terminal host uses as it uses node-pty's: data, exit, write, resize, kill — and, unlike node-pty's, `detach`, the
 *  service going while the program stays.
 *
 *  On Linux under systemd the holder is started in a scope of its own (`systemd-run --user --scope`, in
 *  `agentswitch-terminals.slice`): outside `agentswitch.service`'s cgroup, which a restart stops whole, and with its
 *  own memory (one terminal's runaway job is the only one the kernel's OOM killer takes). */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

/** The protocol this end speaks (pty-hold.c VERSION); a holder may answer with an older one, which this end also
 *  speaks: versions only grow. */
export const HOLD_VERSION = 1;
const MAGIC = "agentswitch-pty-hold 1";
const T = { hello: 1, input: 2, resize: 3, signal: 4, collect: 5, welcome: 0x81, data: 0x82, exit: 0x83, error: 0x84 } as const;
/** A Unix socket's path is short (104 bytes on macOS, 108 on Linux, with the NUL). */
export const MAX_SOCKET_PATH = 100;
const START_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** One INPUT frame at most; more is sent as several. */
const INPUT_CHUNK = 256 * 1024;
export const SLICE = "agentswitch-terminals.slice";

/** The holder next to this module's package: native/build/pty-hold, from src/terminals and from dist/terminals alike. */
export const HOLDER_BINARY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "build", "pty-hold");

export type HeldSpec = {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  /** Output kept for the next daemon (docs/terminal-v0.md §2: as much as a terminal's buffer). */
  readonly ringBytes: number;
};

/** Where a holder is reached: its socket and the token it asks for. */
export type HoldPlace = { readonly socket: string; readonly token: string };

export type HeldExit = { readonly exitCode: number; readonly signal: number };

/** How holders are started on this machine. */
export type Holding = {
  readonly binary: string;
  /** systemd-run's scope (Linux under systemd); false: started detached, in a session of its own. */
  readonly scope: boolean;
  readonly ringBytes: number;
};

/** Holding on this machine, or null when there is no holder (an unbuilt checkout). `scope`: asked of systemd-run. */
export function holding(o: { binary?: string; ringBytes: number; env?: NodeJS.ProcessEnv }): Holding | null {
  const binary = o.binary ?? HOLDER_BINARY;
  if (!existsSync(binary)) return null;
  const env = o.env ?? process.env;
  const scope = process.platform === "linux" && Boolean(env.XDG_RUNTIME_DIR) && spawnSync("systemd-run", ["--user", "--version"], { stdio: "ignore", env }).status === 0;
  return { binary, scope, ringBytes: o.ringBytes };
}

/** The spec on the holder's stdin: fields ended by NUL (pty-hold.c). */
export function specBytes(token: string, s: HeldSpec): Buffer {
  const env = Object.entries(s.env).filter(([k, v]) => k && !k.includes("=") && !k.includes("\0") && !v.includes("\0")).map(([k, v]) => `${k}=${v}`);
  const argv = [s.file, ...s.args];
  const fields = [MAGIC, token, String(s.cols), String(s.rows), String(s.ringBytes), s.cwd, s.file, String(argv.length), ...argv, String(env.length), ...env];
  if (fields.some((f) => f.includes("\0"))) throw new Error("a NUL in the program's arguments");
  return Buffer.from(fields.map((f) => `${f}\0`).join(""), "utf8");
}

const frame = (type: number, payload: Buffer = Buffer.alloc(0)): Buffer => {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};

export class HoldError extends Error {}

/** A program on a held pty, as the terminal host uses it. Data and exit that come before a listener is there wait for it. */
export class HeldPty {
  pid = 0;
  /** The protocol the holder and this end agreed on. */
  version = HOLD_VERSION;
  /** The next output offset expected: where a later daemon would ask to be sent from. */
  next = 0;
  /** Where the holder's output stood when this end connected: what is behind it was replayed. */
  caughtUpAt = 0;
  private readonly decoder = new StringDecoder("utf8");
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((e: HeldExit) => void) | null = null;
  private waitingData: string[] = [];
  private exited: HeldExit | null = null;
  private exitTold = false;
  private detached = false;

  constructor(private readonly sock: Socket) {}

  onData(cb: (data: string) => void): void {
    this.dataListener = cb;
    for (const d of this.waitingData.splice(0)) cb(d);
  }

  onExit(cb: (e: HeldExit) => void): void {
    this.exitListener = cb;
    if (this.exited) this.tellExit();
  }

  write(data: string): void {
    const bytes = Buffer.from(data, "utf8");
    for (let at = 0; at < bytes.length; at += INPUT_CHUNK) this.send(frame(T.input, bytes.subarray(at, at + INPUT_CHUNK)));
  }

  resize(cols: number, rows: number): void {
    const p = Buffer.alloc(4);
    p.writeUInt16BE(Math.max(1, Math.min(0xffff, cols)), 0);
    p.writeUInt16BE(Math.max(1, Math.min(0xffff, rows)), 2);
    this.send(frame(T.resize, p));
  }

  /** A signal to the program's process group, sent from here (the same user) or through the holder. */
  kill(signal: string = "SIGHUP"): void {
    try { process.kill(-this.pid, signal as NodeJS.Signals); return; } catch { /* through the holder */ }
    const p = Buffer.alloc(4);
    const n = osSignal(signal) ?? 1;
    p.writeInt32BE(n, 0);
    this.send(frame(T.signal, p));
  }

  /** The service goes; the program and its holder stay, for the next daemon. */
  detach(): void {
    this.detached = true;
    this.sock.destroy();
  }

  get ended(): boolean { return this.exited !== null; }

  private send(b: Buffer): void {
    if (!this.sock.destroyed) this.sock.write(b);
  }

  /** @internal */ received(type: number, p: Buffer): void {
    if (type === T.data && p.length >= 8) {
      const at = Number(p.readBigUInt64BE(0));
      if (at > this.next) this.decoder.end();   // a gap: what was cut is not completed by what follows
      const text = this.decoder.write(p.subarray(8));
      this.next = at + p.length - 8;
      if (!text) return;
      if (this.dataListener) this.dataListener(text); else this.waitingData.push(text);
    } else if (type === T.exit && p.length >= 8) {
      this.ended_(p.readInt32BE(0), p.readInt32BE(4));
      // Taken note of: the holder may go.
      this.send(frame(T.collect));
    }
  }

  /** @internal */ closed(): void {
    // The holder went without saying the program ended (it was killed): its pty closed, the program got SIGHUP.
    if (!this.detached && !this.exited) this.ended_(129, 1);
  }

  private ended_(exitCode: number, signal: number): void {
    if (this.exited) return;
    const rest = this.decoder.end();
    if (rest) { if (this.dataListener) this.dataListener(rest); else this.waitingData.push(rest); }
    this.exited = { exitCode, signal };
    this.tellExit();
  }

  private tellExit(): void {
    if (this.exitTold || !this.exitListener || !this.exited) return;
    this.exitTold = true;
    this.exitListener(this.exited);
  }
}

function osSignal(name: string): number | undefined {
  return (constants.signals as Record<string, number>)[name];
}

/** Connects to the holder at `place`, from output offset `from`: the program's pid, whether it ended, the rest. */
export function attachHeld(place: HoldPlace, from = 0): Promise<HeldPty> {
  if (Buffer.byteLength(place.socket) > MAX_SOCKET_PATH) return Promise.reject(new HoldError(`the holder's socket path is too long: ${place.socket}`));
  return new Promise((resolve, reject) => {
    const sock = createConnection(place.socket);
    const pty = new HeldPty(sock);
    let welcomed = false;
    let buf: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new HoldError("the holder did not answer")); }, CONNECT_TIMEOUT_MS);
    timer.unref();
    sock.on("connect", () => {
      const tok = Buffer.from(place.token, "utf8");
      const p = Buffer.alloc(10 + tok.length);
      p.writeUInt16BE(HOLD_VERSION, 0);
      p.writeBigUInt64BE(BigInt(from), 2);
      tok.copy(p, 10);
      sock.write(frame(T.hello, p));
      pty.next = from;
    });
    sock.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 5) {
        const n = buf.readUInt32BE(1);
        if (buf.length < 5 + n) break;
        const type = buf[0]!, p = buf.subarray(5, 5 + n);
        buf = buf.subarray(5 + n);
        if (!welcomed) {
          if (type === T.error) { clearTimeout(timer); sock.destroy(); reject(new HoldError(`the holder refused: ${p.toString("utf8")}`)); return; }
          if (type !== T.welcome || p.length < 35) { clearTimeout(timer); sock.destroy(); reject(new HoldError("the holder said something else first")); return; }
          welcomed = true;
          clearTimeout(timer);
          pty.version = p.readUInt16BE(0);
          pty.pid = p.readInt32BE(2);
          pty.caughtUpAt = Number(p.readBigUInt64BE(18));
          resolve(pty);
          continue;
        }
        pty.received(type, Buffer.from(p));
      }
    });
    sock.on("error", (err) => { if (!welcomed) { clearTimeout(timer); reject(new HoldError(`the holder cannot be reached: ${err.message}`)); } });
    sock.on("close", () => { if (welcomed) pty.closed(); });
  });
}

/** Starts a holder for `spec` at `place` and connects. Rejects with the holder's reason when the program cannot start. */
export async function startHeld(h: Holding, place: HoldPlace, spec: HeldSpec, unit: string): Promise<HeldPty> {
  if (Buffer.byteLength(place.socket) > MAX_SOCKET_PATH) throw new HoldError(`the holder's socket path is too long: ${place.socket}`);
  const [cmd, args] = h.scope
    ? ["systemd-run", ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, `--slice=${SLICE}`, "--", h.binary, place.socket]] as const
    : [h.binary, [place.socket]] as const;
  const child = spawn(cmd, [...args], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const said = await new Promise<string>((resolve, reject) => {
    let out = "", err = "";
    const timer = setTimeout(() => reject(new HoldError(`the holder did not start: ${err.trim() || "no answer"}`)), START_TIMEOUT_MS);
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      const nl = out.indexOf("\n");
      if (nl >= 0) { clearTimeout(timer); resolve(out.slice(0, nl)); }
    });
    child.stderr!.on("data", (d: Buffer) => { err = (err + d.toString("utf8")).slice(-2000); });
    child.on("error", (e) => { clearTimeout(timer); reject(new HoldError(`the holder did not start: ${e.message}`)); });
    child.on("exit", (code) => { if (!out.includes("\n")) { clearTimeout(timer); reject(new HoldError(`the holder did not start (${code}): ${err.trim()}`)); } });
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(specBytes(place.token, spec));
  });
  // The holder lives on its own: this process neither waits for it nor keeps its pipes.
  child.stdout!.destroy(); child.stderr!.destroy();
  child.unref();
  if (!said.startsWith("ready ")) throw new HoldError(said.replace(/^error /, ""));
  return attachHeld(place, 0);
}

/** A companion's server (OpenCode's `serve`, Codex's `app-server`): a child of this process, or a holder's program
 *  that outlives it — then `place` says where it is reached again. */
export type ServerProcess = {
  onExit(cb: () => void): void;
  /** SIGTERM to its process group, SIGKILL after `graceMs`; resolves once it is gone. */
  stop(graceMs: number): Promise<void>;
  /** Let go of, the server running on (the service stops; the terminal is held). */
  detach(): void;
  readonly place?: HoldPlace;
};

/** A server on a holder of its own: what it writes is handed to `onOutput` (its address line among it). */
export async function startHeldServer(h: Holding, place: HoldPlace, spec: Omit<HeldSpec, "cols" | "rows" | "ringBytes">, unit: string, onOutput: (text: string) => void): Promise<ServerProcess> {
  const pty = await startHeld(h, place, { ...spec, cols: 200, rows: 50, ringBytes: 256 * 1024 }, unit);
  pty.onData(onOutput);
  return heldServer(pty, place);
}

/** A held server a daemon before this one started, reached again. */
export async function attachHeldServer(place: HoldPlace): Promise<ServerProcess> {
  const pty = await attachHeld(place, Number.MAX_SAFE_INTEGER);   // its old output is of no use now
  return heldServer(pty, place);
}

function heldServer(pty: HeldPty, place: HoldPlace): ServerProcess {
  const gone = new Promise<void>((resolve) => pty.onExit(() => resolve()));
  return {
    place,
    onExit: (cb) => { void gone.then(cb); },
    detach: () => pty.detach(),
    stop: async (graceMs) => {
      if (pty.ended) return;
      pty.kill("SIGTERM");
      const timer = setTimeout(() => pty.kill("SIGKILL"), graceMs);
      await gone;
      clearTimeout(timer);
    },
  };
}
