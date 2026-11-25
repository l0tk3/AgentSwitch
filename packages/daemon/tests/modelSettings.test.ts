/** app-v0 §2 模型设置: models.json's router model over targets.yaml at load (checked against the catalog, ignored with
 *  a warning when it does not fit), GET/PUT /settings/models on the local API. The fallback target is always the
 *  router target: the separate default setting was removed on 2026-11-23. */

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildDaemon, defaultConfig, remotePort, type DaemonConfig } from "../src/daemon.js";
import { applyModelOverlay, modelSettings, overlayProblems, readModelOverlay, withModelOverlay, writeModelOverlay } from "../src/models/modelOverlay.js";
import { markUnavailable, parseTargets, type Targets } from "../src/models/targets.js";
import { realTargets, TARGETS_PATH } from "./helpers.js";

/** A catalog with a wildcard entry and an unavailable model, to check what counts as selectable. */
function catalog(): Targets {
  const t = realTargets();
  const opencode = t.harnesses.opencode!;
  const withExtra: Targets = { ...t, harnesses: { ...t.harnesses, opencode: { ...opencode, models: { ...opencode.models, "deepseek/deepseek-pro": { cost: "mid", strengths: [] }, "openrouter/*": { cost: "mid", strengths: [] } } } } };
  return markUnavailable(withExtra, [{ harness: "codex", model: "gpt-5.5" }]);
}

function daemonAt(home: string) {
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  return buildDaemon(cfg, { remote: null });
}

describe("model overlay", () => {
  it("applies the router model; the fallback target is always the router target (the default setting was removed 2026-11-23)", () => {
    const t = catalog();
    const r = applyModelOverlay(t, { router: { model: "deepseek/deepseek-pro" }, default: { harness: "claude-code", model: "claude-opus-5" } });
    expect(r.warnings).toEqual([]);
    expect(r.targets.router.model).toBe("deepseek/deepseek-pro");
    expect(r.targets.router.default).toEqual({ harness: "opencode", model: "deepseek/deepseek-pro" });   // an old file's default is ignored
    expect(r.targets.router.harness).toBe(t.router.harness);
    expect(t.router.model).toBe("deepseek/deepseek-flash");   // the input is not touched
    expect(t.router.default).toEqual({ harness: "opencode", model: "deepseek/deepseek-flash" });   // targets.yaml: router harness/model
  });

  it("a router model that does not fit is ignored with a reason", () => {
    const t = catalog();
    const r = applyModelOverlay(t, { router: { model: "claude-opus-5" } });
    expect(r.targets.router.model).toBe(t.router.model);
    expect(r.targets.router.default).toEqual({ harness: "opencode", model: "deepseek/deepseek-flash" });
    expect(r.warnings).toEqual(["router.model claude-opus-5 is not a opencode model"]);
    const unavailableRouter = markUnavailable(t, [{ harness: "opencode", model: "deepseek/deepseek-pro" }]);
    expect(overlayProblems(unavailableRouter, { router: { model: "deepseek/deepseek-pro" } })).toEqual(["router.model deepseek/deepseek-pro is unavailable"]);
    expect(overlayProblems(t, { router: { model: "openrouter/some-model" } })).toEqual([]);   // wildcard entries admit ids
    expect(overlayProblems(t, { default: { harness: "nope", model: "x" } })).toEqual([]);   // not checked: never applied
    expect(overlayProblems(t, {})).toEqual([]);
  });

  it("targets.yaml: router.model must be a listed model of router.harness; a `default` there is ignored", () => {
    const yaml = (model: string) => `harnesses:\n  opencode:\n    quota: balance\n    max_concurrent: 1\n    browser: false\n    default_model: a/x\n    models:\n      a/x: {cost: low}\n      a/y: {cost: low}\nrouter:\n  harness: opencode\n  model: ${model}\n  default: {harness: opencode, model: a/x}\n`;
    expect(parseTargets(yaml("a/y")).router.default).toEqual({ harness: "opencode", model: "a/y" });
    expect(() => parseTargets(yaml("a/z"))).toThrow(/router\.model must be a listed model of router\.harness/);
  });

  it("the file: absent → nothing, bad JSON or shape → ignored with a warning, never a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-models-"));
    const path = join(dir, "models.json");
    expect(readModelOverlay(path)).toEqual({ overlay: null, warnings: [] });
    writeFileSync(path, "{not json");
    expect(readModelOverlay(path).warnings[0]).toMatch(/not JSON/);
    writeFileSync(path, JSON.stringify({ router: { model: 42 } }));
    expect(readModelOverlay(path).warnings[0]).toMatch(/router\.model/);
    const warn = vi.fn();
    const t = catalog();
    expect(withModelOverlay(t, path, warn)).toEqual(t);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("models.json ignored in part"));
    // An older file with a default: read without a warning, the default left out.
    writeFileSync(path, JSON.stringify({ router: { model: "deepseek/deepseek-pro" }, default: { harness: "ghost", model: "x" } }));
    const warn2 = vi.fn();
    const merged = withModelOverlay(t, path, warn2);
    expect(merged.router.model).toBe("deepseek/deepseek-pro");
    expect(merged.router.default).toEqual({ harness: "opencode", model: "deepseek/deepseek-pro" });
    expect(warn2).not.toHaveBeenCalled();
    writeModelOverlay(path, { router: { model: "deepseek/deepseek-pro" }, default: { harness: "ghost", model: "x" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ router: { model: "deepseek/deepseek-pro" } });
  });

  it("settings view: router options are the router harness's selectable models; default is the router target; per harness models and default_model", () => {
    const view = modelSettings(catalog());
    expect(view.router).toEqual({ model: "deepseek/deepseek-flash", options: ["deepseek/deepseek-flash", "deepseek/deepseek-pro"] });
    expect(view.default).toEqual({ harness: "opencode", model: "deepseek/deepseek-flash" });
    expect(Object.keys(view.harnesses)).toEqual(["claude-code", "codex", "opencode"]);
    expect(view.harnesses.codex!.models).not.toContain("gpt-5.5");
    expect(view.harnesses.codex!.default_model).toBe("gpt-6-astra");
    expect(view.harnesses["claude-code"]!.models).toContain("claude-opus-5[1m]");
  });
});

