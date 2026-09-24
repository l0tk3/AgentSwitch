/** Routing catalog: schema, loader and lookups. Pure; nothing here talks to a harness. */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { TargetRef } from "../core/target.js";
import { SupervisorConfig } from "./supervisor.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../core/limits.js";

/** targets.yaml defaults: one router-model call, and one planner call (process start and a JSON correction included). */
const ROUTER_TIMEOUT_MS = 20_000;
const PLANNER_TIMEOUT_MS = 120_000;

export const Cost = z.enum(["free", "low", "mid", "high", "top"]);

export const ModelSpec = z.object({
  cost: Cost,
  strengths: z.array(z.string()).default([]),
  efforts: z.array(z.string()).optional(),
  unavailable: z.boolean().optional(),
  /** The user's most trusted models (2026-09-24: Opus, GPT-6): the router gives them real work (router-v0 §5). */
  preferred: z.boolean().optional(),
});
export type ModelSpec = z.infer<typeof ModelSpec>;
export type CostTier = z.infer<typeof Cost>;

export const HarnessSpec = z.object({
  quota: z.enum(["local-count", "rate-limits", "balance"]),
  max_concurrent: z.number().int().positive(),
  browser: z.boolean(),
  default_model: z.string().min(1),
  /** Wall-clock limit for one execution; the executor is killed past it (transport failure → retry/reroute). */
  timeout_ms: z.number().int().positive().default(DEFAULT_EXECUTOR_TIMEOUT_MS),
  binary: z.string().optional(),
  models: z.record(z.string().min(1), ModelSpec),
  /** Ids never used, even when model discovery lists them or a wildcard would admit them (the user's call). */
  exclude: z.array(z.string().min(1)).optional(),
});
export type HarnessSpec = z.infer<typeof HarnessSpec>;

/** A task category whose executors are restricted to `allow` (e.g. security work most models refuse). */
export const Category = z.object({
  description: z.string().min(1),
  keywords: z.array(z.string().min(1)).default([]),
  allow: z.array(TargetRef).min(1),
  note: z.string().default(""),
});
export type Category = z.infer<typeof Category>;

export const Targets = z
  .object({
    harnesses: z.record(z.string().min(1), HarnessSpec),
    categories: z.record(z.string().min(1), Category).default({}),
    router: z.object({
      harness: z.string().min(1),
      model: z.string().min(1),
      timeout_ms: z.number().int().positive().default(ROUTER_TIMEOUT_MS),
      /** Independent planner invocation, including process startup and one JSON correction. */
      planner_timeout_ms: z.number().int().positive().default(PLANNER_TIMEOUT_MS),
      min_confidence: z.number().min(0).max(1).default(0.5),
      quota_threshold: z.number().min(0).max(1).default(0.05),
      /** Below this the router's thread assignment is not trusted: the user is asked (threads-v0 §6). */
      thread_confidence: z.number().min(0).max(1).default(0.6),
      /** docs/supervisor-v0.md: approvals on the user's behalf, watchdog, acceptance. */
      supervisor: SupervisorConfig.prefault({}),
      default: TargetRef,
      /** loop-v0 §6: the model that runs multi-step tasks; absent = the router itself. */
      planner: TargetRef.nullable().default(null),
    }),
  })
  .superRefine((t, ctx) => {
    for (const [name, h] of Object.entries(t.harnesses)) {
      for (const id of h.exclude ?? []) {
        if (id in h.models) ctx.addIssue({ code: "custom", message: `harness ${name}: ${id} is both listed and excluded` });
      }
      if (!modelKey(h, h.default_model)) {
        ctx.addIssue({ code: "custom", message: `harness ${name}: default_model ${h.default_model} not in models` });
      }
    }
    const d = t.harnesses[t.router.default.harness];
    if (!d || !modelKey(d, t.router.default.model)) {
      ctx.addIssue({ code: "custom", message: "router.default must name a listed harness/model" });
    }
    const p = t.router.planner ? t.harnesses[t.router.planner.harness] : undefined;
    if (t.router.planner && (!p || !modelKey(p, t.router.planner.model))) {
      ctx.addIssue({ code: "custom", message: "router.planner must name a listed harness/model" });
    }
    for (const [name, cat] of Object.entries(t.categories)) {
      for (const ref of cat.allow) {
        const h = t.harnesses[ref.harness];
        if (!h || !modelKey(h, ref.model)) ctx.addIssue({ code: "custom", message: `categories.${name}: ${ref.harness}/${ref.model} not in catalog` });
      }
    }
  });
