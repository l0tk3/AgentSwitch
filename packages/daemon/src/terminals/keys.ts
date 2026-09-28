/** The key bar of the phone and the web page (docs/terminal-v0.md §1): named keys, sent as the bytes a terminal
 *  keyboard would. Arrow keys follow the program's cursor-key mode. */

export const KEY_NAMES = ["esc", "tab", "shift-tab", "enter", "backspace", "up", "down", "left", "right", "ctrl-c", "ctrl-d", "ctrl-l", "ctrl-r", "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

const FIXED: Partial<Record<KeyName, string>> = {
  esc: "\x1b", tab: "\t", "shift-tab": "\x1b[Z", enter: "\r", backspace: "\x7f",
  "ctrl-c": "\x03", "ctrl-d": "\x04", "ctrl-l": "\x0c", "ctrl-r": "\x12",
};
const ARROWS: Partial<Record<KeyName, string>> = { up: "A", down: "B", right: "C", left: "D" };

export function keySequence(name: KeyName, applicationCursor: boolean): string {
  const arrow = ARROWS[name];
  if (arrow) return applicationCursor ? `\x1bO${arrow}` : `\x1b[${arrow}`;
  return FIXED[name] ?? name;
}

/** A reply typed into the agent: pasted as one block when the program asked for bracketed paste (so a line break does
 *  not send half of it), then Enter. */
export function replyBytes(text: string, bracketedPaste: boolean, submit: boolean): string {
  const body = text.replace(/\r\n?/g, "\n");
  const pasted = bracketedPaste ? `\x1b[200~${body.replace(/\x1b\[20[01]~/g, "")}\x1b[201~` : body.replace(/\n/g, "\r");
  return submit ? `${pasted}\r` : pasted;
}
