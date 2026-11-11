/** What each agent offers today for a new terminal's model menu (docs/terminal-v0.md §1): its own list, in its own
 *  order, under its own names — Claude Code's picker (`supportedModels()`), Codex's `model/list`, Grok's `grok models`
 *  with the list it keeps (grokModels.ts). A model a newer one of
 *  the same family supersedes (Opus 4.8 under Opus 5.5, GPT-5.6-Sol under GPT-6-Sol), or one the agent names an upgrade
 *  for, is marked older: the menus fold those away, as Claude Code's picker does. Claude's aliases stay aliases
 *  (`opus` follows the next Opus by itself). Asked again every few hours and whenever an agent's binary changes (an
 *  update brings its new models); the router's catalog takes the new ids at the next start. */

import { realpathSync, statSync } from "node:fs";
import { claudeIds, codexDaybreakDefault, codexIds, listClaudeModels, listCodexFeatures, listCodexModels, type ClaudeModelInfo, type CodexDaybreak, type CodexModelInfo, type Discovered } from "./discovery.js";
import { CODEX_DAYBREAK_FEATURE } from "../harness/codexFeatures.js";
import { ordered } from "../harness/efforts.js";
import { grokOwnDefaults, listGrokModels, type GrokModelInfo, type GrokOwnDefaults } from "./grokModels.js";

export type ModelOffer = {
  readonly id: string; readonly name: string; readonly description?: string; readonly older?: true;
  /** How hard it can be asked to think, lowest first (harness/efforts.ts): none for a model that takes no level;
   *  absent when the agent does not say. And the level it uses unless told, when the agent says. */
  readonly efforts?: readonly string[]; readonly defaultEffort?: string;
  /** Codex: whether it runs with Daybreak on, off, or both; absent when Codex does not say (simple-view-v0 §5.8). */
  readonly daybreak?: CodexDaybreak;
};
export type AgentOffer = {
  readonly models: readonly ModelOffer[]; /** What "default" is today, when the agent says. */ readonly defaultName?: string;
  /** The levels of the agent's own default model (no model chosen), and the one it uses unless told. */
  readonly efforts?: readonly string[]; readonly defaultEffort?: string;
  /** Codex has its Daybreak switch here — its program knows the feature and the account has the program — and this
   *  is how its new sessions start (the user's own default). Absent: no switch. */
  readonly daybreak?: boolean;
};

export type Offers = Partial<Record<"claude-code" | "codex" | "grok", AgentOffer>>;

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

type Entry = { id: string; name: string; description?: string; upgrade?: string; efforts?: readonly string[]; defaultEffort?: string; daybreak?: CodexDaybreak };

/** Older: the agent names an upgrade that it also lists, or another entry of the same family has a higher version. */
export function markOlder(entries: readonly Entry[]): ModelOffer[] {
  const ids = new Set(entries.map((e) => e.id));
  const parsed = entries.map((e) => familyOf(e.name));
  return entries.map((e, i) => {
    const f = parsed[i] ?? null;
    const superseded = (e.upgrade !== undefined && e.upgrade !== e.id && ids.has(e.upgrade))
      || (f !== null && parsed.some((g, j) => j !== i && g !== null && g.family === f.family && newer(g.version, f.version)));
    return {
      id: e.id, name: e.name, ...(e.description ? { description: e.description } : {}), ...(superseded ? { older: true as const } : {}),
      ...(e.efforts ? { efforts: ordered(e.efforts) } : {}), ...(e.defaultEffort ? { defaultEffort: e.defaultEffort } : {}),
      ...(e.daybreak ? { daybreak: e.daybreak } : {}),
    };
  });
}

/** Claude Code's picker: its "Default" entry is AgentSwitch's own default (no `--model`), named after what it is today. */
export function claudeOffer(list: readonly ClaudeModelInfo[]): AgentOffer {
  const byDefault = list.find((m) => m.value === "default");
  const defaultName = byDefault?.description.split(" · ")[0]?.trim();
  const seen = new Set<string>();
  // It says the levels of each model that takes them: once it says any, a model it gives none takes none (Haiku).
  const says = list.some((m) => m.efforts?.length);
  const entries = list.filter((m) => m.value !== "default" && !seen.has(m.value) && seen.add(m.value))
    .map((m): Entry => ({ id: m.value, name: m.displayName, ...(m.description ? { description: m.description } : {}), ...(m.efforts ? { efforts: m.efforts } : says ? { efforts: [] } : {}) }));
  return { models: markOlder(entries), ...(defaultName ? { defaultName } : {}), ...(byDefault?.efforts ? { efforts: ordered(byDefault.efforts) } : {}) };
}

