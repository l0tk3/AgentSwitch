import { describe, expect, it } from "vitest";
import { ProfileHealthChecks } from "../src/profiles/health.js";
import type { ProfileStore } from "../src/profiles/store.js";
import type { ApiKeys, ModelProbe } from "../src/profiles/apiKeys.js";
import { Hono } from "hono";
import { mountProfiles } from "../src/api/profiles.js";
import type { ApiDeps } from "../src/api/shared.js";
import { markRemote } from "../src/core/caller.js";

function setup(result: ModelProbe = { models: ["model-a"] }) {
  const seen: unknown[] = [];
  const store = {
    all: () => ({ "claude-code": { profiles: [{ id: "default" }, { id: "api123" }, { id: "sub123" }] } }),
    apiOf: (_a: string, id: string) => id === "api123" ? { key: "encrypted", baseUrl: "https://relay.example" } : null,
  } as unknown as ProfileStore;
  const keys = { models: async (agent: string, args: unknown) => { seen.push([agent, args]); return result; } } as unknown as ApiKeys;
  const health = new ProfileHealthChecks(store, keys, async (agent, id) => {
    seen.push([agent, id]);
    return { status: "healthy", message: "usage read", windows: [{ label: "5h", usedPercent: 23, resetsAt: 1000 }] };
  });
  return { health, store, seen };
}

describe("per-profile health", () => {
  it("uses an API profile's own address and stored key, and keeps the result separately", async () => {
    const { health, seen } = setup();
    expect((await health.check("claude-code", "api123")).status).toBe("healthy");
    expect(seen).toEqual([["claude-code", { profile: "api123", baseUrl: "https://relay.example" }]]);
    expect(Object.keys(health.current())).toEqual(["claude-code.api123"]);
  });
  it.each([
    [{ refused: 401 }, "unhealthy"], [{ unlisted: true }, "unknown"], [{ status: 429 }, "unhealthy"],
    [{ unreachable: "secret proxy password" }, "unhealthy"],
  ] as const)("distinguishes API failures without exposing response secrets: %j", async (result, status) => {
    const { health } = setup(result);
    const reading = await health.check("claude-code", "api123");
    expect(reading.status).toBe(status);
    expect(JSON.stringify(reading)).not.toContain("secret proxy password");
  });
  it("uses the requested subscription and coalesces simultaneous checks", async () => {
    const { health, seen } = setup();
    const [a, b] = await Promise.all([health.check("claude-code", "sub123"), health.check("claude-code", "sub123")]);
    expect(a).toEqual(b);
    expect(a.windows[0]?.usedPercent).toBe(23);
    expect(seen).toEqual([["claude-code", "sub123"]]);
    expect(() => health.check("claude-code", "missing")).toThrow("no such profile");
  });
  it("checks locally and for authenticated paired devices", async () => {
    const { health, store } = setup();
    const app = new Hono();
    mountProfiles(app, { profiles: store, profileHealth: health } as ApiDeps);
    expect((await app.request("/profiles/claude-code/sub123/health", { method: "POST" }, markRemote({}, { deviceId: "phone" }))).status).toBe(200);
    const response = await app.request("/profiles/claude-code/sub123/health", { method: "POST" });
    expect(response.status).toBe(200);
    expect((await response.json()).windows).toHaveLength(1);
    expect((await app.request("/profiles/claude-code/missing/health", { method: "POST" })).status).toBe(404);
  });
});
