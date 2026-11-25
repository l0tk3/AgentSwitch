/** `agentswitch config` (docs/tui-v0.md) drawn to a string with a made-up service: moving through the pages, a new
 *  key-paying profile asked step by step (its key sealed before it leaves, its model chosen from what the address lists),
 *  a proxy pasted whole, node.json written, the language changed and kept, another node read only. No service, no gate,
 *  no model is reached. */

import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeSettings } from "../src/keeper/plan.js";
import type { AgentProfiles, Profile, ProfileAgent } from "../src/profiles/store.js";
import { ConfigApp, type PageId } from "../src/tui/app.js";
import type { ConfigClient, ConfigDeps } from "../src/tui/deps.js";

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
  let settings: NodeSettings = { name: "box", lan: "10.0.0.9" };
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
    workdir: vi.fn(async () => ({ path: "/home/u/AgentSwitch", default: "/home/u/AgentSwitch", problem: null })),
    setWorkdir: vi.fn(async () => ({})),
    mesh: vi.fn(async () => ({ keyboard: true })),
    setMesh: vi.fn(async () => ({})),
    node: vi.fn(async () => ({ name: "studio", kind: "mac", version: "0.1.0", home: "/h", has: ["terminals", "browser"] })),
  } satisfies ConfigClient;
  const seal = vi.fn(async (label: string, host: string, value: string) => `enc:v1:${label}-${host}-${value.length}`);
  const node = { read: vi.fn(() => settings), write: vi.fn((next: NodeSettings) => { settings = next; }), restart: vi.fn(() => true) };
  const doctor = vi.fn(async () => ["", "// runtime", "✓ node             v24.6.0", "✗ secret-gate      not at /x", "! installed        running from a checkout"]);
  const deps: ConfigDeps = { client, remote: null, seal, node, doctor };
  return { client, seal, node, deps, settings: () => settings, doctor };
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

  it("shows doctor's lines marked, and asks again", async () => {
    const w = world();
    const ui = open(w.deps, "environment");
    await ui.until("✗ secret-gate");
    expect(ui.frame()).toContain("runtime");
    await ui.press(KEY.enter, KEY.enter);
    await vi.waitFor(() => expect(w.doctor).toHaveBeenCalledTimes(2));
  });

  it("speaks Japanese whole and Chinese in sentences", async () => {
    const ja = open(world().deps, "environment", "ja");
    await ja.until("このノードにあるもの・足りないもの");
    expect(ja.frame()).toContain("エージェント");
    expect(ja.frame()).toContain("ノード");
    const zh = open(world().deps, "environment", "zh-Hans");
    await zh.until("此节点已有与缺少的项目");
    expect(zh.frame()).toContain("Environment");
  });
});
