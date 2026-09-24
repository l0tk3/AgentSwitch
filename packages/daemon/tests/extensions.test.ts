import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideTool } from "../src/executors/claude.js";
import { codexConfigToml } from "../src/executors/codex.js";
import { autoAllowedMcp, claudeMcpFromRegistry, claudePluginDir, codexMcpToml, mcpServerOf, opencodeMcpFromRegistry } from "../src/executors/extensions.js";
import { opencodeExecConfig } from "../src/executors/opencode.js";
import { extensionsAt } from "../src/extensions/index.js";
import { McpRegistry, removeServer, serversFor, upsertServer } from "../src/extensions/mcpRegistry.js";
import { ensureFrontmatter, SkillRegistry } from "../src/extensions/skillRegistry.js";
import { codexGateToml, gateEnv, inheritedEnv, mcpServerEnv } from "../src/executors/gate.js";
import { McpServer, parseFrontmatter } from "../src/extensions/types.js";

const tmp = () => mkdtempSync(join(tmpdir(), "agentswitch-ext-"));
const stdio = McpServer.parse({ name: "github", kind: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { GH_TOKEN: "enc:v1:abc" } });
const http = McpServer.parse({ name: "docs", kind: "http", url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer enc:v1:x" }, approval: "allow", harnesses: ["codex"] });

describe("McpServer schema", () => {
  it("fills defaults and rejects reserved or malformed entries", () => {
    expect(stdio.enabled).toBe(true);
    expect(stdio.harnesses).toEqual(["claude-code", "codex", "opencode"]);
    expect(stdio.approval).toBe("ask");
    expect(McpServer.safeParse({ name: "secret-gate", kind: "stdio", command: "x" }).success).toBe(false);
    expect(McpServer.safeParse({ name: "Bad Name", kind: "stdio", command: "x" }).success).toBe(false);
    expect(McpServer.safeParse({ name: "nocmd", kind: "stdio" }).success).toBe(false);
    expect(McpServer.safeParse({ name: "nourl", kind: "http" }).success).toBe(false);
    expect(McpServer.safeParse({ name: "ftp", kind: "http", url: "ftp://x" }).success).toBe(false);
  });
});

describe("McpRegistry", () => {
  it("pure list ops keep order and filter by harness", () => {
    const list = upsertServer(upsertServer([], stdio), http);
    expect(list.map((s) => s.name)).toEqual(["github", "docs"]);
    expect(upsertServer(list, { ...stdio, note: "v2" }).map((s) => s.note)).toEqual(["v2", ""]);
    expect(removeServer(list, "github").map((s) => s.name)).toEqual(["docs"]);
    expect(serversFor(list, "codex").map((s) => s.name)).toEqual(["github", "docs"]);
    expect(serversFor(list, "opencode").map((s) => s.name)).toEqual(["github"]);
    expect(serversFor(upsertServer(list, { ...stdio, enabled: false }), "opencode")).toEqual([]);
  });
  it("persists to a 0600 JSON file and re-reads it", () => {
    const path = join(tmp(), "mcp.json");
    const reg = new McpRegistry(path);
    expect(reg.list()).toEqual([]);
    reg.upsert(stdio);
    reg.upsert(http);
    expect(new McpRegistry(path).get("docs")?.url).toBe("https://mcp.example.com/sse");
    expect(reg.enabledFor("opencode").map((s) => s.name)).toEqual(["github"]);
    expect(reg.remove("github")).toBe(true);
    expect(reg.remove("github")).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).servers).toHaveLength(1);
  });
});

