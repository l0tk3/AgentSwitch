import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTargets, type Targets } from "../src/router/targets.js";

export const TARGETS_PATH = resolve(import.meta.dirname, "..", "config", "targets.yaml");

export function realTargets(): Targets {
  return parseTargets(readFileSync(TARGETS_PATH, "utf8"));
}

export function decisionJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ harness: "codex", model: "gpt-6-astra", effort: "high", brief: "do it", confidence: 0.9, ...over });
}
