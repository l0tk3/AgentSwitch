/** The languages AgentSwitch's own words come in (docs/tui-v0.md §5), starting with `agentswitch config`. English is
 *  the source: its table's shape is the type every other table is held to, so a line missing or added, or a line taking
 *  other arguments, fails the type check. What the service says (its errors) is shown as it says it. */

import { en, type Messages } from "./en.js";
import { es } from "./es.js";
import { ja } from "./ja.js";
import { zhHans } from "./zh-Hans.js";
import { zhHant } from "./zh-Hant.js";

export type { Messages } from "./en.js";

export const LOCALES = ["en", "zh-Hans", "zh-Hant", "ja", "es"] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language by its own name, as the language picker lists it. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { en: "English", "zh-Hans": "简体中文", "zh-Hant": "繁體中文", ja: "日本語", es: "Español" };

const TABLES: Readonly<Record<Locale, Messages>> = { en, "zh-Hans": zhHans, "zh-Hant": zhHant, ja, es };

export function messages(locale: Locale): Messages {
  return TABLES[locale];
}

/** The language a tag names — `zh-Hant`, `zh_TW.UTF-8`, `ja_JP`, `es`, `C.UTF-8` — or null for none of ours. Chinese
 *  of Taiwan, Hong Kong and Macao, and any tag that says Hant, is the traditional script; other Chinese the simplified. */
export function localeOf(tag: string | undefined | null): Locale | null {
  const text = tag?.trim();
  if (!text) return null;
  const exact = LOCALES.find((l) => l.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  const [lang = "", ...rest] = text.split(/[.@]/)[0]!.split(/[-_]/).map((p) => p.toLowerCase());
  if (lang === "zh") return rest.some((p) => p === "hant" || p === "tw" || p === "hk" || p === "mo") ? "zh-Hant" : "zh-Hans";
  return LOCALES.find((l) => l === lang) ?? null;
}

/** The language to speak: the one asked for (`--lang`), else `AGENTSWITCH_LANG`, else the one kept in node.json, else
 *  the locale's (`LC_ALL`, `LC_MESSAGES`, `LANG`, as the C library reads them), else English. */
export function pickLocale(o: { readonly asked?: string | undefined; readonly env?: NodeJS.ProcessEnv; readonly kept?: string | undefined }): Locale {
  const env = o.env ?? process.env;
  for (const tag of [o.asked, env.AGENTSWITCH_LANG, o.kept]) {
    const l = localeOf(tag);
    if (l) return l;
  }
  // The first of the C library's variables that is set decides, even when it names a language we do not have.
  const sys = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v?.trim());
  return localeOf(sys) ?? "en";
}
