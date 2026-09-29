/** What each agent offers today for a new terminal's model menu (docs/terminal-v0.md §1): its own list, in its own
 *  order, under its own names — Claude Code's picker (`supportedModels()`), Codex's `model/list`. A model a newer one of
 *  the same family supersedes (Opus 4.8 under Opus 5.5, GPT-5.6-Sol under GPT-6-Sol), or one the agent names an upgrade
 *  for, is marked older: the menus fold those away, as Claude Code's picker does. Claude's aliases stay aliases
 *  (`opus` follows the next Opus by itself). Asked again every few hours and whenever an agent's binary changes (an
 *  update brings its new models); the router's catalog takes the new ids at the next start. */

import { realpathSync, statSync } from "node:fs";
import { claudeIds, codexIds, listClaudeModels, listCodexModels, type ClaudeModelInfo, type CodexModelInfo, type Discovered } from "./discovery.js";

export type ModelOffer = { readonly id: string; readonly name: string; readonly description?: string; readonly older?: true };
export type AgentOffer = { readonly models: readonly ModelOffer[]; /** What "default" is today, when the agent says. */ readonly defaultName?: string };
export type Offers = Partial<Record<"claude-code" | "codex", AgentOffer>>;

/** "Opus 5.5" → opus / [5, 5]; "GPT-6-Sol" → gpt sol / [6]; "GPT-5.5" → gpt / [5, 5]. Null without a version. */
export function familyOf(name: string): { family: string; version: number[] } | null {
  const words = name.toLowerCase().split(/[\s-]+/).filter(Boolean);
  const at = words.findIndex((w) => /^\d+(\.\d+)*$/.test(w));
  if (at < 0) return null;
  return { family: words.filter((_, i) => i !== at).join(" "), version: words[at]!.split(".").map(Number) };
}

const newer = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
};

type Entry = { id: string; name: string; description?: string; upgrade?: string };

/** Older: the agent names an upgrade that it also lists, or another entry of the same family has a higher version. */
export function markOlder(entries: readonly Entry[]): ModelOffer[] {
  const ids = new Set(entries.map((e) => e.id));
  const parsed = entries.map((e) => familyOf(e.name));
  return entries.map((e, i) => {
    const f = parsed[i] ?? null;
    const superseded = (e.upgrade !== undefined && e.upgrade !== e.id && ids.has(e.upgrade))
      || (f !== null && parsed.some((g, j) => j !== i && g !== null && g.family === f.family && newer(g.version, f.version)));
    return { id: e.id, name: e.name, ...(e.description ? { description: e.description } : {}), ...(superseded ? { older: true as const } : {}) };
  });
}

/** Claude Code's picker: its "Default" entry is AgentSwitch's own default (no `--model`), named after what it is today. */
export function claudeOffer(list: readonly ClaudeModelInfo[]): AgentOffer {
  const byDefault = list.find((m) => m.value === "default");
  const defaultName = byDefault?.description.split(" · ")[0]?.trim();
  const seen = new Set<string>();
  const entries = list.filter((m) => m.value !== "default" && !seen.has(m.value) && seen.add(m.value))
    .map((m): Entry => ({ id: m.value, name: m.displayName, ...(m.description ? { description: m.description } : {}) }));
  return { models: markOlder(entries), ...(defaultName ? { defaultName } : {}) };
}

/** Codex's list without the entries it hides. */
export function codexOffer(list: readonly CodexModelInfo[]): AgentOffer {
  const entries = list.filter((m) => !m.hidden).map((m): Entry => ({
    id: m.id, name: m.displayName ?? m.id, ...(m.description ? { description: m.description } : {}), ...(m.upgrade ? { upgrade: m.upgrade } : {}),
  }));
  return { models: markOlder(entries) };
}

export type ModelOffersOptions = {
  readonly claudeExecutable?: string;
  readonly codexBinary?: string;
  readonly log?: (line: string) => void;
  /** Tests: the agents' answers without starting them. */
  readonly listClaude?: () => Promise<ClaudeModelInfo[]>;
  readonly listCodex?: () => Promise<CodexModelInfo[]>;
  /** Tests: what identifies a binary's build (its real path and modification time). */
  readonly signature?: (path: string) => string;
};

export const OFFERS_REFRESH_MS = 6 * 60 * 60_000;
export const OFFERS_BINARY_CHECK_MS = 10 * 60_000;

const fileSignature = (path: string): string => {
  try { const real = realpathSync(path); return `${real}@${statSync(real).mtimeMs}`; } catch { return ""; }
};

export class ModelOffers {
  private offers: Offers = {};
  private signatures = new Map<string, string>();
  private running: Promise<Discovered> | null = null;

  constructor(private readonly o: ModelOffersOptions) {
    for (const path of this.watched()) this.signatures.set(path, this.signature(path));
  }

  current(): Offers { return this.offers; }

  /** Ask both agents (one at a time per call; a call made while one runs waits for it). A failed answer keeps what
   *  that agent offered before. Returns the ids found, for the router's catalog. */
  refresh(): Promise<Discovered> {
    this.running ??= this.ask().finally(() => { this.running = null; });
    return this.running;
  }

  /** Every few hours, and within minutes of an agent's update. The returned function stops it. */
  start(): () => void {
    const every = setInterval(() => void this.refresh(), OFFERS_REFRESH_MS);
    const check = setInterval(() => void this.checkBinaries(), OFFERS_BINARY_CHECK_MS);
    every.unref(); check.unref();
    return () => { clearInterval(every); clearInterval(check); };
  }

  /** A binary built anew (updated, reinstalled): its models are asked for again. True when one was. */
  async checkBinaries(): Promise<boolean> {
    let changed = false;
    for (const path of this.watched()) {
      const now = this.signature(path);
      if (now !== this.signatures.get(path)) { this.signatures.set(path, now); changed = true; }
    }
    if (changed) await this.refresh();
    return changed;
  }

  private watched(): string[] {
    return [this.o.claudeExecutable, this.o.codexBinary].filter((p): p is string => Boolean(p));
  }

  private signature(path: string): string { return (this.o.signature ?? fileSignature)(path); }

  private async ask(): Promise<Discovered> {
    const log = this.o.log ?? ((l: string) => console.error(l));
    const listClaude = this.o.listClaude ?? (() => listClaudeModels(this.o.claudeExecutable));
    const listCodex = this.o.listCodex ?? (this.o.codexBinary ? () => listCodexModels(this.o.codexBinary!) : null);
    const [claude, codex] = await Promise.all([
      listClaude().catch((e: Error) => { log(`model discovery (claude-code): ${e.message}`); return null; }),
      listCodex ? listCodex().catch((e: Error) => { log(`model discovery (codex): ${e.message}`); return null; }) : Promise.resolve(null),
    ]);
    const next: { -readonly [K in keyof Offers]: Offers[K] } = { ...this.offers };
    if (claude?.length) next["claude-code"] = claudeOffer(claude);
    if (codex?.length) next.codex = codexOffer(codex);
    this.offers = next;
    return { "claude-code": claude ? claudeIds(claude) : [], codex: codex ? codexIds(codex) : [] };
  }
}
