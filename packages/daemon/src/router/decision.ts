/** What the router model returns, and how to pull it out of a chatty reply. */

import { z } from "zod";
import { TargetRef } from "./targets.js";

export const Decision = z.object({
  harness: z.string().min(1),
  model: z.string().min(1).nullable().default(null),
  effort: z.string().min(1).nullable().default(null),
  brief: z.string().min(1),
  needs_browser: z.boolean().default(false),
  expected_size: z.enum(["small", "medium", "large"]).default("medium"),
  risk: z.string().nullable().default(null),
  fallbacks: z.array(TargetRef).default([]),
  reason: z.string().default(""),
  confidence: z.number().min(0).max(1),
  /** Re-dispatch only: keep going with a new target, or tell the user why not. */
  action: z.enum(["redispatch", "give_up"]).default("redispatch"),
  /** Re-dispatch only: what the next executor must know about the previous attempt. */
  handoff_note: z.string().nullable().default(null),
});
export type Decision = z.infer<typeof Decision>;

export type ParseResult = { ok: true; decision: Decision } | { ok: false; error: string };

/** First balanced `{...}` block in the text, so a model that adds prose or fences still parses. */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export function parseDecision(text: string): ParseResult {
  const raw = extractJsonObject(text);
  if (raw === undefined) return { ok: false, error: "no JSON object in reply" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const parsed = Decision.safeParse(value);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { ok: true, decision: parsed.data };
}
