import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProfileBrowsers } from "../src/browser/fleet.js";
import { removeOwnBrowserFiles, sweepOwnBrowserFiles } from "../src/browser/setup.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const FOLDERS = (key: string) => [`browser-profiles/${key}`, `browser-profiles/${key}-camoufox`, `browser/of/${key}`];
function home(): string {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-own-browser-files-"));
  roots.push(root);
  for (const dir of [...FOLDERS("claude-code.kept000000"), ...FOLDERS("claude-code.gone000000"), "browser-profiles/codex.gone111111-camoufox", "browser-profiles/main", "browser-profiles/main-camoufox", "browser-profiles/slot-1", "browser/sessions", "browser/engine"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "cookies"), "x");
  }
  writeFileSync(join(root, "browser-profiles", "slots.json"), "{}");
  return root;
}

it("sweeps the browser folders of profiles that are no more, and nothing else", () => {
  const root = home();
  expect(sweepOwnBrowserFiles(root, (key) => key === "claude-code.kept000000")).toEqual(["claude-code.gone000000", "codex.gone111111"]);
  for (const gone of [...FOLDERS("claude-code.gone000000"), "browser-profiles/codex.gone111111-camoufox"]) expect(existsSync(join(root, gone))).toBe(false);
  for (const kept of [...FOLDERS("claude-code.kept000000"), "browser-profiles/main", "browser-profiles/main-camoufox", "browser-profiles/slot-1", "browser-profiles/slots.json", "browser/sessions", "browser/engine"]) expect(existsSync(join(root, kept))).toBe(true);
  expect(sweepOwnBrowserFiles(root, (key) => key === "claude-code.kept000000")).toEqual([]);
});

it("removes one profile's folders, and nothing for a name that is no profile's key", () => {
  const root = home();
  removeOwnBrowserFiles(root, "main");
  removeOwnBrowserFiles(root, "../browser");
  removeOwnBrowserFiles(root, "claude-code.gone000000");
  for (const gone of FOLDERS("claude-code.gone000000")) expect(existsSync(join(root, gone))).toBe(false);
  for (const kept of ["browser-profiles/main", "browser-profiles/main-camoufox", "browser/sessions", ...FOLDERS("claude-code.kept000000")]) expect(existsSync(join(root, kept))).toBe(true);
});

it("a removed profile's browser is stopped before its folders are deleted", async () => {
  const order: string[] = [];
  const browser = { agents: { shutdown: async () => { order.push("agents"); } }, host: { shutdown: async () => { order.push("host"); } }, stop: async () => { order.push("stop"); } };
  const fleet = new ProfileBrowsers(() => browser as never, { address: async () => ({}) as never }, () => ({ proxy: null }), (key) => order.push(`forget ${key}`));
  fleet.of("claude-code.gone000000");
  await fleet.remove("claude-code.gone000000");
  expect(order).toEqual(["agents", "host", "stop", "forget claude-code.gone000000"]);
  expect(fleet.get("claude-code.gone000000")).toBeNull();
  await fleet.remove("claude-code.never00000");
  expect(order.at(-1)).toBe("forget claude-code.never00000");
});
