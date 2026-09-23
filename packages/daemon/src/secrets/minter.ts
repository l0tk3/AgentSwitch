/** Minting enc:v1: tokens through `secret-gate enc --batch`: the same command the desktop UI runs, so the same
 *  current keypair is used and switching keypairs in the UI applies here at once. Values travel on stdin only. */

import { spawn } from "node:child_process";
import { z } from "zod";

export type MintEntry = {
  readonly label: string;
  readonly value: string;
  readonly kind: "secret" | "totp";
  readonly hosts: readonly string[];
  readonly uses: readonly ("http" | "otp" | "exec")[];
  /** Original-user authorization to import a TOTP seed into these exact hosts; absent means no grant. */
  readonly seed_import_hosts?: readonly string[];
};

export type MintResult = { readonly label: string; readonly token: string } | { readonly label: string; readonly error: string };

export type Minter = (entries: readonly MintEntry[]) => Promise<readonly MintResult[]>;

const Output = z.array(z.union([
  z.object({ label: z.string().nullable(), token: z.string().regex(/^enc:v1:[A-Za-z0-9_=-]{16,}$/) }),
  z.object({ label: z.string().nullable(), error: z.string() }),
]));

/** stdout of `enc --batch`: one result per entry, in order; an entry's failure never hides the others. */
export function parseMintOutput(stdout: string): readonly MintResult[] {
  const parsed = Output.safeParse(JSON.parse(stdout));
  if (!parsed.success) throw new Error("secret-gate enc --batch: unexpected output shape");
  return parsed.data.map((r) => ("token" in r ? { label: r.label ?? "", token: r.token } : { label: r.label ?? "", error: r.error }));
}

export function gateMinter(gate: { readonly bin: string; readonly home: string }, timeoutMs = 15_000): Minter {
  return (entries) => new Promise((resolve, reject) => {
    if (!entries.length) { resolve([]); return; }
    const child = spawn(gate.bin, ["enc", "--batch"], { env: { ...process.env, SECRET_GATE_HOME: gate.home }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("secret-gate enc timed out")); }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`secret-gate enc: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== 1) { reject(new Error(`secret-gate enc exited ${code}: ${err.trim().slice(0, 200)}`)); return; }
      try { resolve(parseMintOutput(out)); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify(entries.map((e) => ({ label: e.label, value: e.value, kind: e.kind, hosts: [...e.hosts], uses: [...e.uses], ...(e.seed_import_hosts?.length ? { seed_import_hosts: [...e.seed_import_hosts] } : {}) }))));
  });
}

/** Test double: a token that looks real enough for the token regexes; the value is not recoverable from it. */
export function fakeMinter(): Minter {
  return async (entries) => entries.map((e, i) => ({ label: e.label, token: `enc:v1:${Buffer.from(`${e.label}#${i}#${e.value.length}`).toString("base64url").padEnd(24, "A")}` }));
}
