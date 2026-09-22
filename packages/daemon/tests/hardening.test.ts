import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCwd, defaultCwdRules } from "../src/api/cwdPolicy.js";
import { loadPolicy } from "../src/engine/approvalPolicy.js";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { decideTool } from "../src/executors/claude.js";
import { echoExecutor } from "../src/executors/echo.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { isSelfHarm, routerSupervisor, SupervisorConfig } from "../src/router/supervisor.js";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { Client } from "../src/client.js";
import { QuotaService } from "../src/quota/index.js";
import { decisionJson, realTargets, TARGETS_PATH } from "./helpers.js";

const targets = realTargets();

describe("hardening (audit 2026-09-22)", () => {
  it("cwd rules: relative, root, home, credential dirs, the daemon home and missing dirs are refused", () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-h-"));
    const rules = defaultCwdRules({ HOME: home, SECRET_GATE_HOME: join(home, ".secret-gate") }, join(home, ".agentswitch"));
    expect(checkCwd("relative/dir", rules)).toMatch(/absolute/);
    expect(checkCwd("/", rules)).toMatch(/too broad/);
    expect(checkCwd(home, rules)).toMatch(/too broad/);
    expect(checkCwd(join(home, ".ssh"), rules)).toMatch(/credentials/);
    expect(checkCwd(join(home, ".agentswitch", "work", "x"), rules)).toMatch(/daemon/);
    expect(checkCwd(join(home, "nope"), rules)).toMatch(/not an existing directory/);
    expect(checkCwd(tmpdir(), rules)).toBeNull();
  });

  it("an approval can only be answered through its own task; ids are full UUIDs", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-h2-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const d = buildDaemon(cfg, { router: echoRouter(() => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })), quota: new QuotaService([]) });
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(d.app.request(input instanceof Request ? input : String(input).replace("http://test", ""), init));
    const client = new Client("http://test", fetchImpl);
    const other = await client.submit("other", "/tmp");
    const t = await client.submit('x @echo {"approval":"npm test"}', "/tmp");
    let approvalId = "";
    await client.watch(t.id, async (ev) => {
      if (ev.type === "approval_request") {
        approvalId = String(ev.payload.approvalId);
        expect(approvalId).toHaveLength(36);
        await expect(client.approve(other.id, approvalId, "allow")).rejects.toThrow(/no pending approval/);
        await client.approve(t.id, approvalId, "allow");
      }
    });
    expect((await client.task(t.id)).status).toBe("done");
    await expect(client.submit("x", "/")).rejects.toThrow(/too broad/);
    d.close();
  });

  it("self-harm actions are denied by the supervisor in every mode, WebSearch is read-only, a broken policy file means manual", async () => {
    expect(isSelfHarm("Bash: cat ~/.secret-gate/keys.json")).toBe(true);
    expect(isSelfHarm("Edit outside cwd: /Users/x/.agentswitch/mcp.json")).toBe(true);
    const sup = routerSupervisor({ name: "never-called", route: async () => { throw new Error("must not be asked"); } }, SupervisorConfig.parse({}));
    expect(await sup.approve({ brief: "b", action: "Write: /Users/x/.agentswitch/CONTEXT.md", evidence: "", recentEvents: [], sideEffects: "", cwd: "/w", floor: false })).toMatchObject({ decision: "deny", source: "floor" });
    expect(decideTool("WebSearch", { query: "x" }, "/tmp")).toEqual({ kind: "allow" });   // decided 2026-09-22: search has no side effects
    const p = join(mkdtempSync(join(tmpdir(), "agentswitch-h3-")), "approvals.json");
    writeFileSync(p, "{not json");
    expect(loadPolicy(p)).toEqual({ mode: "manual", human: [] });
  });

  it("a user handoff of a running task is recorded on that task's track record", async () => {
    const store = new Store({ dbPath: ":memory:", threadsDir: join(mkdtempSync(join(tmpdir(), "agentswitch-h4-")), "threads") });
    const bus = new Bus();
    const events: TaskEvent[] = [];
    bus.subscribe("*", (e) => events.push(e));
    const engine = new Engine({ store, bus, executors: Object.keys(targets.harnesses).map((h) => echoExecutor(h)), targets, router: echoRouter(() => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })), quota: () => ({}), approvalTimeoutMs: 100, retryBackoffMs: 1 });
    const a = engine.submit({ task: 'slow @echo {"delayMs":300}', cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 60));
    engine.handoff(a.id, { to: { harness: "claude-code", model: "claude-haiku-4-5-20251001" } });
    await engine.idle();
    expect(store.recordsSince(0).find((r) => r.taskId === a.id)).toMatchObject({ status: "cancelled", userHandoff: true });
  });
});
