/** Every UI module must at least evaluate: a temporal-dead-zone or import error there blanks the whole console
 *  (seen 2026-09-22: `LOADERS` referenced `loadPolicy` before its `const`). Minimal browser globals are stubbed. */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener: () => undefined, createElement: () => ({ style: {} }), body: { appendChild: () => undefined }, activeElement: null };
  g.window = g;
  g.EventSource = class { addEventListener() {} close() {} };
  g.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });
  g.alert = () => undefined;
  if (!("URL" in g)) g.URL = { createObjectURL: () => "", revokeObjectURL: () => undefined };
});

describe("ui modules evaluate", () => {
  const files = [...readdirSync(join(UI, "lib")).map((f) => `lib/${f}`), ...readdirSync(join(UI, "views")).map((f) => `views/${f}`)].filter((f) => f.endsWith(".js"));
  it.each(files)("%s imports without throwing", async (file) => {
    const mod = await import(join(UI, file));
    expect(mod).toBeTruthy();
  });

  it("every view exports render and bindings", async () => {
    for (const f of files.filter((f) => f.startsWith("views/"))) {
      const mod = (await import(join(UI, f))) as { render?: unknown; bindings?: unknown };
      expect(typeof mod.render, f).toBe("function");
      expect(Array.isArray(mod.bindings), f).toBe(true);
    }
  });
});
