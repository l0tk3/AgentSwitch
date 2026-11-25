import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTargets, type Targets } from "../src/models/targets.js";

/** A task folder of its own beside the daemon's temporary home. Not "/tmp": on Linux that is the temporary folder
 *  itself, so it holds the daemon's home and the cwd policy rightly refuses it (macOS's is under /var/folders). */
export const workDir = (): string => mkdtempSync(join(tmpdir(), "agentswitch-work-"));

export const TARGETS_PATH = resolve(import.meta.dirname, "..", "config", "targets.yaml");

export function realTargets(): Targets {
  return parseTargets(readFileSync(TARGETS_PATH, "utf8"));
}

export function decisionJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ harness: "codex", model: "gpt-6-astra", effort: "high", brief: "do it", confidence: 0.9, ...over });
}
