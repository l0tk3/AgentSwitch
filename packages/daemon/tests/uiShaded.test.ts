/** The web pages' shaded icons (ui/lib/shaded.js, docs/ui-v0.md §9): the same pictures as the Mac's and the phone's, in
 *  six tones of the one ink and no hue; the app's mark with a state on it; a status square as a small key. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type MarkState = "idle" | "busy" | "waiting" | "error" | "off";
type ShadedLib = {
  TONES: Record<string, string>;
  TONE_COLORS: { dark: Record<string, string>; light: Record<string, string> };
  SHADED: Record<string, string[]>;
  digest: () => number;
  cellPx: (points?: number, ratio?: number) => number;
  shaded: (name: string, opts?: { cell?: number; shadow?: boolean; strength?: number; cls?: string; ratio?: number }) => string;
  MARK_LANE: [number, number][][];
  isEnd: (x: number, y: number) => boolean;
  shadedMark: (opts?: { state?: MarkState; t?: number; cell?: number; depth?: boolean; ratio?: number }) => string;
  key: (opts?: { side?: number; hollow?: boolean; cls?: string }) => string;
};
const UI = resolve(import.meta.dirname, "..", "ui");
const S = (await import(join(UI, "lib/shaded.js"))) as ShadedLib;
const count = (text: string, part: string) => text.split(part).length - 1;

describe("the pictures", () => {
  it("are the ones the other copies have", () => {
    // The same number as the Mac's and the phone's ShadedSpritesTests: the three copies are one set. A picture changed
    // here changes it; change the other two copies with it.
    expect(S.digest()).toBe(3771827503);
    expect(Object.keys(S.SHADED)).toEqual(["dispatch", "terminals", "browser", "settings", "list", "splitRight", "splitDown", "new", "lock",
      "lockSmall", "claude-code", "codex", "opencode", "pi", "stack"]);
  });

  it("are rectangles of known tones within the board", () => {
    for (const [name, rows] of Object.entries(S.SHADED)) {
      expect(rows.length, name).toBeGreaterThan(0);
      expect(rows.every((r) => r.length === rows[0]!.length), `${name}: every row is as long as the first`).toBe(true);
      expect(rows[0]!.length, name).toBeLessThanOrEqual(16);
      expect(rows.length, name).toBeLessThanOrEqual(16);
      for (const tone of new Set(rows.join(""))) if (tone !== ".") expect(S.TONES[tone], `${name}: ${tone} is a tone`).toBeTruthy();
    }
  });

  it("have the ink's tones only, greys that turn with the ground, and the styles define them", () => {
    expect(Object.keys(S.TONES)).toEqual(["W", "#", "m", "d", "k", "s"]);
    for (const ground of ["dark", "light"] as const) {
      expect(Object.keys(S.TONE_COLORS[ground])).toEqual(Object.values(S.TONES));
      for (const [name, hex] of Object.entries(S.TONE_COLORS[ground])) {
        const parts = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        expect(Math.max(...parts) - Math.min(...parts), `${name} is a grey`).toBeLessThanOrEqual(24);
      }
    }
    expect(S.TONE_COLORS.dark["--tw"]).toBe("#ffffff");
    expect(S.TONE_COLORS.light["--tw"]).toBe("#000000");
    // Each page's styles carry the tones the pictures are filled with: the terminal page (its light ones come from
    // terminal.js with the screen's colour), the console (dark and light).
    const terminal = readFileSync(join(UI, "terminal.css"), "utf8"), console_ = readFileSync(join(UI, "app.css"), "utf8");
    for (const [name, hex] of Object.entries(S.TONE_COLORS.dark)) {
      expect(terminal, name).toContain(`${name}: ${hex};`);
      expect(console_, name).toContain(`${name}: ${hex};`);
    }
    for (const [name, hex] of Object.entries(S.TONE_COLORS.light)) expect(console_, name).toContain(`${name}: ${hex};`);
    expect(readFileSync(join(UI, "terminal.js"), "utf8")).toContain("...TONE_COLORS.light");
  });
});

describe("a cell", () => {
  it("is a whole number of pixels, never more than asked and at least one", () => {
    expect(S.cellPx(1.5, 2)).toBe(1.5);
    expect(S.cellPx(1.5, 1)).toBe(1);
    expect(S.cellPx(1.5, 3)).toBeCloseTo(4 / 3, 9);
    expect(S.cellPx(2.5, 2)).toBe(2.5);
    expect(S.cellPx(2.5, 1)).toBe(2);
    expect(S.cellPx(0.2, 2)).toBe(0.5);
    expect(S.cellPx(1.5, 0)).toBe(1);
    for (const ratio of [1, 1.25, 2, 3]) for (const points of [0.75, 1, 1.5, 2.5, 3]) {
      const pixels = S.cellPx(points, ratio) * Math.max(1, ratio);
      expect(pixels, `${points} at ${ratio}×`).toBeCloseTo(Math.round(pixels), 9);
      expect(pixels).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("drawing a picture", () => {
  it("fills each cell with its tone, and nothing for a name it does not have", () => {
    const lit = S.SHADED.lockSmall!.join("").replace(/\./g, "").length;
    const svg = S.shaded("lockSmall", { ratio: 2 });
    expect(count(svg, "<rect")).toBe(lit);
    expect(svg).toContain('viewBox="0 0 7 8"');
    expect(svg).toContain('width="10.5" height="12"');
    expect(svg).toContain('fill="var(--tw)"');
    expect(svg).not.toContain("--px-shadow");
    expect(svg).not.toMatch(/fill="#/);
    expect(S.shaded("nothing")).toBe("");
    expect(S.shaded("constructor")).toBe("");
  });

  it("adds a hard shadow a cell down and right, and fades one not in use", () => {
    const lit = S.SHADED.pi!.join("").replace(/\./g, "").length;
    const svg = S.shaded("pi", { shadow: true, strength: 0.6, cls: "agent", ratio: 2 });
    expect(count(svg, "<rect")).toBe(lit * 2);
    expect(count(svg, "var(--px-shadow)")).toBe(lit);
    expect(svg).toContain('viewBox="0 0 10 10"');
    expect(svg).toContain('opacity="0.6"');
    expect(svg).toContain('class="px shaded agent"');
    expect(S.shaded("pi", { ratio: 2 })).not.toContain("opacity");
  });
});

describe("the app's mark", () => {
  const rows = S.SHADED.stack!;
  const cells = rows.join("").replace(/\./g, "").length;
  const bar = rows.flatMap((row, y) => [...row].flatMap((c, x) => (c !== "." && S.isEnd(x, y) ? [`${x},${y}`] : [])));

  it("has its title bar and the block's way along it on the picture", () => {
    expect(bar).toHaveLength(22);
    expect(S.isEnd(11, 6), "the window behind shows through the front one's clipped corner").toBe(false);
    const lane = S.MARK_LANE.flat().map(([x, y]) => `${x},${y}`);
    expect(S.MARK_LANE).toHaveLength(5);
    expect(S.MARK_LANE.every((step) => step.length === 4)).toBe(true);
    expect(new Set(lane).size).toBe(lane.length);
    for (const at of lane) expect(bar, `${at} is the title bar's`).toContain(at);
  });

  it("is the picture when idle, with a shadow as an identity mark", () => {
    const flat = S.shadedMark({ ratio: 2 });
    expect(count(flat, "<rect")).toBe(cells);
    expect(flat).not.toMatch(/--cyan|--amber|--red/);
    expect(flat).toContain('viewBox="0 0 16 14"');
    const deep = S.shadedMark({ depth: true, ratio: 2 });
    expect(count(deep, "var(--px-shadow)")).toBe(cells);
    expect(deep).toContain('viewBox="0 0 17 15"');
    expect(deep).toContain('width="25.5"');
  });

  it("turns the title bar cyan while busy and runs a light block along it, a trail behind it with depth", () => {
    const at = (t: number) => S.shadedMark({ state: "busy", t, ratio: 2 });
    expect(count(at(0), 'fill="var(--cyan)"')).toBe(22);
    expect(count(at(0), 'fill="#fff"/>')).toBe(4);
    expect(at(0)).toContain('<rect x="1" y="6" width="1" height="1" fill="#fff"/>');
    expect(at(4)).toContain('<rect x="10" y="7" width="1" height="1" fill="#fff"/>');
    expect(at(5)).toBe(at(0));
    const deep = S.shadedMark({ state: "busy", t: 3, depth: true, ratio: 2 });
    expect(deep).toContain("feGaussianBlur");
    expect(deep).toContain('fill="#fff" opacity="0.55"');
    expect(deep).toContain('fill="#fff" opacity="0.25"');
  });

  it("turns the title bar amber while something waits, blinking under three times a second, red on an error", () => {
    const waiting = S.shadedMark({ state: "waiting", t: 0, ratio: 2 });
    expect(count(waiting, "var(--amber)")).toBe(22);
    expect(waiting).toContain('fill="#fff" opacity="0.45"');
    expect(waiting).toContain('fill="#000" opacity="0.35"');
    expect(S.shadedMark({ state: "waiting", t: 3, ratio: 2 })).toBe(waiting);
    expect(S.shadedMark({ state: "waiting", t: 4, ratio: 2 })).toContain('fill="var(--amber)" opacity="0.25"');
    expect(S.shadedMark({ state: "waiting", t: 8, ratio: 2 })).toBe(waiting);
    const error = S.shadedMark({ state: "error", t: 5, ratio: 2 });
    expect(count(error, "var(--red)")).toBe(22);
    expect(error).not.toContain("--amber");
  });

  it("loses every other cell when off", () => {
    const off = S.shadedMark({ state: "off", ratio: 2 });
    const kept = rows.flatMap((row, y) => [...row].filter((c, x) => c !== "." && (x + y) % 2 === 0)).length;
    expect(count(off, "<rect")).toBe(kept);
    expect(kept).toBeLessThan(cells);
  });
});

describe("a status square", () => {
  it("is a small key in the text's colour: light above and left, dark below and right", () => {
    const svg = S.key();
    expect(svg).toContain('width="8" height="8"');
    expect(svg).toContain('<rect width="8" height="8" fill="currentColor"/>');
    expect(svg.indexOf('fill="#fff" opacity="0.45"')).toBeGreaterThan(0);
    expect(svg.indexOf('fill="#000" opacity="0.35"')).toBeGreaterThan(svg.indexOf('fill="#fff" opacity="0.45"'));
  });

  it("is the key's empty seat when hollow: a ring, dark above and left, light below and right", () => {
    const svg = S.key({ hollow: true });
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('fill="currentColor"');
    expect(svg.indexOf('fill="#000" opacity="0.35"')).toBeLessThan(svg.indexOf('fill="#fff" opacity="0.3"'));
    expect(S.key({ side: 6, cls: "x" })).toContain('class="px key x" width="6"');
  });
});
