import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import type { ClaudeModelInfo, CodexModelInfo } from "../src/router/discovery.js";
import { claudeOffer, codexOffer, familyOf, ModelOffers } from "../src/router/modelOffers.js";
import type { Launcher } from "../src/terminals/host.js";
import { TARGETS_PATH } from "./helpers.js";

// What Claude Code 2.1.284's picker and Codex's model/list answered on 2026-09-29 (names and order as given).
const CLAUDE: ClaudeModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
  { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "Efficient for routine tasks" },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5", description: "Best for everyday, complex tasks" },
  { value: "claude-fable-5", resolvedModel: "claude-fable-5", displayName: "Fable 5", description: "Most capable for your hardest and longest-running tasks" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", description: "Best for everyday, complex tasks" },
  { value: "claude-opus-4-7", resolvedModel: "claude-opus-4-7", displayName: "Opus 4.7", description: "Best for everyday, complex tasks" },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Best for everyday, complex tasks" },
  { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "Efficient for routine tasks" },
];
const CODEX: CodexModelInfo[] = [
  { id: "gpt-6-astra", displayName: "GPT-6-Astra", description: "Frontier intelligence for the most demanding work." },
  { id: "gpt-6-sol", displayName: "GPT-6-Sol", description: "Workhorse model for coding and everyday work." },
  { id: "gpt-6-luna", displayName: "GPT-6-Luna", description: "Fast and affordable model for easier tasks." },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Older coding model for complex work." },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", description: "Older balanced model for straightforward work." },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", description: "Older fast and efficient model." },
  { id: "gpt-5.5", displayName: "GPT-5.5", description: "Legacy coding model.", upgrade: "gpt-5.6-sol" },
  { id: "codex-internal", displayName: "Internal", hidden: true },
];

const closers: (() => void)[] = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

describe("model offers: each agent's own list for the terminals' model menus", () => {
  it("reads a family and a version from a model's name", () => {
    expect(familyOf("Opus 5.5")).toEqual({ family: "opus", version: [5, 5] });
    expect(familyOf("GPT-6-Sol")).toEqual({ family: "gpt sol", version: [6] });
    expect(familyOf("GPT-5.6-Sol")).toEqual({ family: "gpt sol", version: [5, 6] });
    expect(familyOf("Default (recommended)")).toBeNull();
  });

  it("Claude Code: its order and names, aliases kept, the ones a newer model of the family supersedes folded as older", () => {
    const offer = claudeOffer(CLAUDE);
    expect(offer.defaultName).toBe("Opus 5.5");
    expect(offer.models.map((m) => m.id)).toEqual(CLAUDE.slice(1).map((m) => m.value));
    // the picker's first screen, exactly: the newest of each family
    expect(offer.models.filter((m) => !m.older).map((m) => m.name)).toEqual(["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5"]);
    expect(offer.models.filter((m) => m.older).map((m) => m.name)).toEqual(["Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6"]);
    // `opus` goes to the agent as it is: the next Opus is picked up without AgentSwitch knowing its id
    expect(offer.models[0]).toMatchObject({ id: "opus", name: "Opus 5.5" });
  });

  it("a new release takes the front and pushes its predecessor into older", () => {
    const next = [CLAUDE[0]!, { value: "opus", resolvedModel: "claude-opus-6", displayName: "Opus 6", description: "" }, { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "" }];
    expect(claudeOffer(next).models).toEqual([{ id: "opus", name: "Opus 6" }, { id: "claude-opus-5-5", name: "Opus 5.5", older: true }]);
  });

  it("Codex: hidden entries left out; superseded by family or by the upgrade it names", () => {
    const offer = codexOffer(CODEX);
    expect(offer.models.map((m) => m.id)).not.toContain("codex-internal");
    expect(offer.models.filter((m) => !m.older).map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra"]);
    expect(offer.models.filter((m) => m.older).map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"]);
  });

  it("asks again when an agent's binary changes; a failed answer keeps the last list; the router gets the ids", async () => {
    let claude = CLAUDE.slice(0, 3);
    let fail = false;
    let build = "a";
    const offers = new ModelOffers({
      claudeExecutable: "/bin/claude", log: () => undefined, signature: () => build,
      listClaude: async () => { if (fail) throw new Error("no"); return claude; }, listCodex: async () => CODEX,
    });
    const found = await offers.refresh();
    expect(found["claude-code"]).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
    expect(found.codex).toContain("gpt-6-sol");
    expect(offers.current()["claude-code"]?.models.map((m) => m.name)).toEqual(["Opus 5.5", "Fable 5.1"]);

    expect(await offers.checkBinaries()).toBe(false);
    claude = [...claude, { value: "claude-opus-6", resolvedModel: "claude-opus-6", displayName: "Opus 6", description: "" }];
    build = "b";   // the agent updated itself
    expect(await offers.checkBinaries()).toBe(true);
    expect(offers.current()["claude-code"]?.models.find((m) => m.name === "Opus 5.5")?.older).toBe(true);

    fail = true;
    await offers.refresh();
    expect(offers.current()["claude-code"]?.models.map((m) => m.name)).toContain("Opus 6");
  });

  it("GET /terminals serves the offers (and what default is), the catalog for an agent not asked", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-offers-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const modelOffers = new ModelOffers({ log: () => undefined, listClaude: async () => CLAUDE, listCodex: async () => [] });
    await modelOffers.refresh();
    const launcher: Launcher = () => { throw new Error("not started here"); };
    const daemon = buildDaemon(cfg, { terminalLauncher: launcher, modelOffers });
    closers.push(() => daemon.close());
    const body = (await (await daemon.api.request("/terminals")).json()) as { models: Record<string, { id: string; name: string; older?: boolean }[]>; defaults: Record<string, string> };
    expect(body.defaults).toEqual({ "claude-code": "Opus 5.5" });
    expect(body.models["claude-code"]?.slice(0, 2)).toEqual([
      { id: "opus", name: "Opus 5.5", description: "For complex work and everyday tasks" },
      { id: "claude-fable-5-1", name: "Fable 5.1", description: "For your toughest challenges" },
    ]);
    expect(body.models["claude-code"]?.some((m) => m.older)).toBe(true);
    // Codex answered nothing: its menu is the catalog's
    expect(body.models.codex?.length).toBeGreaterThan(0);
    expect(body.models.codex?.every((m) => m.older === undefined)).toBe(true);
  });
});
