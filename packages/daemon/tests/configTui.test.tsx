/** `agentswitch config` (docs/tui-v0.md) drawn to a string with a made-up service: moving through the pages, a new
 *  key-paying profile asked step by step (its key sealed before it leaves, its model chosen from what the address lists),
 *  a proxy pasted whole, the models saved and the service restarted, Bypass asked twice, node.json written, the language
 *  changed and kept, another node read only. No service, no gate, no model is reached. */

import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeSettings } from "../src/keeper/plan.js";
import type { AgentProfiles, Profile, ProfileAgent } from "../src/profiles/store.js";
import { ConfigApp, type PageId } from "../src/tui/app.js";
import type { ConfigClient, ConfigDeps, McpServerInput, ModelSettings } from "../src/tui/deps.js";
import type { McpServer, Skill } from "../src/extensions/types.js";
import type { Keypair } from "../src/keeper/gateKeys.js";

const KEY = { up: "\u001B[A", down: "\u001B[B", right: "\u001B[C", left: "\u001B[D", enter: "\r", esc: "\u001B", tab: "\t" };

const p = (id: string, name: string, more: Partial<Profile> = {}): Profile => ({ id, name, kind: "subscription", createdAt: 1, ...more });
function world() {
  let agents: Record<ProfileAgent, AgentProfiles> = {
    "claude-code": { current: "default", creatable: true, kinds: ["subscription", "api"], profiles: [
      p("default", "Default"),
      p("k1", "Relay", { kind: "api", api: { baseUrl: "https://relay.example/api", model: "claude-x" }, color: "mint" }),
    ] },
    codex: { current: "default", creatable: true, kinds: ["api"], profiles: [p("default", "Default")] },
    opencode: { current: "default", creatable: false, kinds: [], profiles: [p("default", "Default")] },
    pi: { current: "default", creatable: false, kinds: [], profiles: [p("default", "Default")] },
  };
  const models: ModelSettings = { router: { model: "opencode/r1", options: ["opencode/r1", "opencode/r2"] }, default: { harness: "claude-code", model: "opus" },
    harnesses: { "claude-code": { models: ["opus", "sonnet"], default_model: "opus" }, codex: { models: ["gpt-a", "gpt-b"], default_model: "gpt-b" } }, restartRequired: false };
  let policy = { mode: "scoped", human: ["delete", "git_push"] };
  let settings: NodeSettings = { name: "box", lan: "10.0.0.9" };
  let servers: McpServer[] = [{ name: "files", kind: "stdio", command: "npx", args: ["-y", "files-mcp"], env: {}, headers: {}, enabled: true, harnesses: ["claude-code", "codex", "opencode"], approval: "ask", note: "" }];
  let skills: Skill[] = [{ name: "notes", description: "Write notes", path: "/h/skills/notes", files: 0, enabled: true, harnesses: ["claude-code", "codex", "opencode"] }];
  let keypairs: Keypair[] = [{ name: "main", public: "PUBLICKEYMAIN0123456789", current: true }, { name: "old", public: "PUBLICKEYOLD0123456789", current: false, legacy: true }];
  const client = {
    profiles: vi.fn(async () => ({ agents })),
    createProfile: vi.fn(async (agent: ProfileAgent, name: string, kind: "subscription" | "api", api?: { key: string; baseUrl?: string; model?: string }) => {
      const made = p("n1", name, kind === "api" ? { kind, api: { ...(api?.baseUrl ? { baseUrl: api.baseUrl } : {}), ...(api?.model ? { model: api.model } : {}) } } : {});
      agents = { ...agents, [agent]: { ...agents[agent], profiles: [...agents[agent].profiles, made] } };
      return { profile: made };
    }),
    setProfileApi: vi.fn(async () => ({})),
    profileModels: vi.fn(async () => ({ models: ["claude-opus-5-5", "claude-sonnet-5-5"] as readonly string[] })),
    setProfileProxy: vi.fn(async (agent: ProfileAgent, id: string, proxy: { server: string | null; username?: string }) => {
      agents = { ...agents, [agent]: { ...agents[agent], profiles: agents[agent].profiles.map((x) => (x.id === id ? { ...x, ...(proxy.server ? { proxy: { server: proxy.server, ...(proxy.username ? { username: proxy.username } : {}), sealed: true }, exit: { ip: "203.0.113.9", place: "Tokyo", timezone: null, checkedAt: 1 } } : {}) } : x)) } };
      return { agents };
    }),
    checkProfile: vi.fn(async () => ({ agents })),
    setProfileSessionKey: vi.fn(async () => ({})),
    setProfileTelemetry: vi.fn(async () => ({})),
    setProfileColor: vi.fn(async () => ({})),
    removeProfile: vi.fn(async () => ({})),
    modelSettings: vi.fn(async () => models),
    saveModelSettings: vi.fn(async () => ({ restartRequired: true })),
    policy: vi.fn(async () => ({ policy, categories: [{ id: "delete", title: "删除" }, { id: "shell", title: "shell" }, { id: "new_kind", title: "Something new" }] })),
    setPolicy: vi.fn(async (next: { mode: string; human?: string[] }) => { policy = { mode: next.mode, human: next.human ?? [] }; return {}; }),
    workdir: vi.fn(async () => ({ path: "/home/u/AgentSwitch", default: "/home/u/AgentSwitch", problem: null })),
    setWorkdir: vi.fn(async () => ({})),
    mesh: vi.fn(async (): Promise<{ keyboard: boolean; files?: boolean; changes?: boolean; tools?: boolean }> => ({ keyboard: true })),
    setMesh: vi.fn(async (_next: { keyboard?: boolean; tools?: boolean }) => ({})),
    node: vi.fn(async () => ({ name: "studio", kind: "mac", version: "0.1.0", home: "/h", has: ["terminals", "browser"] })),
    context: vi.fn(async () => ({ path: "/h/CONTEXT.md", text: "# Me\nI work on AgentSwitch.\n", warnings: [] as string[] })),
    putContext: vi.fn(async () => ({ warnings: ["第 3 行像是一个密码，已删除。"], sealed: [{ label: "context/token" }] })),
    memory: vi.fn(async () => ({ path: "/h/MEMORY.md", text: "", warnings: [] as string[] })),
    putMemory: vi.fn(async () => ({ warnings: [] as string[] })),
    platformMemory: vi.fn(async () => ({ records: [{ id: "f1", origin: "https://shop.example", text: "Checkout needs the address form first.", kind: "operation", status: "verified" }] })),
    forgetPlatformMemory: vi.fn(async () => ({ ok: true })),
    mcp: vi.fn(async () => servers),
    putMcp: vi.fn(async (server: McpServerInput) => { servers = [...servers.filter((x) => x.name !== server.name), { args: [], env: {}, headers: {}, enabled: true, harnesses: ["claude-code", "codex", "opencode"], approval: "ask", note: "", ...server } as McpServer]; return {}; }),
    removeMcp: vi.fn(async () => ({ ok: true })),
    skills: vi.fn(async () => skills),
    skill: vi.fn(async (name: string) => ({ ...skills.find((x) => x.name === name)!, content: "---\nname: notes\n---\nWrite notes.\n" })),
    putSkill: vi.fn(async (name: string, body: { enabled?: boolean; harnesses?: string[] }) => {
      const was = skills.find((x) => x.name === name);
      skills = [...skills.filter((x) => x.name !== name), { name, description: was?.description ?? "", path: `/h/skills/${name}`, files: 0, enabled: body.enabled ?? was?.enabled ?? true, harnesses: (body.harnesses ?? was?.harnesses ?? ["claude-code", "codex", "opencode"]) as Skill["harnesses"] }];
      return {};
    }),
    removeSkill: vi.fn(async () => ({ ok: true })),
    discoverSkills: vi.fn(async () => [{ name: "pdf", description: "Read PDFs", path: "/home/u/.claude/skills/pdf", source: "~/.claude/skills", installed: false }, { name: "notes", description: "", path: "/x", source: "~/.claude/skills", installed: true }]),
    importSkill: vi.fn(async () => ({})),
  } satisfies ConfigClient;
  const seal = vi.fn(async (label: string, host: string, value: string) => `enc:v1:${label}-${host}-${value.length}`);
  const node = { read: vi.fn(() => settings), write: vi.fn((next: NodeSettings) => { settings = next; }), restart: vi.fn(() => true) };
  const edits: { text: string; name: string }[] = [];
  let editTo: (text: string) => string = (text) => text;
  const edit = vi.fn(async (text: string, name: string) => { edits.push({ text, name }); return editTo(text); });
  const keys = {
    list: vi.fn(async () => keypairs),
    create: vi.fn(async (name: string, use: boolean) => { keypairs = [...keypairs.map((k) => (use ? { ...k, current: false } : k)), { name, public: "NEWPUBLIC0123456789", current: use }]; return keypairs; }),
    use: vi.fn(async (name: string) => { keypairs = keypairs.map((k) => ({ ...k, current: k.name === name })); return keypairs; }),
    retire: vi.fn(async (name: string) => { keypairs = keypairs.filter((k) => k.name !== name); return keypairs; }),
  };
  const doctor = vi.fn(async () => ["", "// runtime", "✓ node             v24.6.0", "✗ secret-gate      not at /x", "! installed        running from a checkout"]);
  const deps: ConfigDeps = { client, remote: null, seal, node, edit, keys, doctor };
  return { client, seal, node, deps, settings: () => settings, edits, edit, setEdit: (f: (text: string) => string) => { editTo = f; }, keys, doctor };
}

