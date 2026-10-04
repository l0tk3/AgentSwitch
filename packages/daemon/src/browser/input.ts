/** A screen's input as CDP `Input.*` calls (browser-v0 §1 操作): points on the frame mapped to the page's CSS pixels
 *  (and on to the view's pixels when the host draws the view at a scale, browser-v0 §5),
 *  mouse buttons kept pressed between down and up (a drag selects), text inserted as it is (the system keyboard's), and a
 *  small set of named keys with modifiers. On the Mac, Chrome only edits text for a key when the macOS editing command
 *  comes with it, as Playwright sends them (its macEditingCommands); copy, cut and paste are left out on purpose: they
 *  would reach the Mac's clipboard from a phone. */

import type { InputMethod } from "./driver.js";

export const MODIFIERS = ["Alt", "Control", "Meta", "Shift"] as const;
export type Modifier = (typeof MODIFIERS)[number];
const MODIFIER_BIT: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export const MOUSE_BUTTONS = ["left", "right", "middle"] as const;
export type MouseButton = (typeof MOUSE_BUTTONS)[number];
const BUTTON_BIT: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

type KeyDef = { readonly key: string; readonly code: string; readonly keyCode: number; readonly text?: string };
const NAMED: Record<string, KeyDef> = {
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
/** Named keys, and the letters for shortcuts (`Meta` + `a`); plain text goes as text. */
export const KEY_NAMES = [...Object.keys(NAMED), ...LETTERS] as [string, ...string[]];

/** The macOS editing commands for the keys above (Playwright's table, the same names without the trailing colon). */
const MAC_COMMANDS: Record<string, string | readonly string[]> = {
  "Backspace": "deleteBackward", "Escape": "cancelOperation", "Delete": "deleteForward",
  "ArrowUp": "moveUp", "ArrowDown": "moveDown", "ArrowLeft": "moveLeft", "ArrowRight": "moveRight",
  "Home": "scrollToBeginningOfDocument", "End": "scrollToEndOfDocument", "PageUp": "scrollPageUp", "PageDown": "scrollPageDown",
  "Shift+Backspace": "deleteBackward", "Shift+Escape": "cancelOperation", "Shift+Delete": "deleteForward",
  "Shift+ArrowUp": "moveUpAndModifySelection", "Shift+ArrowDown": "moveDownAndModifySelection",
  "Shift+ArrowLeft": "moveLeftAndModifySelection", "Shift+ArrowRight": "moveRightAndModifySelection",
  "Shift+Home": "moveToBeginningOfDocumentAndModifySelection", "Shift+End": "moveToEndOfDocumentAndModifySelection",
  "Shift+PageUp": "pageUpAndModifySelection", "Shift+PageDown": "pageDownAndModifySelection",
  "Control+KeyA": "moveToBeginningOfParagraph", "Control+KeyE": "moveToEndOfParagraph", "Control+KeyK": "deleteToEndOfParagraph",
  "Control+KeyH": "deleteBackward", "Control+KeyD": "deleteForward",
  "Control+ArrowLeft": "moveToLeftEndOfLine", "Control+ArrowRight": "moveToRightEndOfLine",
  "Alt+Backspace": "deleteWordBackward", "Alt+Delete": "deleteWordForward", "Alt+ArrowLeft": "moveWordLeft", "Alt+ArrowRight": "moveWordRight",
  "Alt+ArrowUp": ["moveBackward", "moveToBeginningOfParagraph"], "Alt+ArrowDown": ["moveForward", "moveToEndOfParagraph"],
  "Alt+PageUp": "pageUp", "Alt+PageDown": "pageDown",
  "Shift+Alt+Backspace": "deleteWordBackward", "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection", "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection",
  "Shift+Alt+ArrowUp": "moveParagraphBackwardAndModifySelection", "Shift+Alt+ArrowDown": "moveParagraphForwardAndModifySelection",
  "Meta+Backspace": "deleteToBeginningOfLine", "Meta+ArrowUp": "moveToBeginningOfDocument", "Meta+ArrowDown": "moveToEndOfDocument",
  "Meta+ArrowLeft": "moveToLeftEndOfLine", "Meta+ArrowRight": "moveToRightEndOfLine",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection", "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection",
  "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection", "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection",
  "Meta+KeyA": "selectAll", "Meta+KeyZ": "undo", "Shift+Meta+KeyZ": "redo",
};

export type MouseInput = {
  readonly type: "mouse"; readonly action: "move" | "down" | "up" | "click";
  readonly x: number; readonly y: number; readonly button: MouseButton; readonly clickCount: number;
  readonly modifiers: readonly Modifier[];
  /** The frame the point is on (its `seq`); default the latest. */
  readonly seq?: number | undefined;
};
export type WheelInput = {
  readonly type: "wheel"; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number;
  readonly modifiers: readonly Modifier[]; readonly seq?: number | undefined;
};
export type TextInput = { readonly type: "text"; readonly text: string };
export type KeyInput = { readonly type: "key"; readonly key: string; readonly modifiers: readonly Modifier[] };
export type InputEvent = MouseInput | WheelInput | TextInput | KeyInput;

/** How a frame's pixels sit on the page: `scale` frame pixels per CSS pixel; the viewport in CSS pixels; `view`: the
 *  tab's view pixels per CSS pixel when the host draws it at a scale (browser-v0 §5, 2026-10-03), where Chrome takes a
 *  point of input in the view's pixels and divides it by the scale itself (1 when absent). The view is the one drawn
 *  now, not the frame's own when it has been redrawn since (a page zoom redraws it at every step, browser-v0 §1
 *  页面缩放). */
export type Geometry = { readonly scale: number; readonly width: number; readonly height: number; readonly view?: number };
/** The buttons held down between calls (for drags). */
export type Pressed = { readonly buttons: number; readonly button: MouseButton | null };
export const NOTHING_PRESSED: Pressed = { buttons: 0, button: null };

export type CdpCall = { readonly method: InputMethod; readonly params: Record<string, unknown> };

const mask = (mods: readonly Modifier[]): number => mods.reduce((m, k) => m | MODIFIER_BIT[k], 0);
const round = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, max: number): number => Math.min(Math.max(n, 0), Math.max(max - 1, 0));

