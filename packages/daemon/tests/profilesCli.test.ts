import { describe, expect, it, vi } from "vitest";
import { agentOf, listLines, profileOf, profilesCommand, sealHost, sealWithGate, type ProfilesClient, type ProfilesOptions, type Run } from "../src/keeper/profiles.js";
import type { AgentProfiles, Profile, ProfileAgent } from "../src/profiles/store.js";

const p = (id: string, name: string, more: Partial<Profile> = {}): Profile => ({ id, name, kind: "subscription", createdAt: 1, ...more });
const agents = (): Record<ProfileAgent, AgentProfiles> => ({
  "claude-code": { current: "default", creatable: true, kinds: ["subscription", "api"], profiles: [
    p("default", "Default"),
    p("k1", "Relay", { kind: "api", api: { baseUrl: "https://relay.example/api", model: "claude-x" }, color: "mint" }),
    p("w2", "Work", { account: "me@example.com", proxy: { server: "socks5://10.0.0.2:1080", sealed: false }, exit: { ip: "203.0.113.9", place: "Tokyo", timezone: null, checkedAt: 1 } }),
    p("t1", "Twin"), p("t2", "twin"),
  ] },
  codex: { current: "default", creatable: true, kinds: ["api"], profiles: [p("default", "Default"), p("c1", "Paid", { kind: "api" })] },
  opencode: { current: "default", creatable: false, kinds: [], profiles: [p("default", "Default")] },
  pi: { current: "default", creatable: false, kinds: [], profiles: [p("default", "Default")] },
});

function harness(over: Partial<ProfilesOptions> = {}, key = "sk-typed-0123456789") {
  const client = {
    profiles: vi.fn(async () => ({ agents: agents() })),
    createProfile: vi.fn(async (_a: ProfileAgent, name: string) => ({ profile: p("n1", name) })),
    setProfileApi: vi.fn(async () => ({})),
    setProfileColor: vi.fn(async () => ({})),
    removeProfile: vi.fn(async () => ({})),
  } satisfies ProfilesClient;
  const printed: string[] = [];
  const readKey = vi.fn(async (_prompt: string) => key);
  const seal = vi.fn(async (host: string, value: string) => `enc:v1:sealed-for-${host}-${value.length}`);
  const opts: ProfilesOptions = { api: false, key: false, json: false, remote: false, ...over };
  const run = (...args: (string | undefined)[]) => profilesCommand(args, opts, { client, readKey, seal, print: (l) => printed.push(l) });
  return { client, printed, readKey, seal, run };
}

describe("agentswitch profiles: naming an agent and a profile", () => {
  it("knows the agents and their short names", () => {
    expect(agentOf("claude")).toBe("claude-code");
    expect(agentOf("Codex")).toBe("codex");
    expect(() => agentOf("gemini")).toThrow(/no such agent/);
  });

  it("finds a profile by id, else by name; one name two share is asked again by id", () => {
    expect(profileOf(agents(), "claude-code", "k1").name).toBe("Relay");
    expect(profileOf(agents(), "claude-code", "relay").id).toBe("k1");
    expect(() => profileOf(agents(), "claude-code", "twin")).toThrow(/t1, t2/);
    expect(() => profileOf(agents(), "claude-code", "nope")).toThrow(/no claude-code profile nope/);
  });

  it("seals a key for the host its address is on: the vendor's, a relay's, with its port", () => {
    expect(sealHost("claude-code", undefined)).toBe("api.anthropic.com");
    expect(sealHost("codex", undefined)).toBe("api.openai.com");
    expect(sealHost("claude-code", "https://relay.example/api")).toBe("relay.example");
    expect(sealHost("claude-code", "http://10.0.0.5:8443/v1")).toBe("10.0.0.5:8443");
  });

  it("lists every agent's profiles: how each signs in, its colour, its proxy and exit; never a key", () => {
    const text = listLines(agents()).join("\n");
    expect(text).toContain("k1         Relay            API Key · relay.example · claude-x  [mint]");
    expect(text).toContain("signed in as me@example.com  proxy socks5://10.0.0.2:1080 → 203.0.113.9 (Tokyo)");
    expect(text).toContain("Paid             API Key · the vendor's own address");
    expect(text).toContain("opencode  (Default only)");
    expect(text).not.toMatch(/enc:v1|sk-/);
  });
});

describe("agentswitch profiles new", () => {
  it("makes one that signs in by an account without asking for a key", async () => {
    const h = harness();
    expect(await h.run("new", "claude", "Second")).toBe(0);
    expect(h.client.createProfile).toHaveBeenCalledWith("claude-code", "Second", "subscription");
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.printed[0]).toMatch(/starts by signing in/);
  });

  it("one that pays by a key: asked for, sealed for the address's host, only the ciphertext sent", async () => {
    const h = harness({ baseUrl: "https://relay.example/api/", model: "claude-x" });
    expect(await h.run("new", "claude-code", "Relay 2")).toBe(0);
    expect(h.readKey).toHaveBeenCalledWith("API key for relay.example: ");
    expect(h.seal).toHaveBeenCalledWith("relay.example", "sk-typed-0123456789");
    expect(h.client.createProfile).toHaveBeenCalledWith("claude-code", "Relay 2", "api", { key: "enc:v1:sealed-for-relay.example-19", baseUrl: "https://relay.example/api", model: "claude-x" });
    expect(JSON.stringify(h.client.createProfile.mock.calls)).not.toContain("sk-typed");
  });

  it("Codex pays by a key without being told; OpenCode makes none; no key typed makes nothing", async () => {
    const h = harness();
    await h.run("new", "codex", "Paid 2");
    expect(h.client.createProfile).toHaveBeenCalledWith("codex", "Paid 2", "api", { key: "enc:v1:sealed-for-api.openai.com-19" });
    await expect(h.run("new", "opencode", "x")).rejects.toThrow(/Default alone/);
    const empty = harness({ api: true }, "");
    await expect(empty.run("new", "claude", "x")).rejects.toThrow(/no key typed/);
    expect(empty.client.createProfile).not.toHaveBeenCalled();
    await expect(harness({ baseUrl: "ftp://x" }).run("new", "claude", "x")).rejects.toThrow(/not an address/);
  });
});