const shown: { unmount(): void }[] = [];
afterEach(() => { for (const s of shown.splice(0)) s.unmount(); });

function open(deps: ConfigDeps, page?: PageId, locale: "en" | "zh-Hans" | "ja" = "en") {
  const r = render(<ConfigApp deps={deps} locale={locale} rows={40} {...(page ? { page } : {})} />);
  shown.push(r);
  const frame = () => r.lastFrame() ?? "";
  // Generous: CI's runners draw a good deal slower than a workstation.
  const until = async (seen: string | RegExp, ms = 6000) => {
    const end = Date.now() + ms;
    while (!(typeof seen === "string" ? frame().includes(seen) : seen.test(frame()))) {
      if (Date.now() > end) throw new Error(`never saw ${seen} in:\n${frame()}`);
      await new Promise((res) => setTimeout(res, 10));
    }
    // What is drawn takes its keys a moment later (Ink attaches a box's input in an effect after it draws): a key sent
    // at once can miss it (seen on a CI runner: the `y` for a question already shown was lost).
    await new Promise((res) => setTimeout(res, 100));
  };
  // One key at a time, each given its turn (the parser takes a lone Esc after a moment). Words typed get longer: the
  // box that takes them filters as it goes, and a key that follows too soon (Enter) can reach it before the words do
  // (seen on a CI runner: the model typed was not the one picked).
  const press = async (...keys: string[]) => {
    for (const k of keys) { r.stdin.write(k); await new Promise((res) => setTimeout(res, k === KEY.esc ? 100 : k.length > 1 && !k.startsWith("\u001b") ? 250 : 60)); }
  };
  return { frame, until, press };
}

