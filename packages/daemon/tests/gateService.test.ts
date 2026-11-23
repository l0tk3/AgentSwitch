/** Where a node's gate runs (keeper/gateService.ts, gate-simple-v0 §5): decided by gate-service.json as the gate itself
 *  decides it, the daemon handed the service's places, the exact sudo commands, and the words in every language. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gateCommands, gateMode, gatePort, gateReport, parseServiceStatus, reportLines, serviceStatus, type GateReport } from "../src/keeper/gateService.js";
import { modeChanged, modeLine } from "../src/keeper/run.js";
import { DEFAULT_PORTS, plan, type Layout } from "../src/keeper/plan.js";
import { LOCALES, messages } from "../src/i18n/index.js";

const LAYOUT: Layout = { daemon: ["/rt/node/bin/node", "/rt/daemon/dist/cli.js"], gate: "/rt/python/bin/secret-gate", nodeBin: "/rt/node/bin", runtime: "/rt" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function root(config?: string): { env: NodeJS.ProcessEnv; publicDir: string } {
  const r = mkdtempSync(join(tmpdir(), "gate-mode-"));
  dirs.push(r);
  const publicDir = join(r, "gate-public");
  mkdirSync(publicDir);
  if (config !== undefined) writeFileSync(join(r, "gate-service.json"), config);
  return { env: { SECRET_GATE_PUBLIC: publicDir }, publicDir };
}

describe("where the gate runs", () => {
  it("is the service exactly when gate-service.json is there, socket or not", () => {
    expect(gateMode(root().env)).toEqual({ kind: "user" });
    const { env, publicDir } = root(JSON.stringify({ ownerUid: 1000, proxyPort: 8181, runtimeVersion: "v", installedAt: "t" }));
    expect(gateMode(env)).toEqual({ kind: "service", publicDir, ca: join(publicDir, "ca.pem"), proxyPort: 8181, ownerUid: 1000 });
  });

  it("fails closed: a config that cannot be read is still the service, never a gate of the user's own", () => {
    const bad = gateMode(root("{not json").env);
    expect(bad.kind).toBe("service");
    expect(bad.kind === "service" && bad.proxyPort).toBeNull();
    expect(bad.kind === "service" && bad.error).toMatch(/gate-service\.json/);
    const unreadable = gateMode({ SECRET_GATE_PUBLIC: "/x/gate-public" }, { lstat: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, read: () => { throw new Error("denied"); } });
    expect(unreadable.kind).toBe("service");
    // The default public directory is the one the daemon's deny list already names (executors/protected.ts).
    expect(gateMode({}, { lstat: (p) => { expect(String(p)).toMatch(/(Library\/Application Support\/AgentSwitch|\/var\/lib\/agentswitch)\/gate-service\.json$/); throw Object.assign(new Error(), { code: "ENOENT" }); }, read: () => "" })).toEqual({ kind: "user" });
  });

  it("hands the daemon the service's public directory, CA and port, as the Mac app does", () => {
    const { env, publicDir } = root(JSON.stringify({ ownerUid: 1000, proxyPort: 8181, runtimeVersion: "v", installedAt: "t" }));
    const mode = gateMode(env);
    const { daemonEnv } = plan({ env: { HOME: "/home/u" }, home: "/home/u/.agentswitch", gateHome: "/home/u/.secret-gate", settings: {}, ports: { ...DEFAULT_PORTS }, layout: LAYOUT, path: "/usr/bin", gate: mode });
    expect(daemonEnv).toMatchObject({ SECRET_GATE_PUBLIC: publicDir, SECRET_GATE_CA: join(publicDir, "ca.pem"), SECRET_GATE_PROXY: "http://127.0.0.1:8181" });
    const user = plan({ env: { HOME: "/home/u" }, home: "/h", gateHome: "/g", settings: {}, ports: { ...DEFAULT_PORTS }, layout: LAYOUT, path: "/usr/bin" }).daemonEnv;
    expect(user).not.toHaveProperty("SECRET_GATE_PUBLIC");
    expect(user).not.toHaveProperty("SECRET_GATE_CA");
    expect(gatePort({ kind: "user" }, { ...DEFAULT_PORTS, gate: 9000 })).toBe(9000);
  });

  it("prints the exact sudo commands for this runtime, quoted, and none from a checkout", () => {
    expect(gateCommands(LAYOUT, { ...DEFAULT_PORTS, gate: 8181 }, 1000)).toEqual({
      install: "sudo /rt/python/bin/secret-gate system install --owner-uid 1000 --port 8181 --runtime /rt",
      update: "sudo /rt/python/bin/secret-gate system update --runtime /rt",
      rotateKey: "sudo /rt/python/bin/secret-gate system rotate-key",
      uninstall: "sudo /rt/python/bin/secret-gate system uninstall",
    });
    const spaced = gateCommands({ ...LAYOUT, gate: "/home/a b/rt/python/bin/secret-gate", runtime: "/home/a b/rt" }, { ...DEFAULT_PORTS }, 1000)!;
    expect(spaced.install).toBe("sudo '/home/a b/rt/python/bin/secret-gate' system install --owner-uid 1000 --port 8080 --runtime '/home/a b/rt'");
    expect(gateCommands({ ...LAYOUT, runtime: null }, { ...DEFAULT_PORTS }, 1000)).toBeNull();
  });

  it("reads the service's status and never fails on a bad answer", async () => {
    expect(parseServiceStatus('{"installed":true,"running":false,"updateAvailable":true,"error":"无响应"}')).toEqual({ installed: true, running: false, updateAvailable: true, error: "无响应" });
    expect(parseServiceStatus("nope")).toBeNull();
    const asked: string[][] = [];
    expect(await serviceStatus("/rt/sg", {}, async (_b, args) => { asked.push([...args]); return '{"installed":true,"running":true}'; })).toMatchObject({ running: true });
    expect(asked).toEqual([["system", "status", "--json"]]);
    expect(await serviceStatus("/rt/sg", {}, async () => { throw new Error("gone"); })).toBeNull();
    const { env } = root(JSON.stringify({ ownerUid: 1000, proxyPort: 8080, runtimeVersion: "v", installedAt: "t" }));
    const r = await gateReport({ env, layout: LAYOUT, ports: { ...DEFAULT_PORTS }, uid: 1000, exec: async () => '{"installed":true,"running":true,"updateAvailable":true}' });
    expect(r.status?.updateAvailable).toBe(true);
    expect(r.platform).toBe(process.platform);
  });

  it("says the user mode in every language on Linux, with the command; the service with update and rotate-key", () => {
    const commands = gateCommands(LAYOUT, { ...DEFAULT_PORTS }, 1000);
    const user: GateReport = { mode: { kind: "user" }, status: null, commands, platform: "linux" };
    expect(reportLines(user, messages("zh-Hans").gateMode)).toEqual([
      "此节点的网关以你的账户运行：只防误看，不防顺手读取", "要让它有自己的账户，运行一次（需要 sudo）：",
      "  sudo /rt/python/bin/secret-gate system install --owner-uid 1000 --port 8080 --runtime /rt"]);
    for (const l of LOCALES) expect(reportLines(user, messages(l).gateMode)[0]!.length, l).toBeGreaterThan(10);
    expect(reportLines({ ...user, commands: null }, messages("en").gateMode)[1]).toMatch(/install\.sh/);
    expect(reportLines({ ...user, platform: "darwin" }, messages("en").gateMode)).toEqual([]);   // the Mac app says it there
    const service: GateReport = { mode: { kind: "service", publicDir: "/p", ca: "/p/ca.pem", proxyPort: 8080, ownerUid: 1000 }, status: { installed: true, running: false, updateAvailable: true, error: "x" }, commands, platform: "linux" };
    const lines = reportLines(service, messages("en").gateMode);
    expect(lines[0]).toMatch(/system service/);
    expect(lines).toContain("The gate service does not answer. (x)");
    expect(lines).toContain("  sudo /rt/python/bin/secret-gate system update --runtime /rt");
    expect(lines).toContain("  sudo /rt/python/bin/secret-gate system rotate-key");
    // Found on a real node (2026-11-23): `system update --port` must move the keeper and the daemon too.
    const s = { kind: "service" as const, publicDir: "/p", ca: "/p/ca.pem", proxyPort: 8080, ownerUid: 1000 };
    expect(modeChanged(s, { ...s, proxyPort: 8181 })).toBe(true);
    expect(modeChanged(s, { ...s })).toBe(false);
    expect(modeChanged(s, { kind: "user" })).toBe(true);
    expect(modeChanged({ kind: "user" }, { kind: "user" })).toBe(false);
    expect(modeLine({ kind: "user" })).toMatch(/guards against values being seen by mistake/);
    expect(modeLine(service.mode)).toMatch(/system service.*not starting one/);
  });
});
