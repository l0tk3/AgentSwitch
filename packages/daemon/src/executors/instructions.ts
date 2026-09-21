/** Global guidance every executor receives: AgentSwitch's notes plus secret-gate's AGENTS.md. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
export const EXECUTOR_MD = resolve(HERE, "..", "..", "config", "EXECUTOR.md");
export const GATE_AGENTS_MD = resolve(HERE, "..", "..", "..", "secret-gate", "AGENTS.md");

export function executorInstructions(paths: { executor?: string; gate?: string } = {}): string {
  const parts: string[] = [];
  for (const p of [paths.executor ?? EXECUTOR_MD, paths.gate ?? GATE_AGENTS_MD]) {
    if (existsSync(p)) parts.push(readFileSync(p, "utf8").trim());
  }
  return parts.join("\n\n");
}
