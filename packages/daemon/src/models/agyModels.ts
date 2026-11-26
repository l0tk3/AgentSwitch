/** Antigravity CLI's models for a new terminal's model menu (docs/terminal-v0.md §1, §3 Antigravity; 2026-11-26, user
 *  #508). Asked of the program itself, with no model call: `agy models` prints the ids this account may use, each with
 *  the name its picker shows, a tab between them. Seen with 1.5.17 (about five seconds; exit 1 and "Please sign in…"
 *  when nobody is signed in):
 *
 *      Fetching available models...
 *      gemini-4-hydrogen-high	Gemini 4 Hydrogen (High)
 *      gemini-4-hydrogen-low	Gemini 4 Hydrogen (Low)
 *      claude-sonnet-4-6	Claude Sonnet 4.6 (Thinking)
 *      gpt-oss-120b-medium	GPT-OSS 120B (Medium)
 *
 *  How hard a model thinks is a variant of it — the id's ending (`-low`, `-medium`, `-high`, `-xhigh`, `-max`) — and
 *  the menus offer a model once with its levels, not once per level: a model is offered under the id of the variant
 *  the list names first (a real id, which starts it as it is), named without the level, with the levels its variants
 *  have; that first one's is what it uses unless told. An id without such an ending is a model with no level.
 *
 *  Which model a new session starts on is the user's own to change at any moment: `/model` and `/effort` typed in any
 *  session of theirs write the picker's name of it into `settings.json` (`"model": "Gemini 3.8 Flash (High)"`; a
 *  `--model` flag does not: seen). So that is read from the file each time the offer is asked for. */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One line of the list: a variant. */
export type AgyModelInfo = { readonly id: string; readonly label: string };

const MODEL_ID = /^[\w.:/@[\]=-]{1,120}$/;
export const AGY_MODELS_TIMEOUT_MS = 20_000;
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const LEVEL = new RegExp(`-(${LEVELS.join("|")})$`);

/** `agy models` read: the ids in the order printed, each with its name. Lines that are neither are passed over (its
 *  "Fetching…", a notice). */
export function parseAgyModels(output: string): AgyModelInfo[] {
  const out: AgyModelInfo[] = [];
  for (const line of output.split("\n")) {
    const row = /^\s*(\S+)\t+\s*(\S.*?)\s*$/.exec(line);
    if (!row || !MODEL_ID.test(row[1]!) || out.some((m) => m.id === row[1])) continue;
    out.push({ id: row[1]!, label: row[2]! });
  }
  return out;
}

/** A model as the menus offer it: its variants under one entry. */
export type AgyFamily = {
  /** The variant the list names first: what it is started as unless a level is chosen. */
  readonly id: string;
  readonly name: string;
  /** Its levels, as listed; none for a model that has no variants. */
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
  /** Every variant: its id and the name the program shows for it. */
  readonly variants: readonly (AgyModelInfo & { readonly effort: string | null })[];
};

/** `Gemini 4 Hydrogen (High)` without the level it ends in; a name that ends otherwise (`… (Thinking)`) whole. */
function familyName(label: string, level: string): string {
  const m = /^(.*\S)\s*\(([^()]*)\)\s*$/.exec(label);
  return m && m[2]!.trim().toLowerCase() === level ? m[1]! : label;
}

export function agyFamilies(list: readonly AgyModelInfo[]): AgyFamily[] {
  const by = new Map<string, { id: string; name: string; variants: (AgyModelInfo & { effort: string | null })[] }>();
  for (const m of list) {
    const level = LEVEL.exec(m.id)?.[1] ?? null;
    const key = level ? m.id.slice(0, -level.length - 1) : m.id;
    const had = by.get(key);
    if (had) had.variants.push({ ...m, effort: level });
    else by.set(key, { id: m.id, name: level ? familyName(m.label, level) : m.label, variants: [{ ...m, effort: level }] });
  }
  return [...by.values()].map((f) => {
    const efforts = f.variants.flatMap((v) => (v.effort ? [v.effort] : []));
    const first = f.variants[0]!.effort;
    return { id: f.id, name: f.name, efforts, ...(first ? { defaultEffort: first } : {}), variants: f.variants };
  });
}

/** The model the program names (`Gemini 3.8 Flash (High)`, as its status line and its settings do — or an id) as the
 *  menus list it: the entry it belongs to and its level. Null for one that is not listed. */
export function agyNamed(families: readonly AgyFamily[], name: string): { readonly model: string; readonly effort: string | null } | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  for (const f of families) for (const v of f.variants) if (v.label.toLowerCase() === wanted || v.id.toLowerCase() === wanted) return { model: f.id, effort: v.effort };
  return null;
}

/** What the user's own Antigravity starts a session on: `model` in its `settings.json` (the picker's name of it);
 *  null where it sets none or the file cannot be read. */
export function agyOwnModel(home: string): string | null {
  try {
    const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { model?: unknown };
    return typeof settings.model === "string" && settings.model.trim() ? settings.model.trim() : null;
  } catch { return null; }
}

function run(binary: string, args: readonly string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, [...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...(env ?? process.env), AGY_CLI_DISABLE_AUTO_UPDATE: "true" } }, (err, stdout) => {
      // Signed out it says so and fails: there is no list then.
      if (err) reject(err); else resolve(stdout);
    });
  });
}

/** Antigravity's models as it offers them today. `geminiDir`: a home other than `~/.gemini` (tests, probes). */
export async function listAgyModels(binary: string, geminiDir?: string | null, timeoutMs = AGY_MODELS_TIMEOUT_MS, env?: NodeJS.ProcessEnv): Promise<AgyModelInfo[]> {
  const list = parseAgyModels(await run(binary, [...(geminiDir ? [`--gemini_dir=${geminiDir}`] : []), "models"], timeoutMs, env));
  if (!list.length) throw new Error("agy lists no models (not signed in?)");
  return list;
}
