/** A screen's input as CDP calls (docs/browser-v0.md §1 操作): frame points mapped to the page, buttons held for drags,
 *  wheel deltas, text, named keys with modifiers and the macOS editing commands (copy, cut and paste left out). */

import { describe, expect, it } from "vitest";
import { inputCalls, KEY_NAMES, NOTHING_PRESSED, toInput, toPage, type Geometry, type InputEvent } from "../src/browser/input.js";

const G: Geometry = { scale: 2, width: 1280, height: 800 };
const mouse = (action: "move" | "down" | "up" | "click", x: number, y: number, extra: Partial<InputEvent> = {}): InputEvent =>
  ({ type: "mouse", action, x, y, button: "left", clickCount: 1, modifiers: [], ...extra }) as InputEvent;

describe("frame points on the page", () => {
  it("divides by the frame's scale and stays inside the viewport", () => {
    expect(toPage(200, 100, G)).toEqual({ x: 100, y: 50 });
    expect(toPage(-5, 99_999, G)).toEqual({ x: 0, y: 799 });
    expect(toPage(3, 3, { scale: 0, width: 10, height: 10 })).toEqual({ x: 3, y: 3 });
    expect(toPage(1, 1, { scale: 3, width: 100, height: 100 })).toEqual({ x: 0.33, y: 0.33 });
  });

  it("goes on to the view's pixels when the view is drawn at a scale (Chrome divides by it); a wheel's delta stays CSS", () => {
    const view: Geometry = { scale: 2, width: 1280, height: 800, view: 2 };
    expect(toInput(200, 120, view)).toEqual({ x: 200, y: 120 });
    expect(toInput(200, 120, G)).toEqual({ x: 100, y: 60 });
    // A frame made smaller than the view (maxWidth): one pixel is two of the view.
    expect(toInput(100, 60, { scale: 1, width: 1280, height: 800, view: 2 })).toEqual({ x: 200, y: 120 });
    const click = inputCalls(mouse("click", 200, 120), view, NOTHING_PRESSED, true);
    expect(click.calls[1]!.params).toMatchObject({ type: "mousePressed", x: 200, y: 120 });
    const wheel = inputCalls({ type: "wheel", x: 200, y: 120, deltaX: 0, deltaY: 240, modifiers: [] }, view, NOTHING_PRESSED, true);
    expect(wheel.calls[0]!.params).toMatchObject({ x: 200, y: 120, deltaY: 120 });
  });

  // Page zoom (browser-v0 §1 页面缩放, 2026-10-03): a page its screen zoomed in is drawn at up to 8 (a 3x phone at 200%:
  // 201×345 at 6; a 2x Mac at 400%: 320×200 at 8); zoomed out, at the CSS size with the frame made smaller.
  it("at a zoomed page's scales a frame pixel is still the view's pixel under it, and a wheel's delta CSS pixels", () => {
    const phone: Geometry = { scale: 6, width: 201, height: 345, view: 6 };
    expect(toPage(603, 840, phone)).toEqual({ x: 100.5, y: 140 });
    expect(toInput(603, 840, phone)).toEqual({ x: 603, y: 840 });
    // CSS pixels are kept to a hundredth: at most a few hundredths of a view pixel off.
    const off = toInput(601, 1033, phone);
    expect(Math.abs(off.x - 601)).toBeLessThan(0.05);
    expect(Math.abs(off.y - 1033)).toBeLessThan(0.05);
    const drag = inputCalls({ type: "wheel", x: 603, y: 840, deltaX: 0, deltaY: 600, modifiers: [] }, phone, NOTHING_PRESSED, true);
    expect(drag.calls[0]!.params).toMatchObject({ x: 603, y: 840, deltaY: 100 });
    const mac: Geometry = { scale: 8, width: 320, height: 200, view: 8 };
    expect(toInput(804, 1120, mac)).toEqual({ x: 804, y: 1120 });
    expect(inputCalls(mouse("click", 2559, 1599), mac, NOTHING_PRESSED, true).calls[1]!.params).toMatchObject({ type: "mousePressed", x: 2552, y: 1592 });   // the last CSS pixel
    // 25% on the phone: the page 1608×2760 at the CSS size, its frame 1206×2070 (0.75 of it).
    const out: Geometry = { scale: 0.75, width: 1608, height: 2760, view: 1 };
    expect(toInput(75, 105, out)).toEqual({ x: 100, y: 140 });
    expect(inputCalls({ type: "wheel", x: 75, y: 105, deltaX: 0, deltaY: 300, modifiers: [] }, out, NOTHING_PRESSED, true).calls[0]!.params).toMatchObject({ x: 100, y: 140, deltaY: 400 });
    // A frame from before the view was redrawn (3 then, 6 now): its own scale to the page, the view's as it is to Chrome.
    expect(toInput(300, 420, { scale: 3, width: 201, height: 345, view: 6 })).toEqual({ x: 600, y: 840 });
  });
});

