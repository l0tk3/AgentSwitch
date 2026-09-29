/** The key bar of the phone and the web page (docs/terminal-v0.md §1): named keys, sent as the bytes a terminal
 *  keyboard would. Arrow keys follow the program's cursor-key mode; the wheel follows its mouse mode. */

export const KEY_NAMES = ["esc", "tab", "shift-tab", "enter", "backspace", "up", "down", "left", "right", "pgup", "pgdn", "wheel-up", "wheel-down",
  "ctrl-c", "ctrl-d", "ctrl-l", "ctrl-r", "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

/** What the program in the terminal asked for, as far as the keys care. */
export type KeyContext = {
  readonly applicationCursor: boolean;
  /** xterm's mouse tracking mode: none, or which events the program wants reported. */
  readonly mouse: "none" | "x10" | "vt200" | "drag" | "any";
  /** Mouse reports in SGR form (`?1006h`), else the default byte form. */
  readonly sgrMouse: boolean;
  /** On the alternate screen (a full-screen program): no scrollback of the terminal's own. */
  readonly alternate: boolean;
  readonly cols: number;
  readonly rows: number;
};

const FIXED: Partial<Record<KeyName, string>> = {
  esc: "\x1b", tab: "\t", "shift-tab": "\x1b[Z", enter: "\r", backspace: "\x7f", pgup: "\x1b[5~", pgdn: "\x1b[6~",
  "ctrl-c": "\x03", "ctrl-d": "\x04", "ctrl-l": "\x0c", "ctrl-r": "\x12",
};
const ARROWS: Partial<Record<KeyName, string>> = { up: "A", down: "B", right: "C", left: "D" };

export function keySequence(name: KeyName, ctx: KeyContext): string {
  const arrow = ARROWS[name];
  if (arrow) return ctx.applicationCursor ? `\x1bO${arrow}` : `\x1b[${arrow}`;
  if (name === "wheel-up" || name === "wheel-down") return wheel(name === "wheel-up", ctx);
  return FIXED[name] ?? name;
}

/** One notch of the wheel, as a terminal sends it (touch scrolling on the phone): a mouse report in the middle of the
 *  screen when the program tracks the mouse (Claude Code's full screen does, and scrolls its transcript itself); an
 *  arrow key on the alternate screen otherwise (xterm's alternate scroll); nothing on the normal screen, where the
 *  screen scrolls its own history. */
function wheel(up: boolean, ctx: KeyContext): string {
  if (ctx.mouse !== "none") {
    const button = up ? 64 : 65;
    const col = Math.floor(ctx.cols / 2) + 1, row = Math.floor(ctx.rows / 2) + 1;
    if (ctx.sgrMouse) return `\x1b[<${button};${col};${row}M`;
    return `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(col, 223), 32 + Math.min(row, 223))}`;
  }
  if (ctx.alternate) return keySequence(up ? "up" : "down", ctx);
  return "";
}

/** A reply typed into the agent: pasted as one block when the program asked for bracketed paste (so a line break does
 *  not send half of it), then Enter. */
export function replyBytes(text: string, bracketedPaste: boolean, submit: boolean): string {
  const body = text.replace(/\r\n?/g, "\n");
  const pasted = bracketedPaste ? `\x1b[200~${body.replace(/\x1b\[20[01]~/g, "")}\x1b[201~` : body.replace(/\n/g, "\r");
  return submit ? `${pasted}\r` : pasted;
}