export type Targets = z.infer<typeof Targets>;

export function parseTargets(text: string): Targets {
  return Targets.parse(parse(text));
}

export function loadTargets(path: string): Targets {
  return parseTargets(readFileSync(path, "utf8"));
}

/** The catalog key that admits `model`: exact, or a `prefix/*` wildcard; never an excluded id. Every floor check
 *  (pins, router and planner picks, defaults, categories) goes through here. */
export function modelKey(harness: HarnessSpec, model: string): string | undefined {
  if (harness.exclude?.includes(model)) return undefined;
  if (model in harness.models) return model;
  for (const key of Object.keys(harness.models)) {
    if (key.endsWith("/*") && model.startsWith(key.slice(0, -1)) && model.length > key.length - 1) return key;
  }
  return undefined;
}

export function modelSpec(harness: HarnessSpec, model: string): ModelSpec | undefined {
  const key = modelKey(harness, model);
  return key === undefined ? undefined : harness.models[key];
}

/** Copy of the catalog with the given models flagged unavailable (discovery said the backend lacks them). */
export function markUnavailable(targets: Targets, missing: readonly TargetRef[]): Targets {
  const harnesses = Object.fromEntries(
    Object.entries(targets.harnesses).map(([name, h]) => {
      const models = Object.fromEntries(
        Object.entries(h.models).map(([m, spec]) => {
          const gone = missing.some((ref) => ref.harness === name && ref.model === m);
          return [m, gone ? { ...spec, unavailable: true } : spec];
        }),
      );
      return [name, { ...h, models }];
    }),
  );
  return { ...targets, harnesses };
}

/** Compact catalog text for the router prompt: one line per model, no enforcement fields. */
export function catalogText(targets: Targets): string {
  const lines: string[] = [];
  for (const [name, h] of Object.entries(targets.harnesses)) {
    lines.push(`harness ${name} (browser: ${h.browser ? "yes" : "no"}, default: ${h.default_model})`);
    for (const [m, spec] of Object.entries(h.models)) {
      if (spec.unavailable) continue;
      const efforts = spec.efforts ? `; efforts: ${spec.efforts.join("/")}` : "";
      lines.push(`  - ${m}: cost ${spec.cost}; ${spec.strengths.join(", ")}${spec.preferred ? "; preferred" : ""}${efforts}`);
    }
  }
  for (const [name, cat] of Object.entries(targets.categories)) {
    lines.push(`\ncategory "${name}": ${cat.description}`);
    lines.push(`  only these targets accept it${cat.note ? ` (${cat.note})` : ""}: ${cat.allow.map((r) => `${r.harness}/${r.model}`).join(", ")}`);
  }
  return lines.join("\n");
}

/** ASCII keywords match whole words ("rop" must not match "drop"); anything else matches as a substring. */
export function keywordMatches(keyword: string, text: string): boolean {
  const k = keyword.toLowerCase();
  if (!/^[\x20-\x7e]+$/.test(k)) return text.includes(k);
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = /[a-z0-9]$/.test(k) ? "(?![a-z0-9])" : "";
  return new RegExp(`(?<![a-z0-9])${escaped}${tail}`).test(text);
}

/** Keyword floor: the first category whose keywords appear in the task text (case-insensitive). */
export function categoryOf(task: string, targets: Targets): string | null {
  const text = task.toLowerCase();
  for (const [name, cat] of Object.entries(targets.categories)) {
    if (cat.keywords.some((k) => keywordMatches(k, text))) return name;
  }
  return null;
}

/** Whether `ref` may run a task of `category`; unknown or null categories restrict nothing. */
export function allowedFor(targets: Targets, category: string | null, ref: TargetRef): boolean {
  const cat = category === null ? undefined : targets.categories[category];
  if (!cat) return true;
  return cat.allow.some((a) => a.harness === ref.harness && a.model === ref.model);
}
