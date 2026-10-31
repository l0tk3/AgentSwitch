/** This node's gate's key pairs (`secret-gate keys --json …`), what the Mac's Settings › Keys does through its GateCLI:
 *  the list, a new one (made current or not), another made current, one retired. Retiring is final: what was sealed
 *  to it cannot be opened again; the gate refuses to retire the current one. */

import { execFile } from "node:child_process";

export type Keypair = { readonly name: string; readonly public: string; readonly current: boolean; readonly legacy?: boolean };

/** What a key pair may be called (mac-app `GateCLI.isValidName`). */
export const KEY_NAME = /^[A-Za-z0-9._-]{1,32}$/;

export type GateRun = (args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export function gateRunner(gate: { bin: string; home: string }): GateRun {
  return (args) => new Promise((resolve) => {
    execFile(gate.bin, [...args], { env: { ...process.env, SECRET_GATE_HOME: gate.home }, timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export class GateKeys {
  constructor(private readonly run: GateRun) {}

  async list(): Promise<Keypair[]> { return this.call(["keys", "--json"]); }
  async create(name: string, use: boolean): Promise<Keypair[]> { return this.call(["keys", "--json", "new", this.named(name), ...(use ? ["--use"] : [])]); }
  async use(name: string): Promise<Keypair[]> { return this.call(["keys", "--json", "use", this.named(name)]); }

  /** Retired, and the list after (an older gate says nothing on retiring: then it is asked for the list). */
  async retire(name: string): Promise<Keypair[]> {
    const r = await this.run(["keys", "--json", "retire", this.named(name)]);
    if (r.code !== 0) throw new Error(this.why(r));
    try { return JSON.parse(r.stdout) as Keypair[]; } catch { return this.list(); }
  }

  private named(name: string): string {
    if (!KEY_NAME.test(name)) throw new Error(`a key pair's name is letters, digits, . _ - (at most 32): ${name}`);
    return name;
  }

  private async call(args: readonly string[]): Promise<Keypair[]> {
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(this.why(r));
    try { return JSON.parse(r.stdout) as Keypair[]; } catch { throw new Error("secret-gate's answer could not be read"); }
  }

  /** The gate's own words for a refusal (`error: …`), else its exit code. */
  private why(r: { code: number | null; stderr: string; stdout: string }): string {
    return (r.stderr.trim() || r.stdout.trim()).replace(/^error:\s*/, "") || `secret-gate exited ${r.code}`;
  }
}
