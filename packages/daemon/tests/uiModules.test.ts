/** Every UI module the terminals page imports must at least evaluate: a temporal-dead-zone or import error there
 *  blanks the whole page. Minimal browser globals are stubbed. */
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
  const files = readdirSync(join(UI, "lib")).map((f) => `lib/${f}`).filter((f) => f.endsWith(".js"));
  it.each(files)("%s imports without throwing", async (file) => {
    const mod = await import(join(UI, file));
    expect(mod).toBeTruthy();
  });
});
