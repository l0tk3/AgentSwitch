/** Model settings (app-v0 §2 模型设置): $AGENTSWITCH_HOME/models.json, written by the Mac app through PUT
 *  /settings/models, overrides targets.yaml's router (dispatch) model at start-up. The model is checked against the
 *  catalog; a model that does not fit (or a file that does not parse) is ignored with a warning, never fatal.
 *
 *  The fallback target is always the dispatch model on the router's harness (`router.default`, set in targets.ts and
 *  again here after the overlay). The separate default executor/model (`default` in models.json) was removed on
 *  2026-11-23 by the user's decision, pending a redesign: an older file's `default` is read and ignored. */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { modelKey, type Targets } from "./targets.js";

/** What models.json may hold. `default` is accepted on read (older files) and never applied. */
export const ModelOverlay = z.object({
  router: z.object({ model: z.string().min(1) }).optional(),
  default: z.unknown().optional(),
});
export type ModelOverlay = z.infer<typeof ModelOverlay>;

/** What PUT /settings/models accepts: the router model only. */
export const ModelOverlayChange = z.object({ router: z.object({ model: z.string().min(1) }) }).strict();

export type ModelSettings = {
  readonly router: { readonly model: string; readonly options: readonly string[] };
  /** Always the router target; kept so an older Mac app still decodes the reply. */
  readonly default: { readonly harness: string; readonly model: string };
  readonly harnesses: Readonly<Record<string, { readonly models: readonly string[]; readonly default_model: string }>>;
};

/** Selectable ids of one harness: concrete (no `prefix/*` wildcard) and not flagged unavailable by discovery. */
function selectable(targets: Targets, harness: string): string[] {
  const h = targets.harnesses[harness];
  return h ? Object.entries(h.models).filter(([id, spec]) => !id.endsWith("/*") && !spec.unavailable).map(([id]) => id) : [];
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
  return overlay.router ? [routerProblem(targets, overlay.router.model)].filter((p): p is string => p !== null) : [];
}

/** The catalog with the overlay's router model applied when it fits (else named in `warnings`), and the fallback
 *  target set to the router target. Pure. */
export function applyModelOverlay(targets: Targets, overlay: ModelOverlay): { readonly targets: Targets; readonly warnings: readonly string[] } {
  const routerIssue = overlay.router ? routerProblem(targets, overlay.router.model) : null;
  const model = overlay.router && !routerIssue ? overlay.router.model : targets.router.model;
  const router = { ...targets.router, model, default: { harness: targets.router.harness, model } };
  return { targets: { ...targets, router }, warnings: routerIssue ? [routerIssue] : [] };
}

/** The overlay file, or null when absent; a file that does not parse is null plus a warning. */
export function readModelOverlay(path: string): { readonly overlay: ModelOverlay | null; readonly warnings: readonly string[] } {
  if (!existsSync(path)) return { overlay: null, warnings: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (err) { return { overlay: null, warnings: [`${path}: not JSON (${(err as Error).message})`] }; }
  const parsed = ModelOverlay.safeParse(raw);
  return parsed.success ? { overlay: parsed.data, warnings: [] } : { overlay: null, warnings: [`${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`] };
}

/** Start-up: targets.yaml (after discovery) with models.json over it; the fallback target is the router target either
 *  way. Warnings go to `warn` (stderr by default). */
export function withModelOverlay(targets: Targets, path: string, warn: (message: string) => void = console.error): Targets {
  const read = readModelOverlay(path);
  const applied = applyModelOverlay(targets, read.overlay ?? {});
  for (const w of [...read.warnings, ...applied.warnings]) warn(`models.json ignored in part: ${w}`);
  return applied.targets;
}

/** Atomic 0600 write: the Mac app and a running daemon never see half a file. An older file's `default` is dropped. */
export function writeModelOverlay(path: string, overlay: ModelOverlay): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(overlay.router ? { router: overlay.router } : {}, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** GET /settings/models: router model and its options (the router harness's models), the fallback target (always the
 *  router target), and per harness the selectable models with targets.yaml's default_model. */
export function modelSettings(targets: Targets): ModelSettings {
  return {
    router: { model: targets.router.model, options: selectable(targets, targets.router.harness) },
    default: { harness: targets.router.harness, model: targets.router.model },
    harnesses: Object.fromEntries(Object.entries(targets.harnesses).map(([name, h]) => [name, { models: selectable(targets, name), default_model: h.default_model }])),
  };
}
