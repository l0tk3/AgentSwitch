/** The slash commands the phone offers for a terminal (src/terminals/commands.ts): each agent's built-in list, its
 *  custom commands from a temp home and a temp project (never the real ones), names, priority, order, and what is
 *  skipped — broken files, missing folders, symlinks out of a command folder, more files than the budget. */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { slashCommands, type SlashCommand } from "../src/terminals/commands.js";

const temps: string[] = [];
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A temp home, a project that is a git repository (so walking up stops there) and a folder outside both. */
function setup(): { home: string; project: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "agentswitch-commands-"));
  temps.push(base);
  const home = join(base, "home"), project = join(base, "work", "repo"), outside = join(base, "outside");
  for (const d of [home, join(project, ".git"), outside]) mkdirSync(d, { recursive: true });
  return { home, project, outside };
}

function put(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const md = (description: string, body = "Do the thing."): string => `---\ndescription: ${description}\n---\n${body}\n`;
const find = (list: readonly SlashCommand[], name: string): SlashCommand | undefined => list.find((c) => c.name === name);
const names = (list: readonly SlashCommand[], source?: SlashCommand["source"]): string[] => list.filter((c) => !source || c.source === source).map((c) => c.name);

describe("built-in commands", () => {
  it("lists each agent's own, alphabetical, one line each, and nothing for an unknown agent", () => {
    const { home, project } = setup();
    const expected: Record<string, string[]> = {
      "claude-code": ["code-review", "compact", "context", "init", "model", "resume", "usage"],
      codex: ["compact", "diff", "init", "model", "permissions", "review", "status"],
      opencode: ["compact", "init", "models", "review", "sessions", "undo"],
      pi: ["compact", "model", "quit", "settings", "tree"],
    };
    for (const [harness, want] of Object.entries(expected)) {
      const list = slashCommands(harness, project, home);
      expect(list.length).toBeGreaterThan(15);
      expect(list.every((c) => c.source === "builtin")).toBe(true);
      for (const name of want) expect(find(list, name)?.description, `${harness} /${name}`).toBeTruthy();
      expect(names(list)).toEqual([...names(list)].sort());
      expect(new Set(names(list)).size).toBe(list.length);
      for (const c of list) {
        expect(c.name).not.toMatch(/^\/|\s/);
        expect([...c.description].length).toBeLessThanOrEqual(100);
        expect(c.description).not.toContain("\n");
      }
    }
    // Claude Code's /doctor text is longer than a line: cut, marked.
    expect(find(slashCommands("claude-code", project, home), "doctor")?.description).toMatch(/…$/);
    for (const harness of ["", "claude", "__proto__", "constructor", "toString"]) expect(slashCommands(harness, project, home)).toEqual([]);
  });
});

describe("Claude Code", () => {
  it("finds the user's and the project's commands, namespaced by folder, project before user before built-in", () => {
    const { home, project } = setup();
    put(join(home, ".claude/commands/deploy.md"), md("Deploy the app"));
    put(join(home, ".claude/commands/shared.md"), md("the user's"));
    put(join(home, ".claude/commands/help.md"), md("my own help"));
    put(join(project, ".claude/commands/shared.md"), md("the project's"));
    put(join(project, ".claude/commands/compact.md"), md("compact our way"));
    put(join(project, ".claude/commands/frontend/lint.md"), "\n# Lint the frontend\n\nRun eslint.\n");
    put(join(project, ".claude/commands/tools/gen/SKILL.md"), md("A skill-shaped command"));
    put(join(dirname(project), ".claude/commands/above.md"), md("above the repository"));

    const list = slashCommands("claude-code", join(project, "src", "deep"), home);
    expect(find(list, "frontend:lint")).toEqual({ name: "frontend:lint", description: "Lint the frontend", source: "project" });
    expect(find(list, "tools:gen")).toEqual({ name: "tools:gen", description: "A skill-shaped command", source: "project" });
    expect(find(list, "shared")).toEqual({ name: "shared", description: "the project's", source: "project" });
    expect(find(list, "compact")).toEqual({ name: "compact", description: "compact our way", source: "project" });
    expect(find(list, "help")).toEqual({ name: "help", description: "my own help", source: "user" });
    expect(find(list, "deploy")?.source).toBe("user");
    expect(find(list, "above")).toBeUndefined();
    expect(list.filter((c) => c.name === "shared" || c.name === "compact")).toHaveLength(2);

    expect(names(list, "project")).toEqual(["compact", "frontend:lint", "shared", "tools:gen"]);
    expect(names(list, "user")).toEqual(["deploy", "help"]);
    expect(list.slice(0, 6).map((c) => c.source)).toEqual(["project", "project", "project", "project", "user", "user"]);
    expect(list.slice(6).every((c) => c.source === "builtin")).toBe(true);
  });

  it("takes skills by folder name, hides the ones not for the user, and skips the synced folder", () => {
    const { home, project } = setup();
    put(join(home, ".claude/skills/pdf/SKILL.md"), "---\nname: PDF Tools\ndescription: Work with PDFs\n---\nBody\n");
    put(join(home, ".claude/skills/background-only/SKILL.md"), "---\ndescription: model only\nuser-invocable: false\n---\n");
    put(join(home, ".claude/skills/synced/SKILL.md"), md("reserved"));
    put(join(home, ".claude/skills/notes/README.md"), md("not a skill"));
    put(join(project, ".claude/skills/review-pr/SKILL.md"), "Review a pull request\n");

    const list = slashCommands("claude-code", project, home);
    expect(find(list, "pdf")).toEqual({ name: "pdf", description: "Work with PDFs", source: "user" });
    expect(find(list, "review-pr")).toEqual({ name: "review-pr", description: "Review a pull request", source: "project" });
    for (const name of ["background-only", "synced", "notes", "PDF Tools"]) expect(find(list, name)).toBeUndefined();
  });

  it("adds enabled plugins' commands and skills as <plugin>:<name>", () => {
    const { home, project } = setup();
    const hud = join(home, ".claude/plugins/cache/market/hud/1.0.0");
    put(join(hud, ".claude-plugin/plugin.json"), JSON.stringify({ name: "hud", commands: ["./extra/one.md", "../../escape.md"] }));
    put(join(hud, "commands/setup.md"), md("Set up the HUD"));
    put(join(hud, "extra/one.md"), md("One more"));
    put(join(hud, "skills/tune/SKILL.md"), md("Tune it"));
    put(join(home, ".claude/plugins/cache/escape.md"), md("outside the plugin"));
    const off = join(home, ".claude/plugins/cache/market/off/1.0.0");
    put(join(off, "commands/nope.md"), md("disabled"));
    const elsewhere = join(home, ".claude/plugins/cache/market/other/1.0.0");
    put(join(elsewhere, "commands/theirs.md"), md("another project's"));
    put(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
      "hud@market": [{ scope: "user", installPath: hud }],
      "off@market": [{ scope: "user", installPath: off }],
      "other@market": [{ scope: "project", projectPath: "/somewhere/else", installPath: elsewhere }],
    } }));
    put(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "hud@market": true, "off@market": false, "other@market": true } }));

    const list = slashCommands("claude-code", project, home);
    expect(find(list, "hud:setup")).toEqual({ name: "hud:setup", description: "Set up the HUD", source: "user" });
    expect(find(list, "hud:one")?.description).toBe("One more");
    expect(find(list, "hud:tune")?.description).toBe("Tune it");
    for (const name of ["hud:escape", "off:nope", "other:theirs"]) expect(find(list, name)).toBeUndefined();
  });
});

