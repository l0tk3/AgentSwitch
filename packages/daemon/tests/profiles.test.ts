/** Profiles (docs/profiles-v0.md §2, §3): a Claude Code profile is a folder of its own with the user's set-up and the
 *  sessions linked in and nothing of the account carried over; the current one is what new terminals start under; the
 *  Mac's own folder is never written to. */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountProfiles } from "../src/api/profiles.js";
import type { ApiDeps } from "../src/api/shared.js";
import { markRemote } from "../src/core/caller.js";
import { DEFAULT_PROFILE, ProfileError, ProfileStore } from "../src/profiles/store.js";
import { agentLauncher } from "../src/terminals/launch.js";

function world() {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-profiles-"));
  const userHome = join(root, "user"), home = join(root, "as");
  mkdirSync(join(userHome, ".claude", "skills"), { recursive: true });
  writeFileSync(join(userHome, ".claude", "CLAUDE.md"), "be brief\n");
  writeFileSync(join(userHome, ".claude", "settings.json"), '{"permissions":{"allow":["Bash(ls:*)"]}}');
  writeFileSync(join(userHome, ".claude.json"), JSON.stringify({
    userID: "u".repeat(64), machineID: "m".repeat(64), oauthAccount: { emailAddress: "me@example.com", accountUuid: "a1" }, theme: "dark", hasCompletedOnboarding: true,
    mcpServers: { docs: { command: "x" } }, tipsHistory: { a: 1 },
    projects: { "/w/app": { hasTrustDialogAccepted: true, allowedTools: ["Bash"], lastSessionId: "s1", lastCost: 3 } },
  }));
  return { root, userHome, home, store: new ProfileStore({ home, userHome, now: () => 1_000 }) };
}

describe("the profile store", () => {
  it("has Default for every agent, the Mac's own; a new Claude Code profile is a folder with links and no account", () => {
    const { userHome, home, store } = world();
    expect(store.all()["claude-code"]).toEqual({ current: DEFAULT_PROFILE, creatable: true, profiles: [{ id: "default", name: "Default", kind: "subscription", createdAt: 0, account: "me@example.com" }] });
    expect(store.all().codex).toMatchObject({ current: "default", creatable: false, profiles: [{ id: "default" }] });
    expect(store.homeOf("claude-code", "default")).toBeNull();

    const work = store.create("claude-code", "  Work ", "subscription");
    expect(work).toMatchObject({ name: "Work", kind: "subscription", createdAt: 1_000 });
    const dir = store.homeOf("claude-code", work.id)!;
    expect(dir).toBe(join(home, "profiles", "claude-code", work.id, "home"));
    // The user's own set-up and the sessions are the Mac's, linked; what the Mac does not have is not invented, but
    // the session folders are made there so both write to one place.
    for (const name of ["CLAUDE.md", "skills", "settings.json", "projects", "file-history", "todos", "plans"]) {
      expect(lstatSync(join(dir, name)).isSymbolicLink(), name).toBe(true);
      expect(readlinkSync(join(dir, name))).toBe(join(userHome, ".claude", name));
    }
    expect(existsSync(join(dir, "commands"))).toBe(false);
    expect(existsSync(join(userHome, ".claude", "projects"))).toBe(true);
    // Nothing that names the account or the device; what is the user's is carried once.
    const seeded = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    expect(seeded).toEqual({ theme: "dark", hasCompletedOnboarding: true, mcpServers: { docs: { command: "x" } }, projects: { "/w/app": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] } } });
    expect(JSON.stringify(seeded)).not.toMatch(/userID|machineID|oauthAccount|me@example|lastSessionId/);
    // The Mac's own file is as it was.
    expect(JSON.parse(readFileSync(join(userHome, ".claude.json"), "utf8")).oauthAccount.emailAddress).toBe("me@example.com");
    // Listed, not signed in yet; once Claude Code has written who is, it says.
    expect(store.all()["claude-code"].profiles.map((p) => [p.name, p.account ?? null])).toEqual([["Default", "me@example.com"], ["Work", null]]);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ ...seeded, oauthAccount: { emailAddress: "work@example.com" } }));
    expect(store.all()["claude-code"].profiles[1]!.account).toBe("work@example.com");
  });

  it("keeps a current profile per agent; a removed one's folder goes and Default takes over", () => {
    const { store } = world();
    const work = store.create("claude-code", "Work", "subscription");
    store.setCurrent("claude-code", work.id);
    expect(store.current("claude-code")).toBe(work.id);
    expect(store.current("codex")).toBe("default");
    expect(store.nameOf("claude-code", work.id)).toBe("Work");
    const dir = store.homeOf("claude-code", work.id)!;
    expect(() => store.setCurrent("claude-code", "nope12")).toThrow(ProfileError);
    expect(() => store.create("claude-code", "work", "api")).toThrow(/already/);
    expect(() => store.create("claude-code", "  ", "api")).toThrow(/name/);
    expect(() => store.create("codex", "Team", "subscription")).toThrow(/Claude Code only/);
    expect(() => store.remove("claude-code", "default")).toThrow(ProfileError);
    const relay = store.create("claude-code", "Relay", "api");
    expect(store.othersOf("claude-code", work.id)).toEqual([join(dir, "..", "..", relay.id)].map((p) => join(p)));
    store.remove("claude-code", work.id);
    expect(existsSync(dir)).toBe(false);
    expect(store.current("claude-code")).toBe("default");
    expect(store.homeOf("claude-code", work.id)).toBeNull();
    expect(store.homeOf("claude-code", "../../etc")).toBeNull();
  });
});