describe("agentswitch profiles api", () => {
  it("changes the model on the same address without a new key", async () => {
    const h = harness({ model: "claude-y" });
    await h.run("api", "claude", "relay");
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.client.setProfileApi).toHaveBeenCalledWith("claude-code", "k1", { key: null, baseUrl: "https://relay.example/api", model: "claude-y" });
    expect(h.printed[0]).toMatch(/close one and resume/);
  });

  it("asks for a new key when the address moves to another site, or when told to", async () => {
    const moved = harness({ baseUrl: "https://other.example/v1" });
    await moved.run("api", "claude", "k1");
    expect(moved.readKey.mock.calls[0]![0]).toMatch(/another site now; API key for other.example/);
    expect(moved.client.setProfileApi).toHaveBeenCalledWith("claude-code", "k1", { key: "enc:v1:sealed-for-other.example-19", baseUrl: "https://other.example/v1", model: "claude-x" });
    const same = harness({ key: true });
    await same.run("api", "claude", "k1");
    expect(same.seal).toHaveBeenCalledWith("relay.example", "sk-typed-0123456789");
  });

  it('"" puts the vendor\'s address and the agent\'s own model back', async () => {
    const h = harness({ baseUrl: "", model: "" });
    await h.run("api", "claude", "k1");
    expect(h.client.setProfileApi).toHaveBeenCalledWith("claude-code", "k1", { key: "enc:v1:sealed-for-api.anthropic.com-19", baseUrl: null, model: null });
  });

  it("refuses one that signs in by an account", async () => {
    await expect(harness().run("api", "claude", "work")).rejects.toThrow(/signs in by an account/);
  });
});

describe("agentswitch profiles: colour, remove, another node", () => {
  it("sets a colour by name; refuses one that is not a profile colour", async () => {
    const h = harness();
    await h.run("color", "claude", "Work", "olive");
    expect(h.client.setProfileColor).toHaveBeenCalledWith("claude-code", "w2", "olive");
    await expect(h.run("color", "claude", "Work", "red")).rejects.toThrow(/one of violet/);
  });

  it("removes one; Default stays", async () => {
    const h = harness();
    await h.run("rm", "claude", "w2");
    expect(h.client.removeProfile).toHaveBeenCalledWith("claude-code", "w2");
    await expect(h.run("rm", "claude", "default")).rejects.toThrow(/stays/);
  });

  it("with --on only lists: making, changing and removing are the node's own", async () => {
    const h = harness({ remote: true });
    expect(await h.run()).toBe(0);
    await expect(h.run("new", "claude", "x")).rejects.toThrow(/on the node itself/);
    expect(h.client.createProfile).not.toHaveBeenCalled();
  });

  it("prints its usage for what it does not know", async () => {
    const h = harness();
    expect(await h.run("frobnicate")).toBe(2);
    expect(h.printed[0]).toMatch(/profiles new <agent>/);
  });
});

describe("sealing with the gate's CLI", () => {
  it("gives the value on stdin, for one host, as the Mac does; the gate home in the environment", async () => {
    const exec = vi.fn<Run>(async () => ({ code: 0, stdout: '[{"label":"profile/api-key","token":"enc:v1:abcdefghijklmnopqrst"}]', stderr: "" }));
    expect(await sealWithGate({ bin: "/rt/secret-gate", home: "/h/.secret-gate" }, "relay.example", "sk-1", exec)).toBe("enc:v1:abcdefghijklmnopqrst");
    const [bin, args, opts] = exec.mock.calls[0]!;
    expect([bin, args]).toEqual(["/rt/secret-gate", ["enc", "--batch"]]);
    expect(JSON.parse(opts.input)).toEqual([{ label: "profile/api-key", hosts: ["relay.example"], uses: ["http", "fill"], kind: "secret", value: "sk-1" }]);
    expect(opts.env.SECRET_GATE_HOME).toBe("/h/.secret-gate");
  });

  it("says why when the gate refuses or fails", async () => {
    const refused: Run = async () => ({ code: 1, stdout: '[{"label":"profile/api-key","error":"bad host"}]', stderr: "" });
    await expect(sealWithGate({ bin: "g", home: "h" }, "x", "v", refused)).rejects.toThrow(/could not be sealed: bad host/);
    const broken: Run = async () => ({ code: 2, stdout: "", stderr: "no public key" });
    await expect(sealWithGate({ bin: "g", home: "h" }, "x", "v", broken)).rejects.toThrow(/secret-gate: no public key/);
  });
});
