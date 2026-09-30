import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { describe, expect, it } from "vitest";
import { screenView } from "../src/terminals/screenView.js";

const write = (t: InstanceType<typeof headless.Terminal>, s: string) => new Promise<void>((r) => t.write(s, r));
const rows = (t: InstanceType<typeof headless.Terminal>) => {
  const b = t.buffer.active;
  return Array.from({ length: t.rows }, (_, y) => b.getLine(b.viewportY + y)?.translateToString(true) ?? "");
};

// 2026-09-30, user: OpenCode 在 iPhone 上乱码. A full-screen program on a narrowed screen: the snapshot is what shows.
describe("a snapshot after the screen narrows", () => {
  it("carries the rows as wide as the screen, not the old wider ones", async () => {
    const term = new headless.Terminal({ cols: 70, rows: 4, allowProposedApi: true });
    const ser = new serialize.SerializeAddon();
    ser.activate(screenView(term) as unknown as Parameters<typeof ser.activate>[0]);
    await write(term, "\x1b[?1049h\x1b[1;1H" + "A".repeat(70) + "\x1b[2;1H" + "B".repeat(70));
    term.resize(50, 4);
    await write(term, "\x1b[1;1H" + "x".repeat(50) + "\x1b[2;1H" + "y".repeat(50));
    expect(term.buffer.alternate.getLine(0)?.length).toBe(70);   // xterm keeps them (the reason for the view)

    const drawn = new headless.Terminal({ cols: 50, rows: 4, allowProposedApi: true });
    await write(drawn, ser.serialize());
    expect(rows(drawn).slice(0, 3)).toEqual(["x".repeat(50), "y".repeat(50), ""]);
    expect(ser.serialize()).not.toContain("A");
  });
});