// Each test types as a person would, a key at a time, and waits for each screen: on a busy CI runner that is longer
// than vitest's 5 s a test (seen 2026-10-15), so these get their own limit.
describe("agentswitch config", { timeout: 30_000 }, () => {
  it("lists every agent's profiles, moves into a page and back, and shows a profile's rows", async () => {
    const { deps } = world();
    const ui = open(deps);
    await ui.until("Relay");
    expect(ui.frame()).toContain("API Key · relay.example · claude-x");
    expect(ui.frame()).toContain("Default only, for now.");
    expect(ui.frame()).not.toContain("enc:v1");
    await ui.press(KEY.enter);                 // into the page: the first profile, Claude Code's Default
    await ui.press(KEY.down, KEY.enter);       // Relay
    await ui.until("Claude Code › Relay");
    expect(ui.frame()).toMatch(/Vendor\s+Custom/);
    expect(ui.frame()).toMatch(/Base URL\s+https:\/\/relay.example\/api/);
    expect(ui.frame()).toMatch(/Telemetry\s+On/);
    await ui.press(KEY.esc);
    await ui.until("New Profile…");
  });

  it("makes a key-paying profile step by step: the key sealed for the vendor's site, the model from the address's list", async () => {
    const { deps, client, seal } = world();
    const ui = open(deps);
    await ui.until("Relay");
    await ui.press(KEY.enter, KEY.down, KEY.down, KEY.enter);    // New Profile… under Claude Code
    await ui.until("1 to 40 characters");
    await ui.press("relay");                                     // a name another profile has, letter case aside
    await ui.press(KEY.enter);
    await ui.until("Another profile of this agent has that name.");
    await ui.press("\u0015", "Work", KEY.enter);
    await ui.until("Sign In With");
    await ui.press(KEY.down, KEY.enter);                         // API Key
    await ui.until("OpenRouter");
    await ui.press(KEY.down, KEY.enter);                         // OpenRouter
    await ui.until("API key for openrouter.ai");
    await ui.press("sk-or-made-up-123", KEY.enter);
    expect(ui.frame()).not.toContain("sk-or-made-up");
    await ui.until("claude-sonnet-5-5");
    expect(seal).toHaveBeenCalledWith("profile/api-key", "openrouter.ai", "sk-or-made-up-123");
    expect(client.profileModels).toHaveBeenCalledWith("claude-code", { key: "enc:v1:profile/api-key-openrouter.ai-17", baseUrl: "https://openrouter.ai/api" });
    await ui.press("sonnet", KEY.enter);                         // narrowed to the one, chosen
    await ui.until("Made Work.");
    expect(client.createProfile).toHaveBeenCalledWith("claude-code", "Work", "api", { key: "enc:v1:profile/api-key-openrouter.ai-17", baseUrl: "https://openrouter.ai/api", model: "claude-sonnet-5-5" });
    expect(ui.frame()).toContain("Claude Code › Work");
  });

  it("asks before keeping a model the address does not list, and sends it with force", async () => {
    const { deps, client } = world();
    const ui = open(deps);
    await ui.until("Relay");
    await ui.press(KEY.enter, KEY.down, KEY.enter);              // Relay
    await ui.until("Claude Code › Relay");
    await ui.press(KEY.down, KEY.down, KEY.down, KEY.enter);     // Model
    await ui.until("claude-opus-5-5");
    await ui.press("claude-opus-5.5");
    await ui.until("Use “claude-opus-5.5”");
    await ui.press(KEY.enter);
    await ui.until("does not list claude-opus-5.5");
    await ui.press("y");
    await ui.until("Saved.");
    expect(client.setProfileApi).toHaveBeenCalledWith("claude-code", "k1", { key: null, baseUrl: "https://relay.example/api", model: "claude-opus-5.5", force: true });
  });

  it("takes a proxy pasted whole: the password sealed for its host and port, the exit said", async () => {
    const { deps, client, seal } = world();
    const ui = open(deps);
    await ui.until("Relay");
    await ui.press(KEY.enter, KEY.enter);                        // Default
    await ui.until("Claude Code › Default");
    const rows = ui.frame().split("\n");
    const at = rows.findIndex((l) => l.includes("Proxy")) - rows.findIndex((l) => l.includes("Sign In With"));
    await ui.press(...Array<string>(at).fill(KEY.down), KEY.enter);
    await ui.until("host:port:user:pass");
    await ui.press("http://me:p%40ss@proxy.example:8080", KEY.enter);
    await ui.until("203.0.113.9 · Tokyo");
    expect(ui.frame()).toMatch(/Proxy\s+http:\/\/proxy.example:8080 · me/);
    expect(seal).toHaveBeenCalledWith("profile/proxy", "proxy.example:8080", "p@ss");
    expect(client.setProfileProxy).toHaveBeenCalledWith("claude-code", "default", { server: "http://proxy.example:8080", username: "me", password: "enc:v1:profile/proxy-proxy.example:8080-4" });
  });

  it("asks for a new key when the address moves to another site, sealed for the new one", async () => {
    const { deps, client, seal } = world();
    const ui = open(deps);
    await ui.until("Relay");
    await ui.press(KEY.enter, KEY.down, KEY.enter, KEY.down, KEY.down, KEY.enter);   // Relay › Base URL
    await ui.until("Where the key and the requests are sent");
    await ui.press("\u0015", "https://other.example/v1", KEY.enter);
    await ui.until("on another site now");
    await ui.press("sk-other-made-up", KEY.enter);
    await ui.until("Saved.");
    expect(seal).toHaveBeenCalledWith("profile/api-key", "other.example", "sk-other-made-up");
    expect(client.setProfileApi).toHaveBeenCalledWith("claude-code", "k1", { key: "enc:v1:profile/api-key-other.example-16", baseUrl: "https://other.example/v1", model: "claude-x" });
    // Esc on a question changes nothing.
    await ui.press(KEY.enter);
    await ui.until("Where the key and the requests are sent");
    await ui.press(KEY.esc);
    await ui.until("Claude Code › Relay");
    expect(client.setProfileApi).toHaveBeenCalledTimes(1);
  });

  it("seals a session key for claude.ai, and deletes a profile only once asked", async () => {
    const { deps, client, seal } = world();
    const ui = open(deps);
    await ui.until("Relay");
    await ui.press(KEY.enter, KEY.down, KEY.down, KEY.enter);    // New Profile…
    await ui.until("1 to 40 characters");
    await ui.press("Work", KEY.enter);
    await ui.until("Sign In With");
    await ui.press(KEY.enter);                                   // Account
    await ui.until("starts by signing in");
    await ui.press(KEY.down, KEY.enter);                         // Session Key
    await ui.until("claude.ai session key");
    await ui.press("not-a-key", KEY.enter);
    await ui.until("Not a claude.ai session key");
    await ui.press("\u0015", `sessionKey=sk-ant-sid01-${"a".repeat(24)}; Path=/`, KEY.enter);
    await ui.until("Saved.");
    expect(seal).toHaveBeenCalledWith("profile/session-key", "claude.ai", `sk-ant-sid01-${"a".repeat(24)}`);
    expect(client.setProfileSessionKey).toHaveBeenCalledWith("claude-code", "n1", "enc:v1:profile/session-key-claude.ai-37");
    const rows = ui.frame().split("\n");
    const at = rows.findIndex((l) => l.includes("Delete…")) - rows.findIndex((l) => l.includes("Session Key"));
    await ui.press(...Array<string>(at).fill(KEY.down), KEY.enter);
    await ui.until("Delete Work and its folder?");
    await ui.press(KEY.esc);
    expect(client.removeProfile).not.toHaveBeenCalled();
    await ui.press(KEY.enter);
    await ui.until("Delete Work and its folder?");
    await ui.press(KEY.right, KEY.enter);
    await ui.until("Deleted Work.");
    expect(client.removeProfile).toHaveBeenCalledWith("claude-code", "n1");
  });

  it("says a failed call on the status line and keeps the page", async () => {
    const { deps, client } = world();
    client.setProfileColor.mockRejectedValueOnce(new Error("有终端还在用这个配置：先结束它们。"));
    const ui = open(deps);
    await ui.until("Relay");
    await ui.press(KEY.enter, KEY.down, KEY.enter);
    await ui.until("Claude Code › Relay");
    const rows = ui.frame().split("\n");
    const at = rows.findIndex((l) => /Color\s+Mint/.test(l)) - rows.findIndex((l) => l.includes("Sign In With"));
    await ui.press(...Array<string>(at).fill(KEY.down), KEY.enter);
    await ui.until("Orchid");
    await ui.press(KEY.down, KEY.enter);
    await ui.until("有终端还在用这个配置");
    expect(ui.frame()).toContain("Claude Code › Relay");
  });

  it("saves the models and restarts the service; the executor's own model comes with it", async () => {
    const { deps, client, node } = world();
    const ui = open(deps, "models");
    await ui.until("Dispatch Model");
    await ui.press(KEY.enter, KEY.down, KEY.enter);              // Default Executor
    await ui.until("Codex");
    await ui.press(KEY.down, KEY.enter);
    await ui.until("gpt-b");
    await ui.press(KEY.down, KEY.down, KEY.enter);               // Save & Restart
    await ui.until("The service is restarting");
    expect(client.saveModelSettings).toHaveBeenCalledWith({ default: { harness: "codex", model: "gpt-b" } });
    expect(node.restart).toHaveBeenCalledTimes(1);
  });

  it("asks twice before Bypass; names the kinds in its own words, the service's for one it does not know", async () => {
    const { deps, client } = world();
    const ui = open(deps, "permissions");
    await ui.until("You Answer");
    expect(ui.frame()).toContain("Deleting files or data");
    expect(ui.frame()).toContain("Something new");
    await ui.press(KEY.enter, KEY.down, KEY.down, KEY.enter);    // the shell kind, kept from now on
    await vi.waitFor(() => expect(client.setPolicy).toHaveBeenCalledWith({ mode: "scoped", human: ["delete", "git_push", "shell"] }));
    await ui.press(KEY.up, KEY.up, KEY.enter);                   // Approvals
    await ui.until("Every approval is allowed at once");
    await ui.press(KEY.down, KEY.enter);                         // Bypass, after Scoped
    await ui.until("with nobody asked");
    await ui.press("n");
    expect(client.setPolicy).toHaveBeenCalledTimes(1);
  });

  it("writes node.json with what changed, keeps what it does not know, and restarts the service", async () => {
    const { deps, node, settings } = world();
    const ui = open(deps, "node");
    await ui.until("Paired Nodes May Type");
    await ui.press(KEY.enter, KEY.down, KEY.enter);              // Allow Pairing off
    await ui.until("Changed: Save & Restart applies it.");
    await ui.press(KEY.down, KEY.down, KEY.down, KEY.enter);     // Local port, after Hold Terminals and Language
    await ui.press("\u0015", "4712", KEY.enter);
    await ui.until("The ports must all differ.");
    await ui.press(KEY.enter, "\u0015", "5711", KEY.enter);
    await ui.until("Save & Restart");
    await ui.press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter);
    await ui.until("The service is restarting");
    expect(settings()).toEqual({ name: "box", lan: "10.0.0.9", remote: false, ports: { local: 5711, opencode: 4712, remote: 4713, gate: 8080 } });
    expect(node.restart).toHaveBeenCalledTimes(1);
  });

  it("lets paired nodes open yazi only after asking, and sends that switch alone (docs/yazi-v0.md §3)", async () => {
    const w = world();
    let mesh = { keyboard: false, tools: false };
    w.client.mesh.mockImplementation(async () => mesh);
    w.client.setMesh.mockImplementation(async (next: { keyboard?: boolean; tools?: boolean }) => { mesh = { keyboard: next.keyboard ?? mesh.keyboard, tools: next.tools ?? mesh.tools }; return {}; });
    const ui = open(w.deps, "node");
    await ui.until("Paired Nodes May Open yazi");
    await ui.press(KEY.enter);
    for (let i = 0; i < 20 && !/▸ Paired Nodes May Open yazi/.test(ui.frame()); i++) await ui.press(KEY.down);
    expect(ui.frame()).toMatch(/▸ Paired Nodes May Open yazi\s+Off/);
    await ui.press(KEY.enter);
    await ui.until("nobody is asked about");
    await ui.press("n");
    expect(w.client.setMesh).not.toHaveBeenCalled();
    await ui.press(KEY.enter);
    await ui.until("nobody is asked about");
    await ui.press("y");
    await vi.waitFor(() => expect(w.client.setMesh).toHaveBeenCalledWith({ tools: true }));
    await ui.until(/Paired Nodes May Open yazi\s+On/);
    // Off again without asking.
    await ui.press(KEY.enter);
    await vi.waitFor(() => expect(w.client.setMesh).toHaveBeenLastCalledWith({ tools: false }));
  });

  it("changes the language at once and keeps it in node.json", async () => {
    const { deps, settings } = world();
    const ui = open(deps);
    await ui.until("Relay");
    await ui.press("l");
    await ui.until("日本語");
    await ui.press(KEY.down, KEY.enter);                         // 简体中文
    await vi.waitFor(() => expect(settings().language).toBe("zh-Hans"));
  });

  it("shows another node read only: nothing to press, nothing written", async () => {
    const w = world();
    const ui = open({ ...w.deps, remote: "studio" }, "node");
    await ui.until("studio's settings, read only");
    await ui.until("terminals browser");
    await ui.press(KEY.enter, KEY.enter);
    expect(w.node.write).not.toHaveBeenCalled();
    const agents = open({ ...w.deps, remote: "studio" });
    await agents.until("Relay");
    expect(agents.frame()).not.toContain("New Profile…");
  });

  it("edits CONTEXT.md in the editor and says what the service sealed and dropped; unchanged is not sent", async () => {
    const w = world();
    const ui = open(w.deps, "context");
    await ui.until("2 lines");
    expect(ui.frame()).toContain("shop.example");
    w.setEdit((text) => text);
    await ui.press(KEY.enter, KEY.enter);                        // into the page, CONTEXT.md
    await ui.until("Unchanged.");
    expect(w.client.putContext).not.toHaveBeenCalled();
    w.setEdit((text) => `${text}token: abc\n`);
    await ui.press(KEY.enter);
    await ui.until("1 credential was sealed");
    expect(ui.frame()).toContain("第 3 行像是一个密码");
    expect(w.client.putContext).toHaveBeenCalledWith("# Me\nI work on AgentSwitch.\ntoken: abc\n");
    expect(w.edits[0]!.name).toBe("CONTEXT.md");
    await ui.press(KEY.down, KEY.down, KEY.enter);               // the learned fact
    await ui.until("Forget this?");
    await ui.press("y");
    await ui.until("Forgotten.");
    expect(w.client.forgetPlatformMemory).toHaveBeenCalledWith("f1");
  });

  it("says an editor that failed and sends nothing", async () => {
    const w = world();
    w.edit.mockRejectedValueOnce(new Error("vi exited 1"));
    const ui = open(w.deps, "context");
    await ui.until("2 lines");
    await ui.press(KEY.enter, KEY.down, KEY.enter);              // MEMORY.md
    await ui.until("The editor did not save: vi exited 1");
    expect(w.client.putMemory).not.toHaveBeenCalled();
  });

  it("adds an MCP server from JSON written in the editor, switches it, and refuses JSON that is not", async () => {
    const w = world();
    const ui = open(w.deps, "extensions");
    await ui.until("files");
    expect(ui.frame()).toContain("On · npx -y files-mcp");
    await ui.press(KEY.enter, KEY.down, KEY.enter);              // + Add MCP Server…
    await ui.until("Server Name");
    await ui.press("files", KEY.enter);
    await ui.until("That name is taken.");
    w.setEdit(() => "{ not json");
    await ui.press("\u0015", "search", KEY.enter);
    await ui.until("Not valid JSON, nothing saved");
    expect(w.client.putMcp).not.toHaveBeenCalled();
    w.setEdit(() => JSON.stringify({ kind: "http", url: "https://mcp.example/sse" }));
    await ui.press(KEY.enter);
    await ui.until("Server Name");
    await ui.press("search", KEY.enter);
    await ui.until("MCP Servers › search");
    expect(w.client.putMcp).toHaveBeenCalledWith({ kind: "http", url: "https://mcp.example/sse", name: "search" });
    await ui.press(KEY.enter);                                   // Enabled: off
    await vi.waitFor(() => expect(w.client.putMcp).toHaveBeenLastCalledWith(expect.objectContaining({ name: "search", enabled: false })));
  });

  it("imports a skill found in an agent's own folder, and turns a skill off for one agent", async () => {
    const w = world();
    const ui = open(w.deps, "extensions");
    await ui.until("Write notes");
    const rows = ui.frame().split("\n");
    const at = rows.findIndex((l) => l.includes("Import…")) - rows.findIndex((l) => /files\s+On/.test(l));
    await ui.press(KEY.enter, ...Array<string>(at).fill(KEY.down), KEY.enter);
    await ui.until("Import a Skill");
    expect(ui.frame()).not.toContain("/x");                      // one already installed is not offered
    await ui.press(KEY.enter);
    await ui.until("Imported pdf.");
    expect(w.client.importSkill).toHaveBeenCalledWith("/home/u/.claude/skills/pdf");
    await ui.press(KEY.up, KEY.up, KEY.enter);                   // notes
    await ui.until("Skills › notes");
    await ui.press(KEY.down, KEY.down, KEY.down, KEY.enter);     // Enabled, Edit SKILL.md…, Claude Code, Codex
    await vi.waitFor(() => expect(w.client.putSkill).toHaveBeenCalledWith("notes", { harnesses: ["claude-code", "opencode"] }));
  });

  it("makes a key pair current, and deletes one only when asked in so many words", async () => {
    const w = world();
    const ui = open(w.deps, "keys");
    await ui.until("Current · PUBLICKEYMAIN");
    await ui.press(KEY.enter, KEY.down, KEY.enter);              // old
    await ui.until("Keys › old");
    expect(ui.frame()).toContain("PUBLICKEYOLD0123456789");
    await ui.press(KEY.down, KEY.down, KEY.enter);               // Delete…, after Make Current
    await ui.until("can never be opened again");
    await ui.press("n");
    expect(w.keys.retire).not.toHaveBeenCalled();
    await ui.press(KEY.up, KEY.enter);                           // Make Current
    await ui.until("old is the current key pair.");
    expect(w.keys.use).toHaveBeenCalledWith("old");
  });

  it("shows doctor's lines marked, and asks again", async () => {
    const w = world();
    const ui = open(w.deps, "environment");
    await ui.until("✗ secret-gate");
    expect(ui.frame()).toContain("runtime");
    await ui.press(KEY.enter, KEY.enter);
    await vi.waitFor(() => expect(w.doctor).toHaveBeenCalledTimes(2));
  });

  it("speaks Japanese whole and Chinese in sentences", async () => {
    const ja = open(world().deps, "context", "ja");
    await ja.until("コンテキスト");
    expect(ja.frame()).toContain("ディスパッチ");
    const zh = open(world().deps, "keys", "zh-Hans");
    await zh.until("网关的密钥对");
    expect(zh.frame()).toContain("Keys");
  });
});
