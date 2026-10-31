/** The languages (docs/tui-v0.md §5): which one is spoken, every table whole, and none of the screen's words written
 *  into the screen itself. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en.js";
import { LOCALES, localeOf, messages, pickLocale } from "../src/i18n/index.js";

/** Every line of a table, by its path: a string, or a function called with sample arguments. */
function lines(table: unknown, path = ""): [string, unknown][] {
  if (typeof table === "string") return [[path, table]];
  if (typeof table === "function") {
    const args = Array.from({ length: table.length }, (_, i) => (i === 0 ? 2 : "x"));
    return [[path, (table as (...a: unknown[]) => unknown)(...args)]];
  }
  return Object.entries(table as Record<string, unknown>).flatMap(([k, v]) => lines(v, path ? `${path}.${k}` : k));
}

describe("languages", () => {
  it("reads a language from a tag, a POSIX locale or nothing of ours", () => {
    expect(localeOf("zh_CN.UTF-8")).toBe("zh-Hans");
    expect(localeOf("zh-SG")).toBe("zh-Hans");
    expect(localeOf("zh_TW.UTF-8")).toBe("zh-Hant");
    expect(localeOf("zh-Hant-HK")).toBe("zh-Hant");
    expect(localeOf("zh_HK")).toBe("zh-Hant");
    expect(localeOf("ja_JP.UTF-8")).toBe("ja");
    expect(localeOf("es_MX")).toBe("es");
    expect(localeOf("en_GB.UTF-8@euro")).toBe("en");
    expect(localeOf("C.UTF-8")).toBeNull();
    expect(localeOf("de_DE")).toBeNull();
    expect(localeOf("")).toBeNull();
  });

  it("speaks the one asked for, else AGENTSWITCH_LANG, else node.json's, else the locale's, else English", () => {
    const env = { LANG: "ja_JP.UTF-8" };
    expect(pickLocale({ asked: "es", env: { ...env, AGENTSWITCH_LANG: "zh-Hant" }, kept: "zh-Hans" })).toBe("es");
    expect(pickLocale({ env: { ...env, AGENTSWITCH_LANG: "zh-Hant" }, kept: "zh-Hans" })).toBe("zh-Hant");
    expect(pickLocale({ env, kept: "zh-Hans" })).toBe("zh-Hans");
    expect(pickLocale({ env })).toBe("ja");
    // The first of the C library's variables set decides, even one we do not speak; the keeper's C.UTF-8 is English.
    expect(pickLocale({ env: { LC_ALL: "de_DE.UTF-8", LANG: "ja_JP.UTF-8" } })).toBe("en");
    expect(pickLocale({ env: { LC_MESSAGES: "zh_CN.UTF-8", LANG: "C.UTF-8" } })).toBe("zh-Hans");
    expect(pickLocale({ env: { LANG: "C.UTF-8" } })).toBe("en");
    expect(pickLocale({ env: {} })).toBe("en");
  });

  it("has every line in every language, none empty, every function speaking", () => {
    const source = lines(en).map(([k]) => k);
    for (const l of LOCALES) {
      const table = lines(messages(l));
      expect(table.map(([k]) => k), l).toEqual(source);
      for (const [k, v] of table) expect(typeof v === "string" && v.trim().length > 0, `${l} ${k}`).toBe(true);
    }
  });

  it("is translated: Japanese and Spanish whole, Chinese in every sentence (its short words stay English, ui-v0 §7)", () => {
    const source = lines(en);
    const sentence = (v: unknown) => typeof v === "string" && /[.?]$/.test(v.trim());
    for (const l of ["ja", "es"] as const) {
      const same = lines(messages(l)).filter(([k, v], i) => v === source[i]![1] && !/^keys\.|portOpencode$|exitAt$|viaProxy$/.test(k));
      // A few words are the same in Spanish (Proxy, Color, Manual, Local).
      expect(same.map(([k]) => k), l).toEqual(l === "es" ? ["agents.proxy", "agents.color", "agents.proxyTitle", "agents.colorTitle", "permissions.modes.manual", "node.portLocal"] : []);
    }
    for (const l of ["zh-Hans", "zh-Hant"] as const) {
      const untranslated = lines(messages(l)).filter(([, v], i) => sentence(source[i]![1]) && v === source[i]![1]);
      expect(untranslated.map(([k]) => k), l).toEqual([]);
    }
  });

  it("keeps the screen's words in the tables: no Chinese or Japanese written into src/tui/ outside comments", () => {
    const dir = resolve(import.meta.dirname, "..", "src", "tui");
    const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : [p]; });
    const found = files(dir).flatMap((f) => {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      return /[぀-ヿ㐀-鿿가-힯]/.test(code) ? [f] : [];
    });
    expect(found).toEqual([]);
  });
});