describe("profiles over HTTP", () => {
  function served() {
    const w = world();
    const app = new Hono();
    mountProfiles(app, { profiles: w.store } as unknown as ApiDeps);
    const call = async (method: string, path: string, body?: unknown, env: object = {}) => {
      const res = await app.request(path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }, env);
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    return { ...w, call };
  }

  it("lists, makes, makes current and removes; a paired device may look and switch, not make or remove", async () => {
    const { call } = served();
    expect((await call("GET", "/profiles")).json.agents["claude-code"].profiles).toHaveLength(1);
    const made = await call("POST", "/profiles", { agent: "claude-code", name: "Work" });
    expect(made.status).toBe(201);
    const id = made.json.profile.id as string;
    expect((await call("POST", "/profiles", { agent: "claude-code", name: "Work" })).status).toBe(409);
    expect((await call("POST", "/profiles", { agent: "codex", name: "Team" })).status).toBe(400);
    const phone = markRemote({}, { deviceId: "phone" });
    expect((await call("POST", "/profiles", { agent: "claude-code", name: "Other" }, phone)).status).toBe(403);
    expect((await call("DELETE", `/profiles/claude-code/${id}`, undefined, phone)).status).toBe(403);
    const switched = await call("POST", "/profiles/current", { agent: "claude-code", id }, phone);
    expect(switched.json.agents["claude-code"].current).toBe(id);
    expect((await call("POST", "/profiles/current", { agent: "claude-code", id: "nope12" })).status).toBe(404);
    expect((await call("DELETE", `/profiles/claude-code/${id}`)).json.agents["claude-code"]).toMatchObject({ current: "default" });
    expect((await call("DELETE", `/profiles/claude-code/${id}`)).status).toBe(404);
  });
});

describe("a terminal under a profile", () => {
  it("starts Claude Code with the profile's folder as its config folder; Default sets nothing", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-profile-launch-"));
    const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, env: { PATH: "/usr/bin", HOME: "/Users/u" } });
    const own = launch({ id: "c1", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok", configHome: "/as/profiles/claude-code/abc123/home" });
    expect(own.env.CLAUDE_CONFIG_DIR).toBe("/as/profiles/claude-code/abc123/home");
    const plain = launch({ id: "c2", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(plain.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    // Another agent is not given Claude Code's folder.
    expect(launch({ id: "x1", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok", configHome: "/x" }).env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});
