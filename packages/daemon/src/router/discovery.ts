/** Model discovery at start-up (router-v0 §3, decided 2026-09-22): ask each harness what it offers and merge new
 *  ids into the catalog. Old entries are kept (they still work by id); a new id gets a cost guessed from its
 *  name and a "discovered" strength so the router knows nothing else about it. Failures are logged, never fatal. */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { appServerRequest } from "../quota/codex.js";
import type { CostTier, ModelSpec, Targets } from "./targets.js";

export type Discovered = { readonly "claude-code": readonly string[]; readonly codex: readonly string[] };
export const NOTHING_DISCOVERED: Discovered = { "claude-code": [], codex: [] };
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Cost tier from the model name alone; the router treats it as a hint. */
export function inferCost(id: string): CostTier {
  const s = id.toLowerCase();
  if (/fable|gpt-6|astra/.test(s)) return "top";
  if (/opus|pro|sol|terra/.test(s)) return "high";
  if (/haiku|mini|nano|flash|lite/.test(s)) return "low";
  return "mid";
}

/** Catalog with every discovered id the yaml lacks added under its harness. Pure. */
export function mergeDiscovered(targets: Targets, found: Discovered): { targets: Targets; added: string[] } {
  const added: string[] = [];
  const harnesses = Object.fromEntries(Object.entries(targets.harnesses).map(([name, h]) => {
    const ids = name === "claude-code" ? found["claude-code"] : name === "codex" ? found.codex : [];
    const models: Record<string, ModelSpec> = { ...h.models };
    for (const id of ids) {
      if (id in models) continue;
      models[id] = { cost: inferCost(id), strengths: ["discovered"], ...(name === "codex" ? { efforts: CODEX_EFFORTS } : {}) };
      added.push(`${name}/${id}`);
    }
    return [name, { ...h, models }];
  }));
  return { targets: { ...targets, harnesses }, added };
}

/** Codex app-server `model/list`; tolerant of the result's shape. */
export async function discoverCodexModels(binary: string, timeoutMs = 20_000): Promise<string[]> {
  const r = await appServerRequest(binary, "model/list", {}, timeoutMs);
  const list = (Array.isArray(r.models) ? r.models : Array.isArray(r.data) ? r.data : Array.isArray(r.items) ? r.items : []) as Array<Record<string, unknown> | string>;
  return [...new Set(list.map((m) => (typeof m === "string" ? m : String(m.id ?? m.model ?? m.name ?? ""))).filter((id) => id.length > 0))];
}

/** Claude Agent SDK `supportedModels()` without sending a message: canonical ids only (aliases like "default" dropped). */
export async function discoverClaudeModels(executable?: string, timeoutMs = 30_000): Promise<string[]> {
  const q = query({ prompt: (async function* () { /* nothing: only the list */ })(), options: { settingSources: [], permissionMode: "default", maxTurns: 1, canUseTool: async () => ({ behavior: "deny", message: "discovery" }), ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) } });
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`supportedModels timed out after ${timeoutMs} ms`)), timeoutMs).unref());
  try {
    const models = await Promise.race([q.supportedModels(), timer]);
    return [...new Set(models.map((m) => m.resolvedModel ?? m.value).filter((id) => id.startsWith("claude-")))];
  } finally {
    q.close?.();
  }
}

export type DiscoveryOptions = { readonly codexBinary?: string; readonly claudeExecutable?: string; readonly log?: (line: string) => void };

/** Run both discoveries in parallel and merge; each failure is one log line. */
export async function discoverTargets(targets: Targets, opts: DiscoveryOptions = {}): Promise<Targets> {
  const log = opts.log ?? ((l) => console.error(l));
  const [claude, codex] = await Promise.all([
    discoverClaudeModels(opts.claudeExecutable).catch((e: Error) => { log(`model discovery (claude-code): ${e.message}`); return [] as string[]; }),
    opts.codexBinary ? discoverCodexModels(opts.codexBinary).catch((e: Error) => { log(`model discovery (codex): ${e.message}`); return [] as string[]; }) : Promise.resolve([] as string[]),
  ]);
  const merged = mergeDiscovered(targets, { "claude-code": claude, codex });
  log(`model discovery: claude-code ${claude.length} ids, codex ${codex.length} ids${merged.added.length ? `; new in catalog: ${merged.added.join(", ")}` : "; nothing new"}`);
  return merged.targets;
}
