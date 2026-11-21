/** The lists an agent draws on its own screen, read for the screens that show the record (terminals/screenChoices.ts,
 *  docs/simple-view-v0.md §5.11, §5.17). The folder questions are the rows real agents drew, 120 columns wide
 *  (scripts/trust_prompt_probe.ts on Claude Code 2.1.299 and Codex 0.162, 2026-11-10). */

import { describe, expect, it } from "vitest";
import { choicesOnScreen } from "../src/terminals/screenChoices.js";

const CLAUDE_TRUST = [
  "",
  "─".repeat(120),
  " Accessing workspace:",
  "",
  " /private/var/folders/_c/cbb46m9x1p79z_9dr4f3dw3r0000gn/T/as-trust-383ru4/w-claude-code",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
];

const CODEX_TRUST = [
  "",
  "  Folder access",
  "  /private/var/folders/_c/cbb46m9x1p79z_9dr4f3dw3r0000gn/T/as-trust-383ru4/w-codex",
  "",
  "  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings",
  "  can run code automatically, even without a model request. Continue only if you trust these files. Your trust",
  "  decision will be saved.",
  "",
  "› 1. Trust and continue",
  "  2. Quit",
  "",
  "  enter continue · esc quit",
];

describe("a list on the agent's own screen", () => {
  it("reads Claude Code's question about a folder: rows without numbers, known by the line under them", () => {
    const got = choicesOnScreen(CLAUDE_TRUST, 120);
    expect(got).toEqual({
      title: "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
      options: [{ label: "No, exit" }, { label: "Yes, I trust this folder" }],
      selected: 0,
      text: [
        "Accessing workspace:",
        "/private/var/folders/_c/cbb46m9x1p79z_9dr4f3dw3r0000gn/T/as-trust-383ru4/w-claude-code",
        "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
        "Claude Code'll be able to read, edit, and execute files here.",
        "Security guide",
      ].join("\n"),
    });
    // The mark moved to the other row.
    const moved = CLAUDE_TRUST.map((l) => (l === " ❯ No, exit" ? "   No, exit" : l === "   Yes, I trust this folder" ? " ❯ Yes, I trust this folder" : l));
    expect(choicesOnScreen(moved, 120)).toMatchObject({ selected: 1, options: [{ label: "No, exit" }, { label: "Yes, I trust this folder" }] });
  });

  it("reads Codex's: what is asked is the whole paragraph, not its last line", () => {
    expect(choicesOnScreen(CODEX_TRUST, 120)).toEqual({
      title: "Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.",
      options: [{ label: "Trust and continue" }, { label: "Quit" }],
      selected: 0,
      text: "Folder access\n/private/var/folders/_c/cbb46m9x1p79z_9dr4f3dw3r0000gn/T/as-trust-383ru4/w-codex\nTrust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.",
    });
  });

  it("takes rows without numbers for a list only under the line that says how to take one", () => {
    // A prompt with something typed after it, and a line under it that is no such line.
    expect(choicesOnScreen(["─".repeat(40), "❯ No, exit", "  Yes, I trust this folder", "─".repeat(40), "  ? for shortcuts"])).toBeNull();
    expect(choicesOnScreen([" ❯ No, exit", "   Yes, I trust this folder"])).toBeNull();
    // One row is what you typed; two marks, none, or words that do not begin in one column are not a list.
    expect(choicesOnScreen([" ❯ No, exit", "", " Enter to confirm · Esc to cancel"])).toBeNull();
    expect(choicesOnScreen([" ❯ No, exit", " ❯ Yes", "", " Enter to confirm · Esc to cancel"])).toBeNull();
    expect(choicesOnScreen(["   No, exit", "   Yes", "", " Enter to confirm · Esc to cancel"])).toBeNull();
    expect(choicesOnScreen([" ❯ No, exit", "       Yes", "", " Enter to confirm · Esc to cancel"])).toBeNull();
    // Claude Code at rest, at work, and Codex at work: their last lines are not that line.
    expect(choicesOnScreen(["⏺ Done.", "", "─".repeat(40), "❯ ", "─".repeat(40), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"])).toBeNull();
    expect(choicesOnScreen(["⏺ Reading…", "", "✻ Pondering… (12s · ↓ 250 tokens · esc to interrupt)"])).toBeNull();
    expect(choicesOnScreen(["› hello", "• Working (3s • esc to interrupt)"])).toBeNull();
  });

  it("does not take a message you sent that begins 1. 2. 3. for a list (2026-11-21)", () => {
    // In Codex's record, at work and at rest; in its input while it is typed; in Claude Code's.
    expect(choicesOnScreen(["• Done.", "", "› 1. first thing", "  2. second thing", "  3. third", "", "• Working (3s • esc to interrupt)", "", "› Ask Codex to do anything", "", "  gpt-5 default · /tmp/project"])).toBeNull();
    expect(choicesOnScreen(["› 1. first thing", "  2. second thing", "", "• Here is what I found.", "", "› Ask Codex to do anything"])).toBeNull();
    expect(choicesOnScreen(["• Done.", "", "› 1. first thing", "  2. second thing", "", "  gpt-5 default · /tmp/project"])).toBeNull();
    expect(choicesOnScreen(["❯ 1. first thing", "  2. second thing", "", "⏺ Here is what I found.", "", "─".repeat(40), "❯ ", "─".repeat(40), "  ? for shortcuts"])).toBeNull();
    expect(choicesOnScreen(["─".repeat(40), "❯ 1. first thing", "  2. second thing", "─".repeat(40), "  ? for shortcuts"])).toBeNull();
    // A list under such a message is still read, and only its own rows.
    expect(choicesOnScreen(["› 1. first thing", "  2. second thing", "", "• Which one?", "", "  Pick", "", "› 1. a", "  2. b", "", "  Press enter to confirm or esc to go back"]))
      .toMatchObject({ selected: 0, options: [{ label: "a" }, { label: "b" }] });
  });

  it("reads Codex's question, also when it shows only the rows around the selection (its snapshots, 0.169)", () => {
    expect(choicesOnScreen(["• Explored", "  └ Read a.ts", "", "  Question 1/1 (1 unanswered)", "  What would you like to do next?", "", "  › 1. Option 1           First choice.", "    2. Option 2           Second choice.", "    3. None of the above  Optionally, add details in notes (tab)", "", "  tab to add notes | enter to submit answer | esc to interrupt"], 120))
      .toMatchObject({ selected: 0, options: [{ label: "Option 1", detail: "First choice." }, { label: "Option 2", detail: "Second choice." }, { label: "None of the above" }] });
    expect(choicesOnScreen(["  Question 1/1 (1 unanswered)", "  What would you like to do next?", "", "    2. Run tests      Pick a crate and run its tests.", "    3. Review a diff  Summarize or review current changes.", "  › 4. Refactor       Tighten structure and remove dead code.", "", "  option 4/5 | tab to add notes | enter to submit answer | esc to interrupt"], 120))
      .toMatchObject({ selected: 2, options: [{ label: "Run tests" }, { label: "Review a diff" }, { label: "Refactor" }] });
    // With its field for notes open under the rows.
    expect(choicesOnScreen(["  Question 1/1 (1 unanswered)", "  Choose an option.", "", "  › 1. Option 1  First choice.", "    2. Option 2  Second choice.", "", "  › Add notes", "", "", "  tab or esc to clear notes | enter to submit answer"], 120))
      .toMatchObject({ selected: 0, options: [{ label: "Option 1" }, { label: "Option 2" }] });
    // Rows that do not begin at 1 and have no hint under them are not a list.
    expect(choicesOnScreen(["  2. b", "› 3. c"])).toBeNull();
  });

  it("leaves the conversation above a list out of what is asked", () => {
    // Codex's `/model` under the end of an answer: the answer's lines are not the list's.
    const got = choicesOnScreen(["• The tests pass now; the fix is in", "  src/app.ts.", "", "  Select Model and Effort", "  Access legacy models by running codex -m <model_name>", "", "› 1. gpt-6-sol (current)   Frontier model", "  2. gpt-6-luna            Fast and light", "", "  Press enter to confirm or esc to go back"], 100);
    expect(got).toEqual({
      title: "Select Model and Effort", selected: 0,
      options: [{ label: "gpt-6-sol (current)", detail: "Frontier model" }, { label: "gpt-6-luna", detail: "Fast and light" }],
      text: "Select Model and Effort\nAccess legacy models by running codex -m <model_name>",
    });
    // A rule ends it too, and a box's edge.
    expect(choicesOnScreen(["something said before", "─".repeat(30), "  Pick one", "› 1. a", "  2. b"])).toEqual({ title: "Pick one", selected: 0, options: [{ label: "a" }, { label: "b" }] });
  });
});