describe("spawned MCP server env", () => {
  it("inherits only what a child needs to start", () => {
    const e = inheritedEnv({ PATH: "/bin", HOME: "/h", SECRET: "nope", LANG: "C" });
    expect(e).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C" });
  });
  it("adds the proxy and the gate CA when the CA has been exported", () => {
    const home = tmp();
    const g = { bin: "/g/secret-gate", home, proxy: "http://127.0.0.1:8080", playwrightVersion: "0.0.82", allowedOrigins: [] };
    const parent = { PATH: "/bin", HOME: "/h" };
    const without = mcpServerEnv(g, parent);
    expect(without.PATH).toBe("/bin");
    expect(without.HTTPS_PROXY).toBe("http://127.0.0.1:8080");
    expect(without.NODE_EXTRA_CA_CERTS).toBeUndefined();
    writeFileSync(join(home, "ca.pem"), "-----BEGIN CERTIFICATE-----");
    const withCa = mcpServerEnv(g, parent);
    expect(withCa.NODE_EXTRA_CA_CERTS).toBe(join(home, "ca.pem"));
    expect(withCa.SSL_CERT_FILE).toBe(join(home, "ca.pem"));
    expect(mcpServerEnv(null, parent)).toEqual(parent);
  });

  it("every executor's own env carries the gate CA too, so its shell tools verify intercepted TLS (design-v0 §3)", () => {
    // 2026-09-24: from the Mac app (a clean env, no scripts/env.sh) Python and curl in an executor failed every HTTPS
    // call through the gate with "unable to get local issuer certificate".
    const home = tmp();
    const g = { bin: "/g/secret-gate", home, proxy: "http://127.0.0.1:8080", playwrightVersion: "0.0.82", allowedOrigins: [] };
    expect(gateEnv(g)).not.toHaveProperty("SSL_CERT_FILE");
    writeFileSync(join(home, "ca.pem"), "-----BEGIN CERTIFICATE-----");
    const ca = join(home, "ca.pem");
    expect(gateEnv(g, "SCOPE")).toMatchObject({ SSL_CERT_FILE: ca, REQUESTS_CA_BUNDLE: ca, NODE_EXTRA_CA_CERTS: ca, HTTPS_PROXY: "http://scope:SCOPE@127.0.0.1:8080" });
    expect(codexGateToml(g, join(home, "profile"), false)).toContain(`SSL_CERT_FILE = ${JSON.stringify(ca)}`);
  });
});