describe("mouse", () => {
  it("a click is move, press, release, and leaves nothing held", () => {
    const { calls, pressed } = inputCalls(mouse("click", 200, 100), G, NOTHING_PRESSED, true);
    expect(calls.map((c) => c.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(calls[0]!.params).toMatchObject({ x: 100, y: 50, button: "none", buttons: 0 });
    expect(calls[1]!.params).toMatchObject({ x: 100, y: 50, button: "left", buttons: 1, clickCount: 1 });
    expect(calls[2]!.params).toMatchObject({ button: "left", buttons: 0, clickCount: 1 });
    expect(pressed).toEqual(NOTHING_PRESSED);
  });

  it("a drag keeps the button held between down and up", () => {
    const down = inputCalls(mouse("down", 10, 10), G, NOTHING_PRESSED, true);
    expect(down.pressed).toEqual({ buttons: 1, button: "left" });
    const move = inputCalls(mouse("move", 50, 10), G, down.pressed, true);
    expect(move.calls[0]!.params).toMatchObject({ type: "mouseMoved", button: "left", buttons: 1, x: 25 });
    const up = inputCalls(mouse("up", 50, 10), G, move.pressed, true);
    expect(up.calls[0]!.params).toMatchObject({ type: "mouseReleased", buttons: 0 });
    expect(up.pressed).toEqual(NOTHING_PRESSED);
  });

  it("right button, double click and modifiers", () => {
    const right = inputCalls(mouse("click", 2, 2, { button: "right" } as Partial<InputEvent>), G, NOTHING_PRESSED, true);
    expect(right.calls[1]!.params).toMatchObject({ button: "right", buttons: 2 });
    const dbl = inputCalls(mouse("click", 2, 2, { clickCount: 2, modifiers: ["Shift", "Meta"] } as Partial<InputEvent>), G, NOTHING_PRESSED, true);
    expect(dbl.calls[1]!.params).toMatchObject({ clickCount: 2, modifiers: 12 });
    const held = inputCalls(mouse("up", 2, 2, { button: "right" } as Partial<InputEvent>), G, { buttons: 3, button: "left" }, true);
    expect(held.pressed).toEqual({ buttons: 1, button: "left" });
  });

  it("the wheel scrolls by CSS pixels", () => {
    const { calls } = inputCalls({ type: "wheel", x: 100, y: 100, deltaX: 0, deltaY: 240, modifiers: [] }, G, NOTHING_PRESSED, true);
    expect(calls).toEqual([{ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 50, y: 50, modifiers: 0, deltaX: 0, deltaY: 120 } }]);
  });
});

describe("keyboard", () => {
  const key = (k: string, modifiers: ("Alt" | "Control" | "Meta" | "Shift")[] = [], mac = true) => inputCalls({ type: "key", key: k, modifiers }, G, NOTHING_PRESSED, mac).calls;

  it("text goes in as it is", () => {
    expect(inputCalls({ type: "text", text: "你好 hi" }, G, NOTHING_PRESSED, true).calls).toEqual([{ method: "Input.insertText", params: { text: "你好 hi" } }]);
  });

  it("Enter types a return; Escape, Tab, Backspace and the arrows are raw keys", () => {
    const enter = key("Enter");
    expect(enter[0]!.params).toMatchObject({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", commands: [] });
    expect(enter[1]!.params).toMatchObject({ type: "keyUp", key: "Enter" });
    expect(key("Escape")[0]!.params).toMatchObject({ type: "rawKeyDown", windowsVirtualKeyCode: 27, commands: ["cancelOperation"] });
    expect(key("Tab")[0]!.params).toMatchObject({ type: "rawKeyDown", windowsVirtualKeyCode: 9, commands: [] });
    expect(key("Backspace")[0]!.params).toMatchObject({ type: "rawKeyDown", commands: ["deleteBackward"] });
    expect(key("ArrowLeft")[0]!.params).toMatchObject({ windowsVirtualKeyCode: 37, commands: ["moveLeft"] });
    expect(KEY_NAMES).toEqual(expect.arrayContaining(["Escape", "Tab", "Enter", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "a", "z"]));
  });

  it("modifiers: the mask, the macOS editing command, no text for a shortcut", () => {
    expect(key("ArrowLeft", ["Shift"])[0]!.params).toMatchObject({ modifiers: 8, commands: ["moveLeftAndModifySelection"] });
    expect(key("Backspace", ["Alt"])[0]!.params).toMatchObject({ modifiers: 1, commands: ["deleteWordBackward"] });
    expect(key("ArrowUp", ["Alt"])[0]!.params).toMatchObject({ commands: ["moveBackward", "moveToBeginningOfParagraph"] });
    expect(key("a", ["Meta"])[0]!.params).toMatchObject({ type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] });
    expect(key("a", ["Meta"])[0]!.params.text).toBeUndefined();
    expect(key("z", ["Shift", "Meta"])[0]!.params).toMatchObject({ key: "Z", commands: ["redo"] });
    expect(key("a", ["Alt", "Control", "Meta", "Shift"])[0]!.params.modifiers).toBe(15);
  });

  it("a letter alone types itself; copy, cut and paste carry no command; off the Mac there are none", () => {
    expect(key("a")[0]!.params).toMatchObject({ type: "keyDown", text: "a" });
    expect(key("a", ["Shift"])[0]!.params).toMatchObject({ type: "keyDown", key: "A", text: "A" });
    for (const k of ["c", "x", "v"]) expect(key(k, ["Meta"])[0]!.params.commands, k).toEqual([]);
    expect(key("Backspace", [], false)[0]!.params.commands).toEqual([]);
  });
});
