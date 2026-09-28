/** How terminal screens look (docs/terminal-v0.md §1): the user's iTerm2 default profile when there is one — its font,
 *  spacing and colors (the dark-mode set when the profile keeps two, since the terminal window is dark) — else a quiet
 *  default. The screens (web page, later SwiftTerm) apply it as they are; nothing here is secret. */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TerminalTheme = {
  readonly background: string; readonly foreground: string; readonly cursor: string; readonly cursorAccent: string;
  readonly selectionBackground: string; readonly selectionForeground?: string;
  readonly black: string; readonly red: string; readonly green: string; readonly yellow: string;
  readonly blue: string; readonly magenta: string; readonly cyan: string; readonly white: string;
  readonly brightBlack: string; readonly brightRed: string; readonly brightGreen: string; readonly brightYellow: string;
  readonly brightBlue: string; readonly brightMagenta: string; readonly brightCyan: string; readonly brightWhite: string;
};

export type TerminalStyle = {
  readonly source: "iterm" | "default";
  /** CSS font-family list: the profile's font first, then fallbacks (CJK falls back to PingFang, as in iTerm). */
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly theme: TerminalTheme;
};

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

const FALLBACK_FONTS = ['"SF Mono"', "Menlo", "Monaco", '"PingFang SC"', "monospace"];

export const DEFAULT_STYLE: TerminalStyle = {
  source: "default",
  fontFamily: FALLBACK_FONTS.join(", "),
  fontSize: 13,
  lineHeight: 1.2,
  letterSpacing: 0,
  theme: {
    background: "#0c0c0e", foreground: "#e6e6e6", cursor: "#e6e6e6", cursorAccent: "#0c0c0e", selectionBackground: "rgba(109,139,255,0.35)",
    black: "#1c1c1f", red: "#ff6b62", green: "#5fd38d", yellow: "#f5c451", blue: "#6d8bff", magenta: "#c792ea", cyan: "#58c7d8", white: "#d7d7db",
    brightBlack: "#6b6b73", brightRed: "#ff8a82", brightGreen: "#7ee2a5", brightYellow: "#ffd772", brightBlue: "#93a9ff", brightMagenta: "#dab0f5", brightCyan: "#7fd9e6", brightWhite: "#ffffff",
  },
};

type Profile = Record<string, unknown>;
const STYLE_WORDS = /^(Regular|Bold|Italic|Oblique|Medium|Light|Thin|Book|Roman|Retina|SemiBold|Semibold|ExtraLight|Heavy|Black)$/;
/** PostScript family stems whose CSS family is spelled differently. */
const FAMILY_NAMES: Record<string, string> = { SFMono: "SF Mono", SFProMono: "SF Mono", AppleBraille: "Apple Braille" };

/** "MesloLGS-NF-Regular 15" → ["MesloLGS NF", 15]; the PostScript name stays in the list too (WebKit matches either). */
export function parseItermFont(spec: string): { families: string[]; size: number } | null {
  const m = /^(\S+)\s+(\d+(?:\.\d+)?)$/.exec(spec.trim());
  if (!m) return null;
  const postscript = m[1]!;
  const parts = postscript.split("-");
  if (parts.length > 1 && STYLE_WORDS.test(parts[parts.length - 1]!)) parts.pop();
  const stem = parts.join("-");
  const family = FAMILY_NAMES[stem] ?? parts.join(" ");
  return { families: [...new Set([family, postscript])], size: Number(m[2]) };
}

function hex(c: unknown, alpha?: number): string | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const ch = (k: string) => Math.max(0, Math.min(255, Math.round(Number(o[k] ?? NaN) * 255)));
  const [r, g, b] = [ch("Red Component"), ch("Green Component"), ch("Blue Component")];
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return alpha === undefined ? `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}` : `rgba(${r},${g},${b},${alpha})`;
}

/** The style of one iTerm2 profile (as `plutil -extract "New Bookmarks" json` gives it). */
export function styleFromItermProfile(p: Profile): TerminalStyle {
  const dark = p["Use Separate Colors for Light and Dark Mode"] === true;
  const color = (key: string, alpha?: number) => hex(p[dark ? `${key} (Dark)` : key], alpha) ?? hex(p[key], alpha);
  const font = typeof p["Normal Font"] === "string" ? parseItermFont(p["Normal Font"]) : null;
  const base = DEFAULT_STYLE.theme;
  const ansi = Object.fromEntries(ANSI.map((name, i) => [name, color(`Ansi ${i} Color`) ?? base[name]])) as Record<(typeof ANSI)[number], string>;
  const background = color("Background Color") ?? base.background;
  const selectedText = color("Selected Text Color");
  const theme: TerminalTheme = {
    ...ansi,
    background,
    foreground: color("Foreground Color") ?? base.foreground,
    cursor: color("Cursor Color") ?? base.cursor,
    cursorAccent: color("Cursor Text Color") ?? background,
    // iTerm draws the selection opaque with its own text color; over xterm's text a translucent one reads better.
    selectionBackground: color("Selection Color", 0.4) ?? base.selectionBackground,
    ...(selectedText ? { selectionForeground: selectedText } : {}),
  };
  const vspace = Number(p["Vertical Spacing"] ?? 1);
  const hspace = Number(p["Horizontal Spacing"] ?? 1);
  const size = font?.size ?? DEFAULT_STYLE.fontSize;
  return {
    source: "iterm",
    fontFamily: [...(font?.families ?? []).map((f) => `"${f}"`), ...FALLBACK_FONTS].join(", "),
    fontSize: size,
    lineHeight: Number.isFinite(vspace) && vspace > 0 ? Math.round(vspace * 100) / 100 : 1,
    letterSpacing: Number.isFinite(hspace) ? Math.round((hspace - 1) * size * 10) / 10 : 0,
    theme,
  };
}

const ITERM_PREFS = join(homedir(), "Library", "Preferences", "com.googlecode.iterm2.plist");

function plutil(key: string, format: "json" | "raw", file: string): string | null {
  try {
    return execFileSync("/usr/bin/plutil", ["-extract", key, format, "-o", "-", file], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** The iTerm2 default profile's style, or the default style when there is no iTerm2 or it cannot be read. */
export function readTerminalStyle(file: string = ITERM_PREFS): TerminalStyle {
  if (!existsSync(file)) return DEFAULT_STYLE;
  try {
    const profiles = JSON.parse(plutil("New Bookmarks", "json", file) ?? "[]") as Profile[];
    const guid = plutil("Default Bookmark Guid", "raw", file)?.trim();
    const chosen = profiles.find((p) => p.Guid === guid) ?? profiles[0];
    return chosen ? styleFromItermProfile(chosen) : DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}
