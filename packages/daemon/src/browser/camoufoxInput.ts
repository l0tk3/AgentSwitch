/** The host's input calls as steps for Playwright's mouse and keyboard (docs/browser-v0.md §7.3 驱动). The host speaks
 *  in the shapes it sends Chrome (input.ts: `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`);
 *  Camoufox is driven through Playwright's public API, which has no modifiers on a mouse event: the keyboard's
 *  modifier keys are pressed and released around it. Pure: the driver plays the steps. */

import type { InputMethod } from "./driver.js";
import { MODIFIERS, type Modifier, type MouseButton } from "./input.js";

export type InputStep =
  | { readonly do: "modifier"; readonly key: Modifier; readonly down: boolean }
  | { readonly do: "move"; readonly x: number; readonly y: number }
  | { readonly do: "press" | "release"; readonly button: MouseButton; readonly clickCount: number }
  | { readonly do: "wheel"; readonly dx: number; readonly dy: number }
  | { readonly do: "key"; readonly key: string; readonly down: boolean }
  | { readonly do: "text"; readonly text: string };

const BIT: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const BUTTONS: readonly string[] = ["left", "right", "middle"];

const num = (v: unknown, fallback = 0): number => typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** The modifier keys to press and release so that exactly those of `bits` are down. */
function sync(bits: number, held: ReadonlySet<Modifier>): { steps: InputStep[]; held: Set<Modifier> } {
  const steps: InputStep[] = [];
  const next = new Set(held);
  for (const key of MODIFIERS) {
    const want = (bits & BIT[key]) !== 0;
    if (want === next.has(key)) continue;
    steps.push({ do: "modifier", key, down: want });
    if (want) next.add(key); else next.delete(key);
  }
  return { steps, held: next };
}

/** The steps for one call, given the modifier keys this page's keyboard holds down, and the keys it holds after. */
export function camoufoxSteps(method: InputMethod, params: Readonly<Record<string, unknown>>, held: ReadonlySet<Modifier>): { readonly steps: readonly InputStep[]; readonly held: ReadonlySet<Modifier> } {
  if (method === "Input.insertText") return { steps: [{ do: "text", text: String(params.text ?? "") }], held };
  const { steps, held: now } = sync(num(params.modifiers), held);
  if (method === "Input.dispatchKeyEvent") {
    const key = String(params.key ?? "");
    // A modifier key of its own is what `sync` already pressed.
    if (key && !(MODIFIERS as readonly string[]).includes(key)) steps.push({ do: "key", key, down: params.type !== "keyUp" });
    return { steps, held: now };
  }
  const button = (BUTTONS.includes(String(params.button)) ? params.button : "left") as MouseButton;
  const clickCount = Math.max(1, num(params.clickCount, 1));
  steps.push({ do: "move", x: num(params.x), y: num(params.y) });
  if (params.type === "mousePressed") steps.push({ do: "press", button, clickCount });
  else if (params.type === "mouseReleased") steps.push({ do: "release", button, clickCount });
  else if (params.type === "mouseWheel") steps.push({ do: "wheel", dx: num(params.deltaX), dy: num(params.deltaY) });
  return { steps, held: now };
}

/** The steps that let go of every modifier key held (input stopped with one down). */
export function releaseAll(held: ReadonlySet<Modifier>): InputStep[] {
  return sync(0, held).steps;
}

/** A fingerprint configuration as Camoufox reads it: JSON in `CAMOU_CONFIG_1`, `_2`, …, cut where an environment
 *  variable may end (its own launcher's limits). */
export function camoufoxEnv(config: Readonly<Record<string, unknown>>, platform: string = process.platform): Record<string, string> {
  const text = JSON.stringify(config);
  const size = platform === "win32" ? 2047 : 32767;
  const env: Record<string, string> = {};
  for (let i = 0; i * size < text.length; i++) env[`CAMOU_CONFIG_${i + 1}`] = text.slice(i * size, (i + 1) * size);
  return env;
}

/** The size of the pictures to ask for: the view at the screen's pixels, within what the watchers take (`maxWidth`,
 *  `maxHeight`), never below the view's own size, both even (the encoder's). */
export function frameSize(view: { readonly width: number; readonly height: number }, ratio: number, max: { readonly maxWidth?: number | undefined; readonly maxHeight?: number | undefined }): { width: number; height: number } {
  let scale = Math.max(1, ratio || 1);
  if (max.maxWidth) scale = Math.min(scale, max.maxWidth / view.width);
  if (max.maxHeight) scale = Math.min(scale, max.maxHeight / view.height);
  scale = Math.max(1, scale);
  return { width: Math.round(view.width * scale) & ~1, height: Math.round(view.height * scale) & ~1 };
}