describe("Codex", () => {
  it("lists ~/.codex/prompts as /prompts:<name>, direct files only", () => {
    const { home, project } = setup();
    put(join(home, ".codex/prompts/fix.md"), md("Fix the failing test"));
    put(join(home, ".codex/prompts/nested/deep.md"), md("not read"));
    const list = slashCommands("codex", project, home);
    expect(find(list, "prompts:fix")).toEqual({ name: "prompts:fix", description: "Fix the failing test", source: "user" });
    expect(list.filter((c) => c.source !== "builtin")).toHaveLength(1);
  });
});

describe("OpenCode", () => {
  it("reads command folders by path and the command object of opencode.json / opencode.jsonc", () => {
    const { home, project } = setup();
    put(join(home, ".config/opencode/command/global.md"), md("From the global folder"));
    put(join(home, ".config/opencode/opencode.json"), JSON.stringify({ command: { ship: { template: "ship it", description: "Ship" } } }));
    put(join(project, ".opencode/commands/frontend/lint.md"), "---\nagent: build\n---\nLint it.\n");
    put(join(project, "opencode.jsonc"), [
      "{",
      "  // the project's commands",
      '  "command": {',
      '    "test": { "template": "Run the tests // all of them", "description": "Run tests", },',
      '    /* no template: not a command */ "bad": { "description": "nothing to run" },',
      "  },",
      "}",
    ].join("\n"));

    const list = slashCommands("opencode", project, home);
    expect(find(list, "frontend/lint")).toEqual({ name: "frontend/lint", description: "Lint it.", source: "project" });
    expect(find(list, "test")).toEqual({ name: "test", description: "Run tests", source: "project" });
    expect(find(list, "global")).toEqual({ name: "global", description: "From the global folder", source: "user" });
    expect(find(list, "ship")).toEqual({ name: "ship", description: "Ship", source: "user" });
    expect(find(list, "bad")).toBeUndefined();
  });
});

