/** This node's gate key pair (`secret-gate keys --json`), what the Mac's Settings › Keys shows: the gate has exactly
 *  one key pair (gate-simple-v0 §1), listed as one row, or none yet. Without the gate service the node makes it with
 *  `secret-gate keygen`; with the service, the service makes it at install and an administrator rotates it. */

import { execFile } from "node:child_process";

export type Keypair = { readonly name: string; readonly public: string; readonly current: boolean; readonly legacy?: boolean };

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

  /** The one key pair as a list of at most one row ([] when there is none yet). */
  async list(): Promise<Keypair[]> {
    const r = await this.run(["keys", "--json"]);
    if (r.code !== 0) throw new Error(this.why(r));
    try { return JSON.parse(r.stdout) as Keypair[]; } catch { throw new Error("secret-gate's answer could not be read"); }
  }

  /** `secret-gate keygen` (it refuses when a key pair exists, and with the gate service), then the list. */
  async create(): Promise<Keypair[]> {
    const r = await this.run(["keygen"]);
    if (r.code !== 0) throw new Error(this.why(r));
    return this.list();
  }

  /** The gate's own words for a refusal (`error: …`), else its exit code. */
  private why(r: { code: number | null; stderr: string; stdout: string }): string {
    return (r.stderr.trim() || r.stdout.trim()).replace(/^error:\s*/, "") || `secret-gate exited ${r.code}`;
  }
}
