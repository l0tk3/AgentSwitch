/** Where the secret-gate program is: what runs the model traffic gateway (`secret-gate model-proxy`,
 *  vault/modelGate.ts), opens the ciphertexts kept from before one last time (sealedMove.ts) and says the public key
 *  phones still seal with (remote/gateKey.ts). */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "../util/which.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The monorepo's own secret-gate install (packages/secret-gate/.venv). */
export const VENV_GATE_BIN = resolve(HERE, "..", "..", "..", "secret-gate", ".venv", "bin", "secret-gate");

/** The secret-gate binary: $SECRET_GATE_BIN when set (authoritative: a wrong path finds nothing rather than silently
 *  falling back to another gate), else the repo's venv, else `secret-gate` on $PATH as an absolute path. Null when none. */
export function gateBin(env: NodeJS.ProcessEnv = process.env, venv: string = VENV_GATE_BIN): string | null {
  if (env.SECRET_GATE_BIN) return existsSync(env.SECRET_GATE_BIN) ? env.SECRET_GATE_BIN : null;
  if (existsSync(venv)) return venv;
  return which("secret-gate", env.PATH);
}

/** The gate as it is run: its program, and the folder its keys are in. */
export type Gate = { readonly bin: string; readonly home: string };

/** This machine's gate (its folder: $SECRET_GATE_HOME, else `.secret-gate` in the home folder), or null when there is
 *  no program. */
export function defaultGate(env: NodeJS.ProcessEnv = process.env, venv: string = VENV_GATE_BIN): Gate | null {
  const bin = gateBin(env, venv);
  return bin ? { bin, home: env.SECRET_GATE_HOME ?? join(env.HOME ?? "", ".secret-gate") } : null;
}
