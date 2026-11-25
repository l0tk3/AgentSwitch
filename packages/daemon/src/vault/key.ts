/** The key of AgentSwitch's own encrypted store (the replacement words, the salts: words.ts). On a Mac it is kept in
 *  the user's Keychain by the app, which hands it to the service on its stdin when it starts it
 *  (`AGENTSWITCH_VAULT_STDIN=1`): never in a file, an environment or a command line. Elsewhere (a node with no app, a
 *  service started by hand) it is a file only this account reads, in a folder no terminal's agent may read
 *  (core/protected.ts). */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VAULT_DIR = "vault";
const KEY_FILE = "key";

/** The first line of stdin, read now (the app writes it before anything else). */
function stdinLine(): string | null {
  const buf = Buffer.alloc(256);
  let got = "";
  try {
    for (;;) {
      const n = readSync(0, buf, 0, buf.length, null);
      if (n <= 0) break;
      got += buf.subarray(0, n).toString("utf8");
      if (got.includes("\n")) break;
    }
  } catch { return null; }
  const line = got.split("\n")[0]!.trim();
  return line || null;
}

export function vaultKey(home: string, env: NodeJS.ProcessEnv = process.env, fromStdin: () => string | null = stdinLine): { key: Buffer; where: "keychain" | "file" } {
  if (env.AGENTSWITCH_VAULT_STDIN === "1") {
    delete env.AGENTSWITCH_VAULT_STDIN;
    const line = fromStdin();
    if (line && /^[0-9a-f]{64}$/i.test(line)) return { key: Buffer.from(line, "hex"), where: "keychain" };
  }
  const dir = join(home, VAULT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, KEY_FILE);
  if (existsSync(file)) {
    const hex = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return { key: Buffer.from(hex, "hex"), where: "file" };
  }
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  return { key, where: "file" };
}

/** The file key, where one was made before (a store kept under it is opened, then moved to the Keychain's). */
export function fileKey(home: string): Buffer | null {
  try {
    const hex = readFileSync(join(home, VAULT_DIR, KEY_FILE), "utf8").trim();
    return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
  } catch { return null; }
}
