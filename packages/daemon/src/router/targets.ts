/** Routing catalog: schema, loader and lookups. Pure; nothing here talks to a harness. */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const Cost = z.enum(["free", "low", "mid", "high", "top"]);

export const ModelSpec = z.object({
  cost: Cost,
  strengths: z.array(z.string()).default([]),
  efforts: z.array(z.string()).optional(),
  unavailable: z.boolean().optional(),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

export const HarnessSpec = z.object({
  quota: z.enum(["local-count", "rate-limits", "balance"]),
  max_concurrent: z.number().int().positive(),
  browser: z.boolean(),
  default_model: z.string().min(1),
  binary: z.string().optional(),
  models: z.record(z.string().min(1), ModelSpec),
});
export type HarnessSpec = z.infer<typeof HarnessSpec>;

export const TargetRef = z.object({ harness: z.string().min(1), model: z.string().min(1) });
export type TargetRef = z.infer<typeof TargetRef>;

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
      timeout_ms: z.number().int().positive().default(20_000),
      min_confidence: z.number().min(0).max(1).default(0.5),
      quota_threshold: z.number().min(0).max(1).default(0.05),
      default: TargetRef,
    }),
  })
  .superRefine((t, ctx) => {
    for (const [name, h] of Object.entries(t.harnesses)) {
      if (!modelKey(h, h.default_model)) {
        ctx.addIssue({ code: "custom", message: `harness ${name}: default_model ${h.default_model} not in models` });
      }
    }
    const d = t.harnesses[t.router.default.harness];
    if (!d || !modelKey(d, t.router.default.model)) {
      ctx.addIssue({ code: "custom", message: "router.default must name a listed harness/model" });
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

/** The catalog key that admits `model`: exact, or a `prefix/*` wildcard. */
export function modelKey(harness: HarnessSpec, model: string): string | undefined {
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
      lines.push(`  - ${m}: cost ${spec.cost}; ${spec.strengths.join(", ")}${efforts}`);
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
