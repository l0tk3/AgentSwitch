/** The user's environment context file (CONTEXT.md), as the router sees it: re-read on every dispatch, linted
 *  (core/contextDoc.ts) and handed to the router verbatim; plus the template `agentswitch context init` copies. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedContext } from "../core/contextDoc.js";

/** Template copied by `agentswitch context init` and offered by the UI when CONTEXT.md is empty. */
export const CONTEXT_EXAMPLE = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "config", "CONTEXT.example.md");

export function exampleContext(path = CONTEXT_EXAMPLE): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Prompt section; empty when there is no context so the prompt stays stable in tests. */
export function contextSection(ctx: LoadedContext): string {
  if (!ctx.text.trim()) return "";
  return `

User environment context (maintained by the user; enc:v1: values are secret-gate tokens, usable only through the gate):
${ctx.text.trim()}

When the task refers to a site, account or environment listed here, name that entry in the brief (URL and username
are fine to copy). Do NOT retype enc:v1: tokens: they are 200+ random characters and a single dropped character
makes them useless; the executor receives this same context verbatim and reads the token from it.
Never invent credentials. If the task needs a credential that is not listed, say so in the brief and lower
confidence; do not ask the executor to look for it.`;
}
