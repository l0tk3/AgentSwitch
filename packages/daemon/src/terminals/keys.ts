/** The key bar of the phone and the web page (docs/terminal-v0.md §1): named keys, sent as the bytes a terminal
 *  keyboard would. Arrow keys follow the program's cursor-key mode; the wheel follows its mouse mode. */

export const KEY_NAMES = ["esc", "tab", "shift-tab", "enter", "shift-enter", "backspace", "up", "down", "left", "right", "pgup", "pgdn", "wheel-up", "wheel-down",
  "ctrl-c", "ctrl-d", "ctrl-l", "ctrl-r", "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
/** A named key, or a left click on a cell (`click:<col>:<row>`, from 0): the phone's tap on a program that tracks the
 *  mouse (terminal-v0 §4). */
export type KeyName = (typeof KEY_NAMES)[number] | `click:${number}:${number}`;
export const CLICK = /^click:(\d{1,3}):(\d{1,3})$/;

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
  /** The program turned on the kitty keyboard protocol (Codex and pi do): it reads modified keys as `CSI … u`. */
  readonly kittyKeys?: boolean;
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
  const click = CLICK.exec(name);
  if (click) return leftClick(Number(click[1]), Number(click[2]), ctx);
  // A new line in the agent's prompt, not a send (xterm gives Shift+Enter as a plain Enter): `CSI 13;2u` to a program
  // that reads the kitty protocol, else a line feed (Ctrl+J), which Claude Code, Codex and OpenCode take as a new line
  // too. Checked 2026-09-30 against all four; pi sends its prompt on a line feed, and has the protocol on.
  if (name === "shift-enter") return ctx.kittyKeys ? "\x1b[13;2u" : "\n";
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

/** A left click on a cell (from 0), as a terminal reports one: pressed and released (x10 reports presses only); nothing
 *  to a program that does not track the mouse. */
function leftClick(col: number, row: number, ctx: KeyContext): string {
  if (ctx.mouse === "none") return "";
  const x = Math.min(col, ctx.cols - 1) + 1, y = Math.min(row, ctx.rows - 1) + 1;
  if (ctx.sgrMouse) return `\x1b[<0;${x};${y}M` + (ctx.mouse === "x10" ? "" : `\x1b[<0;${x};${y}m`);
  const at = String.fromCharCode(32 + Math.min(x, 223), 32 + Math.min(y, 223));
  return `\x1b[M${String.fromCharCode(32)}${at}` + (ctx.mouse === "x10" ? "" : `\x1b[M${String.fromCharCode(32 + 3)}${at}`);
}

/** A reply typed into the agent: pasted as one block when the program asked for bracketed paste (so a line break does
 *  not send half of it), then Enter. */
/** A file's path as a terminal types one dragged onto it (iTerm, Terminal; the Mac app's TerminalDrop): the shell's
 *  special characters each behind a backslash, so the path is one word. Claude Code turns a picture's into [Image #n]. */
export function droppedPath(path: string): string {
  return path.replace(/[ \t\\'"`$&;|<>()[\]{}*?!#~^]/g, "\\$&");
}

export function replyBytes(text: string, bracketedPaste: boolean, submit: boolean): string {
  const body = text.replace(/\r\n?/g, "\n");
  const pasted = bracketedPaste ? `\x1b[200~${body.replace(/\x1b\[20[01]~/g, "")}\x1b[201~` : body.replace(/\n/g, "\r");
  return submit ? `${pasted}\r` : pasted;
}
