/** Every UI module must at least evaluate: a temporal-dead-zone or import error there blanks the whole console
 *  (seen 2026-09-22: `LOADERS` referenced `loadPolicy` before its `const`). Minimal browser globals are stubbed. */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

/** docs/ui-v0.md §7.2 第 7 条 (2026-10-01): short words in title case; what starts with a number stays a unit, and the
 *  API's status values (the tone is a CSS class) stay as they are. */
describe("short words", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("status words in title case, their tones unchanged", async () => {
    const { statusTone, statusWord } = await import(join(UI, "lib/api.js"));
    const statuses = ["queued", "routing", "running", "waiting_approval", "done", "partial", "blocked", "failed", "cancelled"];
    expect(statuses.map((status) => statusWord({ status }))).toEqual(["Queued", "Busy", "Busy", "Waiting", "Done", "Incomplete", "Incomplete", "Failed", "Cancelled"]);
    expect(statusWord({ status: "blocked", blockCause: "question" })).toBe("Waiting");
    expect(statuses.map((status) => statusTone({ status }))).toEqual(["busy", "busy", "busy", "waiting", "ok", "waiting", "waiting", "bad", "off"]);
    expect(statusTone({ status: "blocked", blockCause: "question" })).toBe("waiting");
  });

  it("a lone time word capitalized, a number first as it is", async () => {
    const now = new Date(2026, 9, 1, 18, 0);
    vi.useFakeTimers({ now });
    const { agoShort, dayOf } = await import(join(UI, "lib/api.js"));
    const at = (...parts: number[]) => new Date(...(parts as [number, number, number, number, number])).getTime();
    expect(agoShort(now.getTime() - 20_000)).toBe("Now");
    expect(agoShort(now.getTime() - 3 * 60_000)).toBe("3m ago");
    expect(agoShort(now.getTime() - 2 * 3_600_000)).toBe("2h ago");
    expect(agoShort(at(2026, 9, 1, 9, 5))).toBe("Today 09:05");
    expect(agoShort(at(2026, 8, 30, 6, 57))).toBe("Yesterday 06:57");
    expect(agoShort(at(2026, 8, 28, 12, 0))).toBe("9/28");
    expect([dayOf(at(2026, 9, 1, 9, 5)), dayOf(at(2026, 8, 30, 6, 57)), dayOf(at(2026, 8, 28, 12, 0))]).toEqual(["Today", "Yesterday", "9/28"]);
  });
});
