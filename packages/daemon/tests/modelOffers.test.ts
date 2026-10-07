import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { codexDaybreakOf, type ClaudeModelInfo, type CodexModelInfo } from "../src/router/discovery.js";
import { claudeOffer, codexOffer, familyOf, ModelOffers } from "../src/router/modelOffers.js";
import { effortArgs, effortsFor, openCodeVariants, ordered, PI_THINKING, type EffortOffers } from "../src/harness/efforts.js";
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

describe("how hard each model can be asked to think (terminal-v0 §1 思考强度, 2026-10-07)", () => {
  // What Claude Code 2.1.292 and Codex 0.160.1 answered on 2026-10-07.
  const FIVE = ["low", "medium", "high", "xhigh", "max"];
  const claude: ClaudeModelInfo[] = [
    { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", efforts: FIVE },
    { value: "opus", displayName: "Opus 5.5", description: "", efforts: FIVE },
    { value: "haiku", displayName: "Haiku 4.5", description: "" },
    { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "", efforts: ["low", "medium", "high", "max"] },
  ];
  const codex: CodexModelInfo[] = [
    { id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low", isDefault: true },
    { id: "gpt-6-luna", displayName: "GPT-6-Luna", efforts: ["medium", "low", "max", "high", "xhigh"], defaultEffort: "medium" },
  ];

  it("Claude Code: each model's own levels; one it lists without any takes none; no model chosen is its default's", () => {
    const offer = claudeOffer(claude);
    expect(offer.efforts).toEqual(FIVE);
    expect(Object.fromEntries(offer.models.map((m) => [m.id, m.efforts]))).toEqual({ opus: FIVE, haiku: [], "claude-opus-4-6": ["low", "medium", "high", "max"] });
    // An older Claude Code says nothing of levels: nothing is claimed about any model.
    expect(claudeOffer(CLAUDE).models.every((m) => m.efforts === undefined)).toBe(true);
    expect(claudeOffer(CLAUDE).efforts).toBeUndefined();
  });

  it("Codex: each model's levels lowest first with one it adds of its own last, the level it uses unless told, and its default model's", () => {
    const offer = codexOffer(codex);
    expect(offer.models).toEqual([
      { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
      { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
    ]);
    expect(offer).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" });
  });

  it("the levels a new terminal may be started at, and each agent's arguments for one", () => {
    const offers: EffortOffers = {
      any: { "claude-code": FIVE, pi: PI_THINKING },
      models: { "claude-code": { opus: FIVE, haiku: [], "claude-opus-4-6": ["low", "medium", "high", "max"] }, opencode: { "deepseek/deepseek-flash": ["none", "low", "high", "max"] } },
    };
    expect(effortsFor(offers, "claude-code", undefined)).toEqual(FIVE);
    expect(effortsFor(offers, "claude-code", "claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(effortsFor(offers, "claude-code", "haiku")).toBeNull();
    // Not listed (typed by hand, or the list was not read): the agent's own words, which it fits to the model.
    expect(effortsFor(offers, "claude-code", "claude-something-new")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortsFor(offers, "codex", "gpt-9")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(effortsFor(offers, "pi", "anthropic/claude-sonnet-5-5")).toEqual(PI_THINKING);
    // OpenCode fails a turn whose variant the model lacks: only a listed one, and none without a model.
    expect(effortsFor(offers, "opencode", "deepseek/deepseek-flash")).toEqual(["none", "low", "high", "max"]);
    expect(effortsFor(offers, "opencode", "openai/gpt-9")).toBeNull();
    expect(effortsFor(offers, "opencode", undefined)).toBeNull();

    expect(effortArgs("claude-code", "xhigh", "opus")).toEqual({ args: ["--effort", "xhigh"], model: "opus" });
    expect(effortArgs("codex", "high", undefined)).toEqual({ args: ["-c", 'model_reasoning_effort="high"'], model: undefined });
    expect(effortArgs("opencode", "max", "deepseek/deepseek-flash")).toEqual({ args: [], model: "deepseek/deepseek-flash#max" });
    expect(effortArgs("opencode", "max", undefined)).toEqual({ args: [], model: undefined });
    expect(effortArgs("pi", "off", undefined)).toEqual({ args: ["--thinking", "off"], model: undefined });
    // Nothing that is not a level's name reaches a command line.
    expect(effortArgs("claude-code", "high --dangerously-skip-permissions", "opus").args).toEqual([]);
    expect(effortArgs("codex", 'x"; rm', undefined).args).toEqual([]);
    expect(effortArgs("claude-code", undefined, "opus").args).toEqual([]);
    expect(ordered(["max", "low", "ultra", "medium", "low", "Not A Level"])).toEqual(["low", "medium", "max", "ultra"]);
  });

  it("OpenCode's variants are read from its server's model list, per provider/model", async () => {
    const asked: string[] = [];
    const call = async (method: string, path: string) => {
      asked.push(`${method} ${path}`);
      return { data: [
        { providerID: "deepseek", id: "deepseek-flash", variants: [{ id: "max" }, { id: "none" }, { id: "low" }, { id: "high" }] },
        { providerID: "openai", id: "gpt-6-luna", variants: [] },
        { id: "no-provider" },
      ] };
    };
    expect(await openCodeVariants(call, "/Users/u/Library/Application Support/AgentSwitch/opencode-exec")).toEqual({
      "deepseek/deepseek-flash": ["none", "low", "high", "max"], "openai/gpt-6-luna": [],
    });
    expect(asked).toEqual(["GET /api/model?directory=%2FUsers%2Fu%2FLibrary%2FApplication%20Support%2FAgentSwitch%2Fopencode-exec"]);
    expect(await openCodeVariants(async () => ({}), "/x")).toEqual({});
  });

  it("GET /terminals says each model's levels; a new terminal is started at one the model takes, refused at any other", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-efforts-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-efforts-cwd-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const modelOffers = new ModelOffers({ log: () => undefined, listClaude: async () => claude, listCodex: async () => codex,
      openCodeVariants: async () => ({ "deepseek/deepseek-v4.1-flash": ["none", "low", "high", "max"] }) });
    await modelOffers.refresh();
    const started: { harness: string; model?: string; effort?: string }[] = [];
    const launcher: Launcher = (req) => {
      started.push({ harness: req.harness, ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}) });
      return { file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: process.env as Record<string, string>, hooks: false };
    };
    const daemon = buildDaemon(cfg, { terminalLauncher: launcher, modelOffers });
    closers.push(() => daemon.close());
    const post = (body: unknown) => daemon.api.request("/terminals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const listed = (await (await daemon.api.request("/terminals")).json()) as { models: Record<string, { id: string; efforts?: string[]; defaultEffort?: string }[]>; efforts: Record<string, string[]>; effortDefaults: Record<string, string> };
    expect(listed.efforts).toEqual({ "claude-code": FIVE, codex: ["low", "medium", "high", "xhigh", "max", "ultra"], pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] });
    expect(listed.effortDefaults).toEqual({ codex: "low" });
    expect(listed.models["claude-code"]!.find((m) => m.id === "haiku")!.efforts).toEqual([]);
    expect(listed.models.codex!.find((m) => m.id === "gpt-6-luna")).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" });
    // OpenCode's menu is the catalog's; a model whose variants its server listed carries them.
    const flash = listed.models.opencode!.find((m) => m.id === "deepseek/deepseek-v4.1-flash");
    if (flash) expect(flash.efforts).toEqual(["none", "low", "high", "max"]);

    const ok = await post({ harness: "claude-code", cwd, model: "claude-opus-4-6", effort: "max" });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { terminal: { effort: string | null } }).terminal.effort).toBe("max");
    expect((await post({ harness: "codex", cwd, effort: "ultra" })).status).toBe(201);
    expect((await post({ harness: "pi", cwd, effort: "off" })).status).toBe(201);
    expect((await post({ harness: "claude-code", cwd })).status).toBe(201);
    expect(started).toEqual([
      { harness: "claude-code", model: "claude-opus-4-6", effort: "max" }, { harness: "codex", effort: "ultra" }, { harness: "pi", effort: "off" }, { harness: "claude-code" },
    ]);
    // Opus 4.6 has no xhigh; Haiku takes no level; Luna has no ultra; OpenCode's variant needs its model; not a level.
    for (const body of [
      { harness: "claude-code", cwd, model: "claude-opus-4-6", effort: "xhigh" }, { harness: "claude-code", cwd, model: "haiku", effort: "low" },
      { harness: "codex", cwd, model: "gpt-6-luna", effort: "ultra" }, { harness: "opencode", cwd, effort: "max" }, { harness: "pi", cwd, effort: "ultra" },
      { harness: "claude-code", cwd, effort: "high --dangerously-skip-permissions" },
    ]) expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    expect(started).toHaveLength(4);
  });
});

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

  it("Codex's Daybreak: each model's place under it; the switch only where its program and the account have it; turned through the API (2026-10-07)", async () => {
    // What `model/list` says of a model (0.162, a real account): the programs it can be asked under.
    expect(codexDaybreakOf({ cyber: ["standard", "daybreakBlue"] })).toBe("also");
    expect(codexDaybreakOf({ cyber: ["daybreakBlue"] })).toBe("only");
    expect(codexDaybreakOf({ cyber: ["standard"] })).toBe("never");
    expect(codexDaybreakOf({ cyber: ["daybreak_red", "standard"] })).toBe("also");
    for (const none of [null, undefined, {}, { cyber: [] }, { cyber: "standard" }]) expect(codexDaybreakOf(none)).toBeUndefined();
    const codex: CodexModelInfo[] = [
      { id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", daybreak: "never", isDefault: true },
      { id: "gpt-6-sol", displayName: "GPT-6-Sol", daybreak: "also" },
      { id: "gpt-daybreak-blue-latest", displayName: "Daybreak Blue", daybreak: "only" },
      { id: "gpt-x", displayName: "GPT-X" },
    ];
    expect(codexOffer(codex).models.map((m) => [m.id, m.daybreak])).toEqual([["gpt-6.1-sol", "never"], ["gpt-6-sol", "also"], ["gpt-daybreak-blue-latest", "only"], ["gpt-x", undefined]]);
    let features = ["fast_mode"], byDefault = true, list = codex;
    const modelOffers = new ModelOffers({ log: () => undefined, listClaude: async () => CLAUDE, listCodex: async () => list, codexFeatures: async () => features, codexDaybreakDefault: async () => byDefault });
    await modelOffers.refresh();
    expect(modelOffers.current().codex?.daybreak).toBeUndefined();   // this Codex has no such feature: no switch
    features = ["fast_mode", "cli_daybreak"];
    list = codex.map(({ daybreak: _, ...m }) => ({ ...m, daybreak: "never" as const }));
    await modelOffers.refresh();
    expect(modelOffers.current().codex?.daybreak).toBeUndefined();   // the account has no Daybreak program: no switch
    list = codex;
    await modelOffers.refresh();
    expect(modelOffers.current().codex?.daybreak).toBe(true);   // how its new sessions start, as its own config says

    // Through the API: the listing, a terminal with the switch, the switch turned, and what follows.
    const home = mkdtempSync(join(tmpdir(), "agentswitch-daybreak-"));
    const flag = join(home, "daybreak-flag");
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const fake = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
    const launcher: Launcher = (req) => {
      const plan = { file: process.execPath, args: [fake], env: { ...(process.env as Record<string, string>), FAKE_DAYBREAK_FILE: flag }, hooks: true };
      // The companion says what the TUI saved on its server (here: the fake agent's file); Claude Code has none.
      return req.harness !== "codex" ? plan : { ...plan, companion: { start: async () => ({ args: plan.args, env: plan.env }), attach: () => undefined, stop: () => undefined, reportsStatus: false,
        daybreak: async () => existsSync(flag) && readFileSync(flag, "utf8") === "on" } };
    };
    const daemon = buildDaemon(cfg, { terminalLauncher: launcher, modelOffers });
    closers.push(() => daemon.close());
    const get = async (path: string) => (await (await daemon.api.request(path)).json()) as Record<string, any>;
    const post = (path: string, body: unknown) => daemon.api.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const listed = await get("/terminals");
    expect(listed.daybreak).toEqual({ codex: true });
    expect(listed.models.codex.map((m: { id: string; daybreak?: string }) => [m.id, m.daybreak])).toContainEqual(["gpt-daybreak-blue-latest", "only"]);
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-daybreak-cwd-"));
    const made = (await (await post("/terminals", { harness: "codex", cwd })).json()) as { terminal: { id: string; daybreak: boolean | null } };
    expect(made.terminal.daybreak).toBe(false);
    const turned = await post(`/terminals/${made.terminal.id}/daybreak`, { on: true });
    expect([turned.status, await turned.json()]).toEqual([200, { ok: true, on: true }]);
    expect((await get(`/terminals/${made.terminal.id}`)).terminal.daybreak).toBe(true);
    // Codex keeps the choice as how its new sessions start: the listing says so at once.
    expect((await get("/terminals")).daybreak).toEqual({ codex: true });
    expect((await (await post(`/terminals/${made.terminal.id}/daybreak`, { on: false })).json())).toEqual({ ok: true, on: false });
    expect((await get("/terminals")).daybreak).toEqual({ codex: false });
    expect((await post(`/terminals/${made.terminal.id}/daybreak`, { on: "yes" })).status).toBe(400);
    // Its command is offered where the terminal has the switch, and nowhere else.
    expect((await get(`/terminals/${made.terminal.id}/commands`)).commands.map((c: { name: string }) => c.name)).toContain("daybreak");
    const other = (await (await post("/terminals", { harness: "claude-code", cwd })).json()) as { terminal: { id: string; daybreak: boolean | null } };
    expect(other.terminal.daybreak).toBeNull();
    expect((await get(`/terminals/${other.terminal.id}/commands`)).commands.map((c: { name: string }) => c.name)).not.toContain("daybreak");
    const refused = await post(`/terminals/${other.terminal.id}/daybreak`, { on: true });
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([400, "this terminal has no Daybreak switch"]);
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
