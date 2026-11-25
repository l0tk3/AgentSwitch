/** Routing catalog: schema, loader and lookups. Pure; nothing here talks to a harness. */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { TargetRef } from "../core/target.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../core/limits.js";

/** targets.yaml defaults: one router-model call, and one planner call (process start and a JSON correction included). */
const ROUTER_TIMEOUT_MS = 20_000;
const PLANNER_TIMEOUT_MS = 120_000;

/** docs/supervisor-v0.md (kept with the catalog's schema: targets.yaml may carry it). */
export const SupervisorConfig = z.object({
  approvals: z.boolean().default(true),
  watchdog_ms: z.number().int().min(0).default(3 * 60_000),
  acceptance: z.boolean().default(true),
  max_continues: z.number().int().min(0).default(3),
});
export type SupervisorConfig = z.infer<typeof SupervisorConfig>;

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
      /** The router model's reasoning level for every call on it (dispatch, the assistant, acceptance, summaries): an
       *  OpenCode variant of the model (DeepSeek V4.1 Flash: none, low, high, max); null = the model's default. Used on
       *  the resident server only, and only when the model has it. */
      effort: z.string().min(1).nullable().default(null),
      timeout_ms: z.number().int().positive().default(ROUTER_TIMEOUT_MS),
      /** Independent planner invocation, including process startup and one JSON correction. */
      planner_timeout_ms: z.number().int().positive().default(PLANNER_TIMEOUT_MS),
      min_confidence: z.number().min(0).max(1).default(0.5),
      quota_threshold: z.number().min(0).max(1).default(0.05),
      /** Below this the router's thread assignment is not trusted: the user is asked (threads-v0 §6). */
      thread_confidence: z.number().min(0).max(1).default(0.6),
      /** docs/supervisor-v0.md: approvals on the user's behalf, watchdog, acceptance. */
      supervisor: SupervisorConfig.prefault({}),
      /** The fallback target: always the dispatch model on the router's harness (set below from `harness` and `model`).
       *  A separate default executor/model was removed on 2026-11-23 (user decision, pending a redesign); a `default`
       *  still written in a targets.yaml is read and ignored. */
      default: z.unknown().optional(),
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
    const r = t.harnesses[t.router.harness];
    if (!r || !modelKey(r, t.router.model)) {
      ctx.addIssue({ code: "custom", message: "router.model must be a listed model of router.harness" });
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
  })
  .transform((t) => ({ ...t, router: { ...t.router, default: { harness: t.router.harness, model: t.router.model } as TargetRef } }));
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

/** The models of one agent a person may pick, in the catalog's order: concrete ids (no `prefix/*` wildcard), none
 *  flagged unavailable. What a terminal's model menu lists of an agent that has not said what it offers. */
export function selectableModels(targets: Targets, harness: string): string[] {
  const h = targets.harnesses[harness];
  return h ? Object.entries(h.models).filter(([id, spec]) => !id.endsWith("/*") && !spec.unavailable).map(([id]) => id) : [];
}