describe("GET/PUT /settings/models", () => {
  it("PUT takes the router model only, writes models.json, asks for a restart; GET shows what the next start will use", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-models-api-"));
    const d = daemonAt(home);
    const get = async () => (await d.app.request("/settings/models")).json() as Promise<Record<string, unknown>>;
    const put = (body: unknown) => d.app.request("/settings/models", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const before = await get();
    expect(before).toMatchObject({ router: { model: "deepseek/deepseek-flash", options: ["deepseek/deepseek-flash"] }, default: { harness: "opencode", model: "deepseek/deepseek-flash" }, restartRequired: false });
    expect(Object.keys(before.harnesses as object)).toEqual(["claude-code", "codex", "opencode"]);

    for (const [body, pattern] of [
      [{}, /router/], [{ router: { model: "gpt-5.5" } }, /not a opencode model/], [{ router: "x" }, /router/],
      [{ default: { harness: "codex", model: "gpt-6-astra" } }, /default is no longer a setting/],
      [{ router: { model: "deepseek/deepseek-flash" }, default: { harness: "codex", model: "gpt-6-astra" } }, /default is no longer a setting/],
    ] as const) {
      const r = await put(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(pattern);
    }
    expect(existsSync(join(home, "models.json"))).toBe(false);

    // An older Mac app's file, with a default: a router change replaces the file and drops it.
    const path = join(home, "models.json");
    writeFileSync(path, JSON.stringify({ default: { harness: "claude-code", model: "claude-opus-5" } }));
    expect(await get()).toMatchObject({ default: { harness: "opencode", model: "deepseek/deepseek-flash" }, restartRequired: false });
    const ok = await put({ router: { model: "deepseek/deepseek-flash" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ restartRequired: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ router: { model: "deepseek/deepseek-flash" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(d.targets.router.default).toEqual({ harness: "opencode", model: "deepseek/deepseek-flash" });
    d.close();
  });

  it("a models.json with a default (an older Mac app's) never stops the daemon from starting and is not applied", () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-models-bad-"));
    writeFileSync(join(home, "models.json"), JSON.stringify({ default: { harness: "claude-code", model: "no-such-model" } }));
    const d = daemonAt(home);
    expect(d.targets.router.default).toEqual({ harness: "opencode", model: "deepseek/deepseek-flash" });
    d.close();
  });
});

describe("remote configuration from the environment", () => {
  it("AGENTSWITCH_REMOTE=1 turns it on with port 4713 unless AGENTSWITCH_REMOTE_PORT says otherwise", () => {
    expect(defaultConfig({ HOME: "/h" }).remote).toBeUndefined();
    expect(defaultConfig({ HOME: "/h", AGENTSWITCH_REMOTE: "0" }).remote).toBeUndefined();
    expect(defaultConfig({ HOME: "/h", AGENTSWITCH_REMOTE: "1" }).remote).toEqual({ port: 4713 });
    expect(defaultConfig({ HOME: "/h", AGENTSWITCH_REMOTE: "true", AGENTSWITCH_REMOTE_PORT: "5713", AGENTSWITCH_REMOTE_NAME: " Studio " }).remote).toEqual({ port: 5713, name: "Studio" });
    for (const bad of ["", "abc", "70000", "-1", "1.5"]) expect(remotePort(bad), bad).toBe(4713);
    expect(remotePort(undefined)).toBe(4713);
    expect(remotePort("0")).toBe(0);
  });
});