describe("pi", () => {
  it("lists prompt templates by file and skills as /skill:<name>, unless skill commands are off", () => {
    const { home, project } = setup();
    put(join(home, ".pi/agent/prompts/review.md"), md("Review staged changes"));
    put(join(home, ".pi/agent/prompts/sub/ignored.md"), md("not a direct child"));
    put(join(project, ".pi/prompts/plan.md"), "Plan the work\n");
    put(join(home, ".pi/agent/skills/group/pdf/SKILL.md"), "---\nname: pdf-tools\ndescription: Extract PDFs\n---\n");
    put(join(home, ".agents/skills/nodesc/SKILL.md"), "---\nname: nodesc\n---\nA skill with no description is not loaded.\n");
    put(join(project, ".agents/skills/local/SKILL.md"), md("A project skill"));

    const list = slashCommands("pi", project, home);
    expect(find(list, "review")).toEqual({ name: "review", description: "Review staged changes", source: "user" });
    expect(find(list, "plan")).toEqual({ name: "plan", description: "Plan the work", source: "project" });
    expect(find(list, "skill:pdf-tools")).toEqual({ name: "skill:pdf-tools", description: "Extract PDFs", source: "user" });
    expect(find(list, "skill:local")).toEqual({ name: "skill:local", description: "A project skill", source: "project" });
    for (const name of ["skill:nodesc", "ignored", "sub:ignored"]) expect(find(list, name)).toBeUndefined();

    put(join(project, ".pi/settings.json"), JSON.stringify({ enableSkillCommands: false }));
    const off = slashCommands("pi", project, home);
    expect(names(off).filter((n) => n.startsWith("skill:"))).toEqual([]);
    expect(find(off, "review")).toBeDefined();
  });
});

