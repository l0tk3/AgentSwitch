/** Model discovery at start-up (router-v0 §3, decided 2026-09-22): ask each harness what it offers and merge new
 *  ids into the catalog. Old entries are kept (they still work by id); a new id gets a cost guessed from its
 *  name and a "discovered" strength so the router knows nothing else about it. Failures are logged, never fatal. */

import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { appServerRequest } from "../harness/appserver.js";
import type { CostTier, ModelSpec, Targets } from "./targets.js";
import { APP_SERVER_REQUEST_TIMEOUT_MS } from "../core/limits.js";

export type Discovered = { readonly "claude-code": readonly string[]; readonly codex: readonly string[] };
export const NOTHING_DISCOVERED: Discovered = { "claude-code": [], codex: [] };
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** `supportedModels()` starts the Claude CLI first. */
const CLAUDE_DISCOVERY_TIMEOUT_MS = 30_000;

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
      if (id in models || h.exclude?.includes(id)) continue;
      models[id] = { cost: inferCost(id), strengths: ["discovered"], ...(name === "codex" ? { efforts: CODEX_EFFORTS } : {}) };
      added.push(`${name}/${id}`);
    }
    return [name, { ...h, models }];
  }));
  return { targets: { ...targets, harnesses }, added };
}

/** One entry of Codex's `model/list`: what its own picker shows. */
export type CodexModelInfo = {
  readonly id: string; readonly displayName?: string; readonly description?: string; readonly hidden?: boolean; readonly upgrade?: string | null;
  /** The reasoning efforts it takes and the one it uses unless told (`supportedReasoningEfforts`, `defaultReasoningEffort`). */
  readonly efforts?: readonly string[]; readonly defaultEffort?: string;
  /** Codex's own default model. */
  readonly isDefault?: boolean;
};

/** Codex app-server `model/list`, entries as it gives them; tolerant of the result's shape. */
export async function listCodexModels(binary: string, timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS): Promise<CodexModelInfo[]> {
  const r = await appServerRequest(binary, "model/list", {}, timeoutMs);
  const list = (Array.isArray(r.models) ? r.models : Array.isArray(r.data) ? r.data : Array.isArray(r.items) ? r.items : []) as Array<Record<string, unknown> | string>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  return list.map((m): CodexModelInfo => {
    if (typeof m === "string") return { id: m };
    const displayName = str(m.displayName), description = str(m.description), upgrade = str(m.upgrade);
    const efforts = Array.isArray(m.supportedReasoningEfforts)
      ? m.supportedReasoningEfforts.map((e) => (typeof e === "string" ? e : str((e as Record<string, unknown> | null)?.reasoningEffort))).filter((e): e is string => Boolean(e))
      : undefined;
    const defaultEffort = str(m.defaultReasoningEffort);
    return {
      id: String(m.id ?? m.model ?? m.name ?? ""),
      ...(displayName ? { displayName } : {}), ...(description ? { description } : {}),
      ...(m.hidden === true ? { hidden: true } : {}), ...(upgrade ? { upgrade } : {}),
      ...(efforts ? { efforts } : {}), ...(defaultEffort ? { defaultEffort } : {}), ...(m.isDefault === true ? { isDefault: true } : {}),
    };
  }).filter((m) => m.id.length > 0);
}

export async function discoverCodexModels(binary: string, timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS): Promise<string[]> {
  return codexIds(await listCodexModels(binary, timeoutMs));
}
export const codexIds = (list: readonly CodexModelInfo[]): string[] => [...new Set(list.map((m) => m.id))];

/** One entry of Claude Code's model picker: `value` is what `--model` takes (an alias like "opus" follows new
 *  releases), `resolvedModel` the id it means today. */
export type ClaudeModelInfo = {
  readonly value: string; readonly resolvedModel?: string; readonly displayName: string; readonly description: string;
  /** The effort levels it takes (`supportedEffortLevels`); none for a model without effort; absent when it does not say. */
  readonly efforts?: readonly string[];
};

/** Claude Agent SDK `supportedModels()` without sending a message: canonical ids only (aliases like "default" dropped). */
export async function discoverClaudeModels(executable?: string, timeoutMs = CLAUDE_DISCOVERY_TIMEOUT_MS): Promise<string[]> {
  return claudeIds(await listClaudeModels(executable, timeoutMs));
}
export const claudeIds = (list: readonly ClaudeModelInfo[]): string[] =>
  [...new Set(list.map((m) => m.resolvedModel ?? m.value).filter((id) => id.startsWith("claude-")))];

/** The picker's entries as Claude Code gives them, in its order (current models first). */
export async function listClaudeModels(executable?: string, timeoutMs = CLAUDE_DISCOVERY_TIMEOUT_MS): Promise<ClaudeModelInfo[]> {
  // A neutral cwd: the CLI looks for CLAUDE.md in every parent of its cwd, and a cwd under a privacy-protected folder
  // (e.g. an app bundle on the Desktop) blocks the whole CLI in open() until macOS grants that folder.
  const abortController = new AbortController();
  const q = query({ prompt: (async function* () { /* nothing: only the list */ })(), options: { cwd: tmpdir(), abortController, settingSources: [], permissionMode: "default", maxTurns: 1, canUseTool: async () => ({ behavior: "deny", message: "discovery" }), ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) } });
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`supportedModels timed out after ${timeoutMs} ms`)), timeoutMs); timeout.unref(); });
  try {
    const models = await Promise.race([q.supportedModels(), timer]);
    return models.map((m) => ({
      value: m.value, ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}), displayName: m.displayName, description: m.description,
      ...(m.supportsEffort === false ? { efforts: [] } : m.supportedEffortLevels ? { efforts: [...m.supportedEffortLevels] } : {}),
    }));
  } finally {
    clearTimeout(timeout);
    abortController.abort();  // a CLI stuck at start-up must not outlive the discovery as an orphan
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
  return mergeLogged(targets, { "claude-code": claude, codex }, log);
}

/** The catalog with what was found, and one log line saying what. */
export function mergeLogged(targets: Targets, found: Discovered, log: (line: string) => void = (l) => console.error(l)): Targets {
  const merged = mergeDiscovered(targets, found);
  log(`model discovery: claude-code ${found["claude-code"].length} ids, codex ${found.codex.length} ids${merged.added.length ? `; new in catalog: ${merged.added.join(", ")}` : "; nothing new"}`);
  return merged.targets;
}