/** A point on the frame as CSS pixels on the page, kept inside the viewport. */
export function toPage(x: number, y: number, g: Geometry): { x: number; y: number } {
  const s = g.scale > 0 ? g.scale : 1;
  return { x: round(clamp(x / s, g.width)), y: round(clamp(y / s, g.height)) };
}

/** A point on the frame as CDP's input takes it: the page's CSS pixels, times the view's scale (measured with Chrome
 *  154: at scale 2 a click sent at (200, 120) lands on CSS (100, 60); a wheel's delta stays in CSS pixels). */
export function toInput(x: number, y: number, g: Geometry): { x: number; y: number } {
  const p = toPage(x, y, g);
  const v = g.view !== undefined && g.view > 0 ? g.view : 1;
  return v === 1 ? p : { x: round(p.x * v), y: round(p.y * v) };
}

function lowestButton(buttons: number): MouseButton | null {
  return MOUSE_BUTTONS.find((b) => buttons & BUTTON_BIT[b]) ?? null;
}

function mouseCalls(ev: MouseInput, g: Geometry, pressed: Pressed): { calls: CdpCall[]; pressed: Pressed } {
  const at = toInput(ev.x, ev.y, g);
  const modifiers = mask(ev.modifiers);
  const bit = BUTTON_BIT[ev.button];
  const moved = (p: Pressed): CdpCall => ({ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", ...at, modifiers, button: p.button ?? "none", buttons: p.buttons } });
  const down = (p: Pressed): CdpCall => ({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", ...at, modifiers, button: ev.button, buttons: p.buttons | bit, clickCount: ev.clickCount } });
  const up = (p: Pressed): CdpCall => ({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...at, modifiers, button: ev.button, buttons: p.buttons & ~bit, clickCount: ev.clickCount } });
  const afterDown: Pressed = { buttons: pressed.buttons | bit, button: ev.button };
  const afterUp = (p: Pressed): Pressed => ({ buttons: p.buttons & ~bit, button: lowestButton(p.buttons & ~bit) });
  switch (ev.action) {
    case "move": return { calls: [moved(pressed)], pressed };
    case "down": return { calls: [down(pressed)], pressed: afterDown };
    case "up": return { calls: [up(pressed)], pressed: afterUp(pressed) };
    case "click": return { calls: [moved(pressed), down(pressed), up(afterDown)], pressed: afterUp(afterDown) };
  }
}

function keyCalls(ev: KeyInput, mac: boolean): CdpCall[] {
  const letter = LETTERS.includes(ev.key);
  const shift = ev.modifiers.includes("Shift");
  const def: KeyDef = letter
    ? { key: shift ? ev.key.toUpperCase() : ev.key, code: `Key${ev.key.toUpperCase()}`, keyCode: ev.key.toUpperCase().charCodeAt(0), text: shift ? ev.key.toUpperCase() : ev.key }
    : NAMED[ev.key]!;
  // With Control, Alt or Meta held a key types nothing (a shortcut), as Playwright does.
  const text = ev.modifiers.some((m) => m !== "Shift") ? undefined : def.text;
  const shortcut = [...(["Shift", "Control", "Alt", "Meta"] as const).filter((m) => ev.modifiers.includes(m)), def.code].join("+");
  const found = mac ? MAC_COMMANDS[shortcut] : undefined;
  const commands = found === undefined ? [] : typeof found === "string" ? [found] : [...found];
  const base = { modifiers: mask(ev.modifiers), key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode };
  return [
    { method: "Input.dispatchKeyEvent", params: { ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text, unmodifiedText: text } : {}), commands } },
    { method: "Input.dispatchKeyEvent", params: { ...base, type: "keyUp" } },
  ];
}

/** The CDP calls for one input event, and the buttons held afterwards. */
export function inputCalls(ev: InputEvent, g: Geometry, pressed: Pressed, mac: boolean): { calls: CdpCall[]; pressed: Pressed } {
  switch (ev.type) {
    case "mouse": return mouseCalls(ev, g, pressed);
    case "wheel": {
      const at = toInput(ev.x, ev.y, g);
      const s = g.scale > 0 ? g.scale : 1;
      return { calls: [{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", ...at, modifiers: mask(ev.modifiers), deltaX: round(ev.deltaX / s), deltaY: round(ev.deltaY / s) } }], pressed };
    }
    case "text": return { calls: [{ method: "Input.insertText", params: { text: ev.text } }], pressed };
    case "key": return { calls: keyCalls(ev, mac), pressed };
  }
}