describe("what is skipped", () => {
  it("never throws on missing folders, relative paths or broken files, and skips what cannot be read", () => {
    const { home, project } = setup();
    const builtinOnly = slashCommands("claude-code", project, home);
    expect(slashCommands("claude-code", join(project, "missing"), join(home, "missing"))).toEqual(builtinOnly);
    for (const harness of ["claude-code", "codex", "opencode", "pi"]) {
      expect(slashCommands(harness, "relative/folder", "").every((c) => c.source === "builtin")).toBe(true);
    }

    const dir = join(home, ".claude/commands");
    put(join(dir, "fine.md"), md("Still here"));
    put(join(dir, "badyaml.md"), "---\ndescription: [unclosed\n---\nbody\n");
    put(join(dir, "huge.md"), md("too big", "x".repeat(70_000)));
    put(join(dir, "binary.md"), Buffer.from([0, 255, 1, 2, 10, 27, 0]));
    put(join(dir, "has space.md"), md("cannot be typed"));
    put(join(dir, "locked.md"), md("unreadable"));
    chmodSync(join(dir, "locked.md"), 0o000);
    mkdirSync(join(dir, "folder.md"));
    put(join(dir, "multi.md"), "---\ndescription: |\n  first line\n  second line\n---\n");
    put(join(dir, "long.md"), md("word ".repeat(60)));
    put(join(home, ".claude/settings.json"), "{ not json");
    put(join(home, ".claude/plugins/installed_plugins.json"), "[]");
    put(join(home, ".claude/skills/weird/SKILL.md"), "---\n- just\n- a list\n---\n# Weird but fine\n");
    put(join(home, ".pi/agent/settings.json"), "null");
    put(join(project, "opencode.jsonc"), "{ \"command\": ");

    for (const harness of ["claude-code", "codex", "opencode", "pi"]) expect(() => slashCommands(harness, project, home)).not.toThrow();
    const list = slashCommands("claude-code", project, home);
    expect(find(list, "fine")?.description).toBe("Still here");
    expect(find(list, "multi")?.description).toBe("first line second line");
    expect(find(list, "weird")?.description).toBe("Weird but fine");
    const long = find(list, "long")?.description ?? "";
    expect([...long].length).toBeLessThanOrEqual(100);
    expect(long).toMatch(/…$/);
    expect(find(list, "binary")?.description).not.toMatch(/[\u0000-\u001f]/);
    for (const name of ["badyaml", "huge", "has space", "locked", "folder"]) expect(find(list, name)).toBeUndefined();
    expect(slashCommands("opencode", project, home).every((c) => c.source === "builtin")).toBe(true);
    chmodSync(join(dir, "locked.md"), 0o600);
  });

  it("does not follow a symlink out of a command folder", () => {
    const { home, project, outside } = setup();
    put(join(outside, "secret.md"), md("outside file"));
    put(join(outside, "dir/leak.md"), md("outside folder"));
    put(join(outside, "dir/SKILL.md"), md("outside skill"));
    const dir = join(home, ".claude/commands");
    put(join(dir, "real.md"), md("inside"));
    symlinkSync(join(outside, "secret.md"), join(dir, "evil.md"));
    symlinkSync(join(outside, "dir"), join(dir, "linked"));
    symlinkSync(join(dir, "real.md"), join(dir, "alias.md"));
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    symlinkSync(join(outside, "dir"), join(home, ".claude/skills/escaped"));
    put(join(home, ".pi/agent/prompts/ok.md"), md("pi inside"));
    symlinkSync(join(outside, "secret.md"), join(home, ".pi/agent/prompts/evil.md"));

    const claude = slashCommands("claude-code", project, home);
    expect(find(claude, "real")?.description).toBe("inside");
    expect(find(claude, "alias")?.description).toBe("inside");
    for (const name of ["evil", "linked:leak", "escaped"]) expect(find(claude, name)).toBeUndefined();
    const pi = slashCommands("pi", project, home);
    expect(find(pi, "ok")).toBeDefined();
    expect(find(pi, "evil")).toBeUndefined();
  });

  it("reads at most a few hundred files", () => {
    const { home, project } = setup();
    for (let i = 0; i < 400; i++) put(join(home, `.claude/commands/c${String(i).padStart(3, "0")}.md`), md(`command ${i}`));
    const user = slashCommands("claude-code", project, home).filter((c) => c.source === "user");
    expect(user.length).toBeGreaterThan(100);
    expect(user.length).toBeLessThanOrEqual(300);
  });
});
