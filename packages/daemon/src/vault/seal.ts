/** A value sealed under the vault's key (key.ts), in place of a secret-gate ciphertext (2026-11-25, user #369:
 *  secret-gate 弃用): what a profile keeps of its API key, its proxy's password, its session key. `asv:1:` and the
 *  AES-256-GCM of the value, base64url. Opened here, by this service alone; a gate ciphertext kept from before
 *  (`enc:v1:`) is still opened by the gate while there is one, and moved here (`moved`). */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const VAULT_PREFIX = "asv:1:";
export const isVaultSealed = (token: string): boolean => token.startsWith(VAULT_PREFIX);

export function sealValue(key: Buffer, value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return VAULT_PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

export function openValue(keys: readonly Buffer[], token: string): string {
  const blob = Buffer.from(token.slice(VAULT_PREFIX.length), "base64url");
  for (const key of keys) {
    try {
      const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      d.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
    } catch { /* the next key */ }
  }
  throw new Error("not sealed under this vault's key");
}

/** What opens a kept value (the shape of browser/fill.ts `FillResolver`): the vault's own here, a gate's ciphertext by
 *  the gate while there is one. */
export type Opener = (token: string, frames: readonly string[]) => Promise<{ readonly value: string; readonly label: string }>;

export function vaultOpener(keys: readonly Buffer[], gate: Opener | null): Opener {
  return async (token, frames) => {
    if (isVaultSealed(token)) return { value: openValue(keys, token), label: "vault" };
    if (!gate) throw new Error("a secret-gate ciphertext, and no gate to open it");
    return gate(token, frames);
  };
}
