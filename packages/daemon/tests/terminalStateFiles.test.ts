import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { forgetTerminalFiles, sweepAttachments, sweepTerminalFiles } from "../src/terminals/stateFiles.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function terminals(): string {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-state-files-"));
  roots.push(root);
  for (const id of ["aaaaaaaa", "bbbbbbbb", "cccccccc", "not-an-id"]) { mkdirSync(join(root, id)); writeFileSync(join(root, id, "settings.json"), "{}"); }
  writeFileSync(join(root, "bbbbbbbb", "meta.json"), "{}");
  writeFileSync(join(root, "audit.jsonl"), "");
  return root;
}

it("sweeps the folders of ended terminals, keeping live ones, held ones and everything that is not a terminal's", () => {
  const dir = terminals();
  expect(sweepTerminalFiles(dir, new Set(["cccccccc"]))).toBe(1);
  expect(existsSync(join(dir, "aaaaaaaa"))).toBe(false);
  for (const kept of ["bbbbbbbb", "cccccccc", "not-an-id", "audit.jsonl"]) expect(existsSync(join(dir, kept))).toBe(true);
  expect(sweepTerminalFiles(join(dir, "missing"), new Set())).toBe(0);
});

it("forgets one terminal's folder when its program ended, and nothing a terminal id does not name", () => {
  const dir = terminals();
  forgetTerminalFiles(dir, "aaaaaaaa");
  forgetTerminalFiles(dir, "../aaaaaaaa");
  forgetTerminalFiles(dir, "not-an-id");
  expect(existsSync(join(dir, "aaaaaaaa"))).toBe(false);
  expect(existsSync(join(dir, "not-an-id"))).toBe(true);
});

it("sweeps what was sent to terminals that are no more, after its pictures are kept; a folder that could not be kept stays", () => {
  const dir = terminals();
  const kept: string[] = [];
  expect(sweepAttachments(dir, new Set(["cccccccc"]), (folder) => { if (folder.endsWith("bbbbbbbb")) throw new Error("no"); kept.push(folder); })).toBe(1);
  expect(kept).toEqual([join(dir, "aaaaaaaa")]);
  expect(existsSync(join(dir, "aaaaaaaa"))).toBe(false);
  for (const stays of ["bbbbbbbb", "cccccccc", "not-an-id"]) expect(existsSync(join(dir, stays))).toBe(true);
});