describe("harness shapes", () => {
  const base = { HTTPS_PROXY: "http://127.0.0.1:8080" };
  it("claude: stdio inherits gate env under the user's env; http passes headers", () => {
    const c = claudeMcpFromRegistry([stdio, http], base);
    expect(c.github).toEqual({ type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { HTTPS_PROXY: "http://127.0.0.1:8080", GH_TOKEN: "enc:v1:abc" } });
    expect(c.docs).toEqual({ type: "http", url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer enc:v1:x" } });
    expect(claudeMcpFromRegistry([{ ...stdio, env: { HTTPS_PROXY: "mine" } }], base).github).toMatchObject({ env: { HTTPS_PROXY: "mine" } });
  });
  it("opencode: local/remote entries merge next to the gate's", () => {
    const o = opencodeMcpFromRegistry([stdio, http], base);
    expect(o.github).toEqual({ type: "local", command: ["npx", "-y", "gh-mcp"], environment: { HTTPS_PROXY: "http://127.0.0.1:8080", GH_TOKEN: "enc:v1:abc" }, enabled: true });
    expect(o.docs).toMatchObject({ type: "remote", url: "https://mcp.example.com/sse" });
    const cfg = opencodeExecConfig(null, "/p", false, { mcp: o, skillsDir: "/s" }) as { mcp: Record<string, unknown>; skills: { paths: string[] } };
    expect(Object.keys(cfg.mcp)).toEqual(["github", "docs"]);
    expect(cfg.skills.paths).toEqual(["/s"]);
    expect((opencodeExecConfig(null, "/p", false) as { skills?: unknown }).skills).toBeUndefined();
  });
  it("codex: toml tables with quoted keys, appended after the gate sections", () => {
    const t = codexMcpToml([stdio, http], base);
    expect(t).toContain('[mcp_servers."github"]\ncommand = "npx"\nargs = ["-y","gh-mcp"]');
    expect(t).toContain('[mcp_servers."github".env]\n"HTTPS_PROXY" = "http://127.0.0.1:8080"\n"GH_TOKEN" = "enc:v1:abc"');
    expect(t).toContain('[mcp_servers."docs"]\nurl = "https://mcp.example.com/sse"');
    expect(t).toContain('[mcp_servers."docs".http_headers]\n"Authorization" = "Bearer enc:v1:x"');
    expect(codexMcpToml([], base)).toBe("");
    const full = codexConfigToml(null, "/p", false, null, t);
    expect(full.indexOf("network_access")).toBeLessThan(full.indexOf("[mcp_servers"));
  });
  it("claude tool policy: allow-listed servers skip approval, others ask; Skill tool is free", () => {
    expect(mcpServerOf("mcp__github__create_issue")).toBe("github");
    expect(mcpServerOf("mcp__my_srv__do")).toBe("my_srv");
    expect(mcpServerOf("Bash")).toBeNull();
    const allowed = autoAllowedMcp([stdio, http]);
    expect([...allowed]).toEqual(["docs"]);
    expect(decideTool("mcp__docs__search", {}, "/w", allowed).kind).toBe("allow");
    expect(decideTool("mcp__github__create_issue", {}, "/w", allowed).kind).toBe("ask");
    expect(decideTool("mcp__github__create_issue", {}, "/w").kind).toBe("ask");
    expect(decideTool("mcp__secret-gate__secret_http", {}, "/w").kind).toBe("allow");
    expect(decideTool("Skill", { skill: "pdf" }, "/w").kind).toBe("allow");
  });
  it("claude plugin dir only when skills exist", () => {
    const root = tmp();
    expect(claudePluginDir(root, join(root, "skills"))).toBeNull();
    mkdirSync(join(root, "skills", "a"), { recursive: true });
    expect(claudePluginDir(root, join(root, "skills"))).toBe(root);
    expect(JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("agentswitch");
  });
});

describe("SkillRegistry", () => {
  it("frontmatter parsing and completion", () => {
    expect(parseFrontmatter("---\nname: pdf\ndescription: \"Read PDFs\"\n---\nbody")).toEqual({ name: "pdf", description: "Read PDFs" });
    expect(parseFrontmatter("no header")).toEqual({ name: null, description: "" });
    expect(ensureFrontmatter("x", "# Do X\n\nsteps")).toMatch(/^---\nname: x\ndescription: Do X\n---/);
    expect(ensureFrontmatter("x", "---\nname: y\n---\nz")).toBe("---\nname: y\n---\nz");
  });
  it("write, list, toggle, materialize per harness, remove", () => {
    const home = tmp();
    const reg = new SkillRegistry(join(home, "skills"));
    expect(reg.list()).toEqual([]);
    expect(() => reg.write("nope", {})).toThrow(/content required/);
    expect(() => reg.write("Bad", { content: "x" })).toThrow(/invalid/);
    reg.write("deploy", { content: "# Deploy\n\nrun the thing" });
    reg.write("notes", { content: "---\nname: notes\ndescription: take notes\n---\n", harnesses: ["codex"] });
    expect(reg.list().map((s) => [s.name, s.description, s.enabled])).toEqual([["deploy", "Deploy", true], ["notes", "take notes", true]]);
    expect(reg.content("deploy")).toContain("run the thing");
    reg.write("deploy", { enabled: false });
    expect(reg.get("deploy")?.enabled).toBe(false);
    expect(reg.content("deploy")).toContain("run the thing");
    expect(reg.enabledFor("codex").map((s) => s.name)).toEqual(["notes"]);
    expect(reg.enabledFor("claude-code")).toEqual([]);
    const dest = join(home, "out");
    expect(reg.materialize("codex", dest)).toEqual(["notes"]);
    expect(existsSync(join(dest, "notes", "SKILL.md"))).toBe(true);
    expect(reg.materialize("opencode", join(home, "out2"))).toEqual([]);
    expect(existsSync(join(home, "out2"))).toBe(false);
    expect(reg.remove("notes")).toBe(true);
    expect(reg.remove("notes")).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "skills.json"), "utf8"))).toEqual({ deploy: { enabled: false, harnesses: ["claude-code", "codex", "opencode"] } });
  });
  it("discovers user skill folders and imports by copy", () => {
    const home = tmp();
    const src = join(home, "user-skills");
    mkdirSync(join(src, "pdf", "scripts"), { recursive: true });
    writeFileSync(join(src, "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Read PDFs\n---\n");
    writeFileSync(join(src, "pdf", "scripts", "x.py"), "print(1)");
    mkdirSync(join(src, "not-a-skill"));
    const reg = new SkillRegistry(join(home, "skills"));
    const found = reg.discover([{ source: "test", dir: src }, { source: "missing", dir: join(home, "nope") }]);
    expect(found).toEqual([{ name: "pdf", description: "Read PDFs", path: join(src, "pdf"), source: "test", installed: false }]);
    const s = reg.importFrom(join(src, "pdf"));
    expect(s).toMatchObject({ name: "pdf", files: 1, enabled: true });
    expect(reg.discover([{ source: "test", dir: src }])[0]!.installed).toBe(true);
    expect(() => reg.importFrom(join(src, "not-a-skill"))).toThrow(/not a skill directory/);
    expect(() => reg.importFrom(join(home, "skills", "pdf"))).toThrow(/already/);
  });
  it("extensionsAt wires both registries", () => {
    const home = tmp();
    const ext = extensionsAt(home);
    ext.mcp.upsert(stdio);
    ext.skills.write("s", { content: "# S" });
    expect(ext.mcpFor("codex").map((s) => s.name)).toEqual(["github"]);
    expect(ext.skillsInto("codex", join(home, "x"))).toEqual(["s"]);
  });
});