/** Codex's list without the entries it hides. */
export function codexOffer(list: readonly CodexModelInfo[]): AgentOffer {
  const entries = list.filter((m) => !m.hidden).map((m): Entry => ({
    id: m.id, name: m.displayName ?? m.id, ...(m.description ? { description: m.description } : {}), ...(m.upgrade ? { upgrade: m.upgrade } : {}),
    ...(m.efforts ? { efforts: m.efforts } : {}), ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    ...(m.daybreak ? { daybreak: m.daybreak } : {}),
  }));
  const own = list.find((m) => m.isDefault);
  return { models: markOlder(entries), ...(own?.efforts ? { efforts: ordered(own.efforts) } : {}), ...(own?.defaultEffort ? { defaultEffort: own.defaultEffort } : {}) };
}

/** Grok's list: "default" is the model new sessions start on — the one the user's own configuration names where it
 *  names one of these (`own`, which a `/model` in any session of theirs changes), else the one Grok said — with the
 *  level that one runs at unless told: the user's own for it where the model takes that level, else Grok's. */
export function grokOffer(list: readonly GrokModelInfo[], own: GrokOwnDefaults = { model: null, effort: null }): AgentOffer {
  const first = list.find((m) => m.id === own.model) ?? list.find((m) => m.isDefault);
  const level = (m: GrokModelInfo): string | undefined => (m === first && own.effort && (!m.efforts || m.efforts.includes(own.effort)) ? own.effort : m.defaultEffort);
  const entries = list.map((m): Entry => {
    const byDefault = level(m);
    return {
      id: m.id, name: m.name ?? m.id, ...(m.description ? { description: m.description } : {}),
      ...(m.efforts ? { efforts: m.efforts } : {}), ...(byDefault ? { defaultEffort: byDefault } : {}),
    };
  });
  const byDefault = first ? level(first) : undefined;
  return {
    models: markOlder(entries), ...(first ? { defaultName: first.name ?? first.id } : {}),
    ...(first?.efforts ? { efforts: ordered(first.efforts) } : {}), ...(byDefault ? { defaultEffort: byDefault } : {}),
  };
}

export type ModelOffersOptions = {
  readonly claudeExecutable?: string;
  readonly codexBinary?: string;
  /** Grok's program, and the folder it keeps its own in (`~/.grok`); absent: Grok is not asked. */
  readonly grokBinary?: string;
  readonly grokHome?: string | null;
  readonly log?: (line: string) => void;
  /** Tests: the agents' answers without starting them. */
  readonly listClaude?: () => Promise<ClaudeModelInfo[]>;
  readonly listCodex?: () => Promise<CodexModelInfo[]>;
  readonly listGrok?: () => Promise<GrokModelInfo[]>;
  /** Tests: the feature flags Codex knows, and how its new sessions start. */
  readonly codexFeatures?: () => Promise<string[]>;
  readonly codexDaybreakDefault?: () => Promise<boolean>;
  /** Tests: what identifies a binary's build (its real path and modification time). */
  readonly signature?: (path: string) => string;
  /** OpenCode's models with their variants (`provider/id` → the variants), from a server of ours that is up. */
  readonly openCodeVariants?: () => Promise<Record<string, string[]>>;
};

export const OFFERS_REFRESH_MS = 6 * 60 * 60_000;
export const OFFERS_BINARY_CHECK_MS = 10 * 60_000;

const fileSignature = (path: string): string => {
  try { const real = realpathSync(path); return `${real}@${statSync(real).mtimeMs}`; } catch { return ""; }
};

export class ModelOffers {
  private offers: Offers = {};
  private variantsNow: Record<string, string[]> = {};
  private lookVariants: (() => Promise<Record<string, string[]>>) | null = null;
  private signatures = new Map<string, string>();
  private running: Promise<Discovered> | null = null;
  /** Grok's models as last listed, and its configuration as it stood when the offer was made from them. */
  private grokList: readonly GrokModelInfo[] | null = null;
  private grokConfig = "";

  constructor(private readonly o: ModelOffersOptions) {
    for (const path of this.watched()) this.signatures.set(path, this.signature(path));
  }

  current(): Offers {
    // Grok's default model and level are the user's to change at any moment (a `/model`, an `/effort` in any session
    // of theirs writes its configuration): the offer follows that file, looked at each time it is asked for.
    const home = this.o.grokHome;
    if (this.grokList && home) {
      const now = this.signature(`${home}/config.toml`);
      if (now !== this.grokConfig) { this.grokConfig = now; this.offers = { ...this.offers, grok: grokOffer(this.grokList, grokOwnDefaults(home)) }; }
    }
    return this.offers;
  }

