/** The web pages' look (ui/lib/look.js, docs/ui-v0.md §8): which look is in force, the classic look's words, tooltips,
 *  ages, labels and line icons. The pixel look's words are never changed. */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Look = "pixel" | "classic";
type LookLib = {
  lookOf: (v: unknown) => Look;
  accentOf: (v: unknown) => string | null;
  word: (text: string, look: Look) => string;
  age: (text: string, look: Look) => string;
  help: (text: string, look: Look) => string;
  label: (text: string, look: Look) => string;
  bracket: (text: string, look: Look) => string;
  ICONS: Record<string, string>;
  AGENT_ICON: Record<string, string>;
  icon: (name: string, size?: number) => string;
  mark: (state?: string, size?: number) => string;
  spinner: (size?: number) => string;
  dot: (state: string) => string;
};
const L = (await import(join(resolve(import.meta.dirname, "..", "ui"), "lib/look.js"))) as LookLib;

describe("the look in force", () => {
  it("is pixel unless the word kept is classic", () => {
    expect(L.lookOf("classic")).toBe("classic");
    for (const v of [undefined, null, "", "pixel", "Classic", 1, {}]) expect(L.lookOf(v)).toBe("pixel");
  });

  it("takes an accent only as a six-digit colour", () => {
    expect(L.accentOf("#0a84ff")).toBe("#0a84ff");
    expect(L.accentOf("#0A84FF")).toBe("#0A84FF");
    for (const v of [undefined, null, "", "blue", "#fff", "0a84ff", "#0a84ff;background:url(x)", 3]) expect(L.accentOf(v)).toBeNull();
  });
});

describe("the classic look's words", () => {
  it("has its own word for a few short words", () => {
    const pairs: [string, string][] = [["Busy", "Working"], ["Waiting", "Needs You"], ["Idle", "Ready"], ["Exited", "Ended"],
      ["[!] Approval", "Approval Needed"], ["[?] Question", "Question"], ["On Mac", "On This Mac"], ["Opening", "Opening…"]];
    for (const [pixel, classic] of pairs) {
      expect(L.word(pixel, "classic")).toBe(classic);
      expect(L.word(pixel, "pixel")).toBe(pixel);
    }
    for (const same of ["Allow", "Deny", "Take Over", "Resume", "Delete", "Close", "On iPhone", "On Web", "Run Command", "Empty"]) {
      expect(L.word(same, "classic")).toBe(same);
    }
  });

  it("counts what waits for you", () => {
    expect(L.word("1 Waiting", "classic")).toBe("1 Needs You");
    expect(L.word("3 Waiting", "classic")).toBe("3 Need You");
    expect(L.word("3 Waiting", "pixel")).toBe("3 Waiting");
    expect(L.word("Still Waiting", "classic")).toBe("Still Waiting");
  });

  it("says an age with ago, except now and a date", () => {
    expect(L.age("3h", "classic")).toBe("3h ago");
    expect(L.age("5m", "classic")).toBe("5m ago");
    expect(L.age("2d", "classic")).toBe("2d ago");
    expect(L.age("Now", "classic")).toBe("Now");
    expect(L.age("10/3", "classic")).toBe("10/3");
    expect(L.age("3h", "pixel")).toBe("3h");
  });

  it("puts a tooltip's key in brackets", () => {
    expect(L.help("List ⌘B", "classic")).toBe("Show or hide the list (⌘B)");
    expect(L.help("New Terminal ⌘T", "classic")).toBe("New Terminal (⌘T)");
    expect(L.help("Close ⌘W", "classic")).toBe("Close (⌘W)");
    expect(L.help("Back esc", "classic")).toBe("Back (esc)");
    expect(L.help("New Terminal Here", "classic")).toBe("New Terminal Here");
    expect(L.help("Drag · Double-Click Resets", "classic")).toBe("Drag · Double-Click Resets");
    expect(L.help("密码与令牌在发送前加密，agent 仅接收密文。", "classic")).toBe("密码与令牌在发送前加密，agent 仅接收密文。");
    expect(L.help("List ⌘B", "pixel")).toBe("List ⌘B");
  });

  it("drops the slashes of a group's label and the brackets of a button", () => {
    expect(L.label("// Model", "classic")).toBe("Model");
    expect(L.label("// Model", "pixel")).toBe("// Model");
    expect(L.label("// 2 folders · 1 title", "classic")).toBe("2 folders · 1 title");
    expect(L.label("//", "classic")).toBe("");
    expect(L.label("Model", "classic")).toBe("Model");
    expect(L.bracket("Take Over", "pixel")).toBe("[ Take Over ]");
    expect(L.bracket("Take Over", "classic")).toBe("Take Over");
    expect(L.bracket("+ New Terminal", "classic")).toBe("New Terminal");
    expect(L.bracket("+ New Terminal", "pixel")).toBe("[ + New Terminal ]");
  });
});

describe("the classic look's icons", () => {
  it("draws each named icon as a line drawing in the text's colour", () => {
    for (const name of ["sidebar", "plus", "x", "lock", "search", "folder", "chevdown", "chevright", "clock", "warn", "question", "terminal", "check"]) {
      const svg = L.icon(name);
      expect(svg, name).toContain("<svg");
      expect(svg, name).toContain('stroke="currentColor"');
      expect(svg, name).toContain(L.ICONS[name]);
    }
    expect(L.icon("plus", 12)).toContain('width="12"');
    expect(L.icon("nothing")).toBe("");
  });

  it("draws the app's mark as three windows, the state on the front one's title bar", () => {
    const idle = L.mark();
    expect(idle).toContain('viewBox="0 0 14 11"');
    expect(idle).toContain('width="18"');
    expect(idle).not.toMatch(/--cyan|--amber|--red/);
    // Two windows behind, each clipped clear of the one before it, the further the fainter.
    expect(idle.split("<clipPath").length - 1).toBe(3);
    expect(idle).toContain('opacity="0.28"');
    expect(idle).toContain('opacity="0.45"');
    // The front one's title bar with its three dots as holes, then a prompt and a cursor.
    expect(idle).toContain('fill-rule="evenodd"');
    expect(idle.split("a.36 .36 0 1 0 .72 0").length - 1).toBe(3);
    for (const [state, colour] of [["busy", "--cyan"], ["waiting", "--amber"], ["error", "--red"]] as const) {
      const svg = L.mark(state, 22);
      expect(svg.split(`fill="var(${colour})"`).length - 1, state).toBe(1);
      expect(svg, state).toContain('width="22"');
    }
    expect(L.mark("off")).toContain('opacity=".4"');
    // Each one's clip paths have names of their own: two marks on a page do not share them.
    const ids = (svg: string) => [...svg.matchAll(/clipPath id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set([...ids(L.mark()), ...ids(L.mark())]).size).toBe(6);
  });

  it("has a line mark for each agent, pi's for one it does not know", () => {
    for (const harness of ["claude-code", "codex", "opencode", "pi"]) expect(L.ICONS[L.AGENT_ICON[harness]!], harness).toBeTruthy();
    expect(new Set(Object.values(L.AGENT_ICON)).size).toBe(4);
  });

  it("draws status as dots and progress as the system's spinner", () => {
    expect(L.dot("idle")).toContain("dot idle");
    expect(L.dot("waiting")).toContain("dot waiting");
    expect(L.dot("exited")).toContain("dot exited");
    expect(L.spinner()).toContain("cspin");
    expect(L.spinner(10)).toContain('width="10"');
  });
});
