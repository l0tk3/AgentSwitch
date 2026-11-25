/** Where the secret-gate program is: what runs the model traffic gateway (`secret-gate model-proxy`,
 *  vault/modelGate.ts). Apart from the executors' gate wiring so that it stays when that goes. */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

/** Why `gateBin` found nothing, naming the three places it looks, in its order. */
export function gateNotFound(env: NodeJS.ProcessEnv = process.env, venv: string = VENV_GATE_BIN): string {
  if (env.SECRET_GATE_BIN) return `secret-gate not found: $SECRET_GATE_BIN=${env.SECRET_GATE_BIN} does not exist (when set, it is the only place looked at; unset it to use the repo venv ${venv} or \`secret-gate\` on $PATH)`;
  return `secret-gate not found: $SECRET_GATE_BIN is not set, the repo venv ${venv} does not exist, and there is no \`secret-gate\` on $PATH`;
}