  /** OpenCode's variants per model (`provider/id`), as last read; none until a server of ours has listed its models. */
  variants(): Readonly<Record<string, readonly string[]>> { return this.variantsNow; }

  /** Codex's Daybreak switch was turned here: its own default went with it (Codex writes it), so new sessions start
   *  that way from now on — said at once, not at the next refresh. */
  noteCodexDaybreak(on: boolean): void {
    const codex = this.offers.codex;
    if (codex?.daybreak !== undefined && codex.daybreak !== on) this.offers = { ...this.offers, codex: { ...codex, daybreak: on } };
  }

  /** Whether Codex has its Daybreak switch: some model of the account's has a Daybreak program, and this program
   *  knows the feature. Then how its new sessions start. Anything not answered: no switch. */
  private async codexDaybreak(list: readonly CodexModelInfo[], log: (line: string) => void): Promise<{ daybreak?: boolean }> {
    if (!list.some((m) => m.daybreak === "also" || m.daybreak === "only")) return {};
    const features = this.o.codexFeatures ?? (this.o.codexBinary ? () => listCodexFeatures(this.o.codexBinary!) : null);
    const byDefault = this.o.codexDaybreakDefault ?? (this.o.codexBinary ? () => codexDaybreakDefault(this.o.codexBinary!) : null);
    if (!features || !byDefault) return {};
    try {
      if (!(await features()).includes(CODEX_DAYBREAK_FEATURE)) return {};
      return { daybreak: await byDefault() };
    } catch (e) { log(`model discovery (codex daybreak): ${(e as Error).message}`); return {}; }
  }

  /** Where OpenCode's variants are read from, once a server of ours is up; read at once and with every refresh. */
  watchOpenCode(look: () => Promise<Record<string, string[]>>): void {
    this.lookVariants = look;
    void this.readVariants();
  }

  private async readVariants(): Promise<void> {
    const look = this.lookVariants ?? this.o.openCodeVariants;
    if (!look) return;
    try {
      const found = await look();
      // A server that has not loaded its models yet lists none: what was read before stands.
      if (Object.keys(found).length) this.variantsNow = found;
    } catch (e) { (this.o.log ?? ((l: string) => console.error(l)))(`model discovery (opencode variants): ${(e as Error).message}`); }
  }

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
    return [this.o.claudeExecutable, this.o.codexBinary, this.o.grokBinary].filter((p): p is string => Boolean(p));
  }

  private signature(path: string): string { return (this.o.signature ?? fileSignature)(path); }

  private async ask(): Promise<Discovered> {
    const log = this.o.log ?? ((l: string) => console.error(l));
    const listClaude = this.o.listClaude ?? (() => listClaudeModels(this.o.claudeExecutable));
    const listCodex = this.o.listCodex ?? (this.o.codexBinary ? () => listCodexModels(this.o.codexBinary!) : null);
    const listGrok = this.o.listGrok ?? (this.o.grokBinary ? () => listGrokModels(this.o.grokBinary!, this.o.grokHome ?? null) : null);
    const [claude, codex, grok] = await Promise.all([
      listClaude().catch((e: Error) => { log(`model discovery (claude-code): ${e.message}`); return null; }),
      listCodex ? listCodex().catch((e: Error) => { log(`model discovery (codex): ${e.message}`); return null; }) : Promise.resolve(null),
      // Only a terminal runs Grok (the router sends it no task): its ids are no part of what is returned.
      listGrok ? listGrok().catch((e: Error) => { log(`model discovery (grok): ${e.message}`); return null; }) : Promise.resolve(null),
    ]);
    const next: { -readonly [K in keyof Offers]: Offers[K] } = { ...this.offers };
    if (claude?.length) next["claude-code"] = claudeOffer(claude);
    if (codex?.length) next.codex = { ...codexOffer(codex), ...(await this.codexDaybreak(codex, log)) };
    if (grok?.length) {
      const home = this.o.grokHome ?? null;
      this.grokList = grok;
      this.grokConfig = home ? this.signature(`${home}/config.toml`) : "";
      next.grok = grokOffer(grok, home ? grokOwnDefaults(home) : undefined);
    }
    this.offers = next;
    await this.readVariants();
    return { "claude-code": claude ? claudeIds(claude) : [], codex: codex ? codexIds(codex) : [] };
  }
}
