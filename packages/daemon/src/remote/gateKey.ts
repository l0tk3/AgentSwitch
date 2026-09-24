/** The gate's current public key for phones (app-v0 §2 gate 公钥, §3): `secret-gate keys --json` of the configured gate,
 *  the row marked current. Phones seal secrets to it locally; the key is public, so no scope or secret is involved. */

import { execFile } from "node:child_process";
import { z } from "zod";
import { GATE_CLI_TIMEOUT_MS } from "../core/limits.js";
import type { GateOptions } from "../executors/gate.js";
import type { GateKey } from "./pairing.js";

const PUBLIC_KEY_BYTES = 32;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const KeyRows = z.array(z.object({ name: z.string().min(1), public: z.string(), current: z.boolean() }));

/** The current row of `keys --json` output, or null when none is current or its key is not 32 bytes of base64url. */
export function currentKey(stdout: string): GateKey | null {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return null; }
  const rows = KeyRows.safeParse(raw);
  if (!rows.success) return null;
  const row = rows.data.find((r) => r.current);
  if (!row || !/^[A-Za-z0-9_-]+$/.test(row.public) || Buffer.from(row.public, "base64url").length !== PUBLIC_KEY_BYTES) return null;
  return { publicKey: row.public, keypair: row.name };
}

export type GateKeyReader = () => Promise<GateKey | null>;

/** Runs `<bin> keys --json` with the gate's home; any failure (no gate, no keypair, bad output) is null, with the
 *  reason on stderr for the Mac app's log. */
export function gateKeyReader(gate: () => Pick<GateOptions, "bin" | "home"> | null, opts: { readonly timeoutMs?: number; readonly warn?: (message: string) => void } = {}): GateKeyReader {
  const warn = opts.warn ?? console.error;
  return () => new Promise((resolve) => {
    const g = gate();
    if (!g) { warn("gate public key: secret-gate not found"); resolve(null); return; }
    execFile(g.bin, ["keys", "--json"], { env: { ...process.env, SECRET_GATE_HOME: g.home }, timeout: opts.timeoutMs ?? GATE_CLI_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (err, stdout) => {
      if (err) { warn(`gate public key: ${g.bin} keys --json failed: ${err.message.split("\n")[0]}`); resolve(null); return; }
      const key = currentKey(String(stdout));
      if (!key) warn(`gate public key: no current keypair with a valid public key in ${g.home}`);
      resolve(key);
    });
  });
}
