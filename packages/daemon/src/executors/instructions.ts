/** Global guidance every executor receives: AgentSwitch's notes plus secret-gate's AGENTS.md. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
export const EXECUTOR_MD = resolve(HERE, "..", "..", "config", "EXECUTOR.md");
export const GATE_AGENTS_MD = resolve(HERE, "..", "..", "..", "secret-gate", "AGENTS.md");

/** The prompt every harness receives: brief, then the handoff package, then the user's environment context. */
const TOKEN_IN_TEXT = /enc:v1:[A-Za-z0-9_=-]{16,}/;

/** Brief, then the user's own message when it carries tokens (the router is told not to copy tokens into the brief,
 *  so sealed values and their legend reach the executor only this way), then handoff, then CONTEXT.md. */
export function composePrompt(input: { brief: string; task?: string; handoffNote: string | null; context: string | null }): string {
  const parts = [input.brief];
  if (input.task && input.task !== input.brief && TOKEN_IN_TEXT.test(input.task)) parts.push(`The user's own message (credentials in it are already secret-gate tokens; copy them from here, whole):\n${input.task}`);
  if (input.handoffNote) parts.push(`Handoff from a previous attempt:\n${input.handoffNote}`);
  if (input.context?.trim()) parts.push(`User environment context (maintained by the user; enc:v1: values are secret-gate tokens that only work through the gate, use them as given and never try to decode or replace them):\n${input.context.trim()}`);
  return parts.join("\n\n");
}

export function executorInstructions(paths: { executor?: string; gate?: string } = {}): string {
  const parts: string[] = [];
  for (const p of [paths.executor ?? EXECUTOR_MD, paths.gate ?? GATE_AGENTS_MD]) {
    if (existsSync(p)) parts.push(readFileSync(p, "utf8").trim());
  }
  return parts.join("\n\n");
}
