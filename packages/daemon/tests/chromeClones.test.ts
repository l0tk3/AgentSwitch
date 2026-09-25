/** Chrome's code-sign clones (2026-09-25): every stopped browser left a copy of Chrome's app bundle behind. The sweep
 *  removes the ones no Chrome has open, never a young one, and nothing at all when it cannot tell what is open. */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clonesInOutput, CloneSweeper, MIN_CLONE_AGE_MS, sweepClones } from "../src/executors/chromeClones.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");

function clone(root: string, parent: string, name: string, ageMs: number): string {
  const dir = join(root, parent, name);
  mkdirSync(join(dir, "Google Chrome.app.bundle", "Contents"), { recursive: true });
  writeFileSync(join(dir, "Google Chrome.app.bundle", "Contents", "Info.plist"), "x");
  const t = (NOW - ageMs) / 1000;
  utimesSync(dir, t, t);
  return dir;
}

function tree() {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-clones-"));
  const chrome = "com.google.Chrome.code_sign_clone";
  clone(root, chrome, "code_sign_clone.stale1", 2 * 86_400_000);
  clone(root, chrome, "code_sign_clone.inuse1", 10 * 86_400_000);
  clone(root, chrome, "code_sign_clone.young1", MIN_CLONE_AGE_MS / 2);
  clone(root, "org.chromium.Chromium.code_sign_clone", "code_sign_clone.stale2", 3_600_000);
  clone(root, "com.microsoft.edgemac.code_sign_clone", "code_sign_clone.edge01", 86_400_000);   // not ours to judge
  mkdirSync(join(root, chrome, "something-else"));
  const t = (NOW - 86_400_000) / 1000;
  utimesSync(join(root, chrome, "something-else"), t, t);
  return { root, chrome };
}

describe("Chrome code-sign clones", () => {
  it("finds the clones lsof reports open", () => {
    const out = "p2056\nn/private/var/folders/_c/x/X/com.google.Chrome.code_sign_clone/code_sign_clone.1cVxA1/Google Chrome.app.bundle/Contents/MacOS/Google Chrome\np3000\nn/Applications/Google Chrome.app/Contents/Info.plist\nn/x/code_sign_clone.AbC123\n";
    expect([...clonesInOutput(out)].sort()).toEqual(["code_sign_clone.1cVxA1", "code_sign_clone.AbC123"]);
  });

  it("removes old clones nobody has open; keeps open, young, foreign and odd entries", () => {
    const { root, chrome } = tree();
    const removed = sweepClones(root, new Set(["code_sign_clone.inuse1"]), NOW);
    expect(removed.map((p) => p.split("/").pop()).sort()).toEqual(["code_sign_clone.stale1", "code_sign_clone.stale2"]);
    expect(readdirSync(join(root, chrome)).sort()).toEqual(["code_sign_clone.inuse1", "code_sign_clone.young1", "something-else"]);
    expect(existsSync(join(root, "com.microsoft.edgemac.code_sign_clone", "code_sign_clone.edge01"))).toBe(true);
  });

  it("removes nothing when it cannot tell which clones are open", async () => {
    const { root, chrome } = tree();
    const lines: string[] = [];
    const sweeper = new CloneSweeper({ root, open: async () => null, now: () => NOW, log: (l) => lines.push(l) });
    expect(await sweeper.sweepNow()).toEqual([]);
    expect(readdirSync(join(root, chrome))).toHaveLength(4);
    expect(lines.join("\n")).toMatch(/none removed/);
  });

  it("schedules one sweep after the last request and logs what it removed", async () => {
    const { root } = tree();
    const lines: string[] = [];
    let checks = 0;
    const sweeper = new CloneSweeper({ root, open: async () => { checks++; return new Set(["code_sign_clone.inuse1"]); }, now: () => NOW, delayMs: 5, log: (l) => lines.push(l) });
    sweeper.schedule();
    sweeper.schedule();
    await new Promise((r) => setTimeout(r, 50));
    expect(checks).toBe(1);
    expect(lines).toEqual(["Chrome code-sign clones: removed 2 left behind by stopped browsers"]);
  });

  it("a missing directory is nothing to do", () => {
    expect(sweepClones(join(tmpdir(), "agentswitch-no-such-clones"), new Set(), NOW)).toEqual([]);
  });
});
