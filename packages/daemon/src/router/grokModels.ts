/** Grok's models for a new terminal's model menu (docs/terminal-v0.md §1, §3 Grok; 2026-11-11). Asked of Grok itself,
 *  with no model call: `grok models` prints the ids this account may use and which one a new session starts on
 *  (`Default model: …`, the user's own choice where they made one); the list Grok keeps beside its settings
 *  (`models_cache.json`, which it refreshes itself) has what the picker shows of each — its name, a line about it, and
 *  how hard it can be asked to think. Seen with Grok 1.0.77:
 *
 *      Default model: grok-4.7
 *
 *      Available models:
 *        * grok-4.7 (default)
 *        - grok-4.7-build-fast
 *
 *  A model the command lists and the kept list does not know is offered under its id; one only the kept list knows is
 *  not offered (the account may not have it). Without the command's answer the kept list alone is offered.
 *
 *  Which model a new session starts on, and at what level, is the user's own to change at any moment: Grok writes
 *  both into its `config.toml` (`[models] default`, `default_reasoning_effort`) whenever `/model` or `/effort` is typed
 *  in any session of theirs — and whenever it is started with `--model` or `--reasoning-effort` (measured 2026-11-11;
 *  which is why a terminal here names them otherwise, terminals/launch.ts). So those two are read from that file each
 *  time the offer is asked for (`grokOwnDefaults`), not kept from the last time the list was. */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EFFORT } from "../harness/efforts.js";

export type GrokModelInfo = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  /** How hard it can be asked to think, as Grok lists them; none for a model that takes no level. */
  readonly efforts?: readonly string[];
  /** The level it uses unless told. */
  readonly defaultEffort?: string;
  /** New sessions start on it. */
  readonly isDefault?: true;
};

const MODEL_ID = /^[\w.:/@[\]=-]{1,120}$/;
export const GROK_MODELS_TIMEOUT_MS = 8000;

/** `grok models` read: the ids in the order printed, and the default. Lines that are neither are passed over (its
 *  greeting, a notice of an update). */
export function parseGrokModels(output: string): { ids: string[]; byDefault: string | null } {
  const ids: string[] = [];
  let byDefault: string | null = null;
  for (const line of output.split("\n")) {
    const named = /^\s*Default model:\s*(\S+)\s*$/i.exec(line)?.[1];
    if (named && MODEL_ID.test(named)) { byDefault = named; continue; }
    const row = /^\s*([*-])\s+(\S+)(\s+\(default\))?\s*$/.exec(line);
    if (!row || !MODEL_ID.test(row[2]!)) continue;
    if (!ids.includes(row[2]!)) ids.push(row[2]!);
    if (row[1] === "*" || row[3]) byDefault ??= row[2]!;
  }
  return { ids, byDefault };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The list Grok keeps (`<home>/models_cache.json`): what it shows of each model it does not hide. Empty when there
 *  is none, or it cannot be read. */
export function grokKeptModels(home: string): GrokModelInfo[] {
  let models: Json;
  try { models = obj(obj(JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8"))).models); } catch { return []; }
  const out: GrokModelInfo[] = [];
  for (const [key, entry] of Object.entries(models)) {
    const info = obj(obj(entry).info);
    const id = str(info.id) ?? key;
    if (!MODEL_ID.test(id) || info.hidden === true) continue;
    const listed = Array.isArray(info.reasoning_efforts) ? info.reasoning_efforts.map(obj) : null;
    const efforts = listed?.map((e) => str(e.value) ?? str(e.id) ?? "").filter((e) => EFFORT.test(e));
    const byDefault = str(listed?.find((e) => e.default === true)?.value) ?? str(info.reasoning_effort);
    const name = str(info.name), description = str(info.description);
    out.push({
      id, ...(name ? { name } : {}), ...(description ? { description } : {}),
      // It says for each model whether it takes a level at all: one that does not takes none.
      ...(efforts?.length ? { efforts } : info.supports_reasoning_effort === false ? { efforts: [] } : {}),
      ...(byDefault && efforts?.includes(byDefault) ? { defaultEffort: byDefault } : {}),
    });
  }
  return out;
}

/** What the user's own Grok starts a session on: the model and the level in the `[models]` table of its `config.toml`
 *  (`default`, `default_reasoning_effort`); null for one it does not set, or sets to no model id or level. Read as
 *  text, a line at a time. */
export type GrokOwnDefaults = { readonly model: string | null; readonly effort: string | null };
export function grokOwnDefaults(home: string): GrokOwnDefaults {
  let text: string;
  try { text = readFileSync(join(home, "config.toml"), "utf8"); } catch { return { model: null, effort: null }; }
  let inModels = false, model: string | null = null, effort: string | null = null;
  for (const line of text.split("\n")) {
    const table = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (table) { inModels = table[1] === "models"; continue; }
    if (!inModels) continue;
    const set = /^\s*(default|default_reasoning_effort)\s*=\s*["']([^"']*)["']/.exec(line);
    if (set?.[1] === "default") model = MODEL_ID.test(set[2]!) ? set[2]! : null;
    if (set?.[1] === "default_reasoning_effort") effort = EFFORT.test(set[2]!) ? set[2]! : null;
  }
  return { model, effort };
}

function run(binary: string, args: readonly string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    // Both streams: it prints its greeting and its list to one or the other by how it was started.
    execFile(binary, [...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) reject(err); else resolve(`${stdout}\n${stderr}`);
    });
  });
}

/** Grok's models as it offers them today: the command's ids and default, each with what the kept list says of it
 *  (the level a model uses unless told is Grok's own for it; the user's own choice is `grokOwnDefaults`). */
export async function listGrokModels(binary: string, home: string | null, timeoutMs = GROK_MODELS_TIMEOUT_MS, env?: NodeJS.ProcessEnv): Promise<GrokModelInfo[]> {
  const kept = home ? grokKeptModels(home) : [];
  const said = await run(binary, ["models"], timeoutMs, env).then(parseGrokModels, () => ({ ids: [] as string[], byDefault: null as string | null }));
  const list: GrokModelInfo[] = said.ids.length ? said.ids.map((id) => kept.find((m) => m.id === id) ?? { id }) : kept;
  if (!list.length) throw new Error("grok lists no models (not signed in?)");
  return list.map((m) => (m.id === said.byDefault ? { ...m, isDefault: true as const } : m));
}
