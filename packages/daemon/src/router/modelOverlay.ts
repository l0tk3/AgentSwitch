/** Model settings (app-v0 §2 模型设置): $AGENTSWITCH_HOME/models.json, written by the Mac app through PUT
 *  /settings/models, overrides targets.yaml's router model and default target at start-up. Each part is checked against
 *  the catalog; a part that does not fit (or a file that does not parse) is ignored with a warning, never fatal. */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { TargetRef } from "../core/target.js";
import { modelKey, type Targets } from "./targets.js";

export const ModelOverlay = z.object({
  router: z.object({ model: z.string().min(1) }).optional(),
  default: TargetRef.optional(),
});
export type ModelOverlay = z.infer<typeof ModelOverlay>;

export type ModelSettings = {
  readonly router: { readonly model: string; readonly options: readonly string[] };
  readonly default: { readonly harness: string; readonly model: string };
  readonly harnesses: Readonly<Record<string, { readonly models: readonly string[]; readonly default_model: string }>>;
};

/** Selectable ids of one harness: concrete (no `prefix/*` wildcard) and not flagged unavailable by discovery. */
function selectable(targets: Targets, harness: string): string[] {
  const h = targets.harnesses[harness];
  return h ? Object.entries(h.models).filter(([id, spec]) => !id.endsWith("/*") && !spec.unavailable).map(([id]) => id) : [];
}

/** Why `ref` cannot be the default target, or null when it can. */
function defaultProblem(targets: Targets, ref: TargetRef): string | null {
  const h = targets.harnesses[ref.harness];
  if (!h) return `default.harness ${ref.harness} is not in the catalog`;
  const key = modelKey(h, ref.model);
  if (!key) return `default.model ${ref.model} is not a ${ref.harness} model`;
  return h.models[key]?.unavailable ? `default.model ${ref.model} is unavailable` : null;
}

/** Why `model` cannot run the router (it runs on the router harness), or null when it can. */
function routerProblem(targets: Targets, model: string): string | null {
  const h = targets.harnesses[targets.router.harness];
  const key = h ? modelKey(h, model) : undefined;
  if (!h || !key) return `router.model ${model} is not a ${targets.router.harness} model`;
  return h.models[key]?.unavailable ? `router.model ${model} is unavailable` : null;
}

/** Every problem with an overlay against this catalog; [] means it applies whole. */
export function overlayProblems(targets: Targets, overlay: ModelOverlay): string[] {
  return [
    ...(overlay.router ? [routerProblem(targets, overlay.router.model)] : []),
    ...(overlay.default ? [defaultProblem(targets, overlay.default)] : []),
  ].filter((p): p is string => p !== null);
}

/** The catalog with the overlay's valid parts applied; invalid parts are left out and named in `warnings`. Pure. */
export function applyModelOverlay(targets: Targets, overlay: ModelOverlay): { readonly targets: Targets; readonly warnings: readonly string[] } {
  const routerIssue = overlay.router ? routerProblem(targets, overlay.router.model) : null;
  const defaultIssue = overlay.default ? defaultProblem(targets, overlay.default) : null;
  const router = {
    ...targets.router,
    ...(overlay.router && !routerIssue ? { model: overlay.router.model } : {}),
    ...(overlay.default && !defaultIssue ? { default: { harness: overlay.default.harness, model: overlay.default.model } } : {}),
  };
  return { targets: { ...targets, router }, warnings: [routerIssue, defaultIssue].filter((w): w is string => w !== null) };
}

/** The overlay file, or null when absent; a file that does not parse is null plus a warning. */
export function readModelOverlay(path: string): { readonly overlay: ModelOverlay | null; readonly warnings: readonly string[] } {
  if (!existsSync(path)) return { overlay: null, warnings: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (err) { return { overlay: null, warnings: [`${path}: not JSON (${(err as Error).message})`] }; }
  const parsed = ModelOverlay.safeParse(raw);
  return parsed.success ? { overlay: parsed.data, warnings: [] } : { overlay: null, warnings: [`${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`] };
}

/** Start-up: targets.yaml (after discovery) with models.json over it. Warnings go to `warn` (stderr by default). */
export function withModelOverlay(targets: Targets, path: string, warn: (message: string) => void = console.error): Targets {
  const read = readModelOverlay(path);
  const applied = read.overlay ? applyModelOverlay(targets, read.overlay) : { targets, warnings: [] };
  for (const w of [...read.warnings, ...applied.warnings]) warn(`models.json ignored in part: ${w}`);
  return applied.targets;
}

/** Atomic 0600 write: the Mac app and a running daemon never see half a file. */
export function writeModelOverlay(path: string, overlay: ModelOverlay): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(overlay, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** GET /settings/models: router model and its options (the router harness's models), default target, and per harness
 *  the selectable models with targets.yaml's default_model. */
export function modelSettings(targets: Targets): ModelSettings {
  return {
    router: { model: targets.router.model, options: selectable(targets, targets.router.harness) },
    default: { harness: targets.router.default.harness, model: targets.router.default.model },
    harnesses: Object.fromEntries(Object.entries(targets.harnesses).map(([name, h]) => [name, { models: selectable(targets, name), default_model: h.default_model }])),
  };
}
