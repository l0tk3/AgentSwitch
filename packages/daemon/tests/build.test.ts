/** The production build (app-v0 §4 打包): tsconfig.build.json compiles src/ to a dist/ that mirrors it, so config/ and
 *  ui/ are found next to dist/ as they are next to src/. Built into a temp copy of the layout the Mac app ships (dist,
 *  config, ui, package.json, node_modules), never over this package's own dist/. Then run with plain node, no tsx. */

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { get } from "node:http";
import { request } from "node:https";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PKG = resolve(import.meta.dirname, "..");
const BUILD_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 20_000;

function jsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? jsFiles(path) : path.endsWith(".js") ? [path] : [];
  });
}

/** Bare module specifiers (not relative, not node:) imported anywhere in the built files, as package names. */
function packagesImported(dist: string): Set<string> {
  const statement = /^\s*(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?(["'])([^"'\n]+)\1/gm;   // import/export … from "x", import "x"
  const dynamic = /\bimport\(\s*(["'])([^"'\n]+)\1\s*\)/g;
  const names = jsFiles(dist).flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return [...text.matchAll(statement), ...text.matchAll(dynamic)].map((m) => m[2]!).filter((n) => !n.startsWith("."));
  });
  return new Set(names.filter((n) => !n.startsWith("node:") && !builtinModules.includes(n)).map((n) => (n.startsWith("@") ? n.split("/").slice(0, 2).join("/") : n.split("/")[0]!)));
}

function httpJson(url: string, token?: string): Promise<unknown> {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return new Promise((ok, fail) => get(url, { headers }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok(JSON.parse(b))); }).on("error", fail));
}

function httpsJson(port: number, path: string): Promise<unknown> {
  return new Promise((ok, fail) => request({ host: "127.0.0.1", port, path, rejectUnauthorized: false }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok(JSON.parse(b))); }).on("error", fail).end());
}

describe("production build", () => {
  it("compiles to dist/ mirroring src/, imports only runtime dependencies, and serves with plain node", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentswitch-build-"));
    const app = join(root, "daemon");
    mkdirSync(app);
    execFileSync(join(PKG, "node_modules", ".bin", "tsc"), ["-p", join(PKG, "tsconfig.build.json"), "--outDir", join(app, "dist")], { cwd: PKG, stdio: "pipe" });
    for (const dir of ["config", "ui"]) cpSync(join(PKG, dir), join(app, dir), { recursive: true });
    cpSync(join(PKG, "package.json"), join(app, "package.json"));
    symlinkSync(join(PKG, "node_modules"), join(app, "node_modules"));

    // the layout mirrors src/: every top-level directory and root file is there
    const dist = join(app, "dist");
    for (const entry of readdirSync(join(PKG, "src"))) expect(existsSync(join(dist, entry.replace(/\.ts$/, ".js"))), entry).toBe(true);
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const imported = [...packagesImported(dist)];
    expect(imported.length).toBeGreaterThan(3);
    expect(imported.filter((name) => !(name in pkg.dependencies))).toEqual([]);

    const node = process.execPath;
    const help = execFileSync(node, ["--no-warnings=ExperimentalWarning", join(dist, "cli.js"), "--help"], { encoding: "utf8" });
    expect(help).toMatch(/^usage: serve/);

    const home = join(root, "home");
    const env = { HOME: process.env.HOME ?? root, PATH: "/usr/bin:/bin", AGENTSWITCH_HOME: home, AGENTSWITCH_PORT: "0", AGENTSWITCH_ROUTER: "echo", AGENTSWITCH_EXECUTORS: "echo", AGENTSWITCH_REMOTE: "1", AGENTSWITCH_REMOTE_PORT: "0", AGENTSWITCH_REMOTE_NAME: "Build Test" };
    const child = spawn(node, ["--no-warnings=ExperimentalWarning", join(dist, "cli.js"), "serve"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const ports = await new Promise<{ local: number; remote: number }>((ok, fail) => {
        let log = "";
        const timer = setTimeout(() => fail(new Error(`daemon did not start:\n${log}`)), START_TIMEOUT_MS);
        child.stderr.on("data", (c: Buffer) => {
          log += c.toString();
          const local = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
          const remote = /remote listening on https:\/\/\*:(\d+)/.exec(log);
          if (local && remote) { clearTimeout(timer); ok({ local: Number(local[1]), remote: Number(remote[1]) }); }
        });
        child.on("exit", (code) => { clearTimeout(timer); fail(new Error(`daemon exited ${code}:\n${log}`)); });
      });
      expect(await httpJson(`http://127.0.0.1:${ports.local}/healthz`)).toMatchObject({ ok: true, version: "0.1.0" });
      // The local API wants the token the daemon wrote on start-up (api/localAuth.ts); without it, 401.
      expect(await httpJson(`http://127.0.0.1:${ports.local}/remote/info`)).toMatchObject({ error: expect.stringContaining("token") });
      const token = readFileSync(join(home, "local-token"), "utf8").trim();
      expect(await httpJson(`http://127.0.0.1:${ports.local}/remote/info`, token)).toMatchObject({ enabled: true, name: "Build Test", bonjour: "AgentSwitch on Build Test" });
      expect(await httpsJson(ports.remote, "/healthz")).toEqual({ ok: true });
      expect(statSync(join(home, "remote", "key.pem")).mode & 0o777).toBe(0o600);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<number | null>((ok) => child.once("exit", (code) => ok(code)));
        child.kill("SIGTERM");
        expect(await exited).toBe(0);   // SIGTERM closes the listeners and the store, then exits cleanly
      }
    }
  }, BUILD_TIMEOUT_MS);
});
