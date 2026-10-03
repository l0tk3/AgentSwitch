/** The shared browser's rules (docs/browser-v0.md §2 安全): which files a person may open (credential names and folders,
 *  AgentSwitch's own data, `..` and symlinks followed to the real path), which URLs a person's and an agent's tab may go
 *  to, AgentSwitch's own ports, and how what is typed in the address bar becomes a URL. */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DAEMON_CONFIG_DIR, defaultProtected } from "../src/executors/protected.js";
import { AGENT_FILE_REFUSAL, AGENTSWITCH_DIRS, auditUrl, checkLocalFile, checkUrl, CREDENTIAL_DIRS, CREDENTIAL_NAMES, isLoopbackAddress, isLoopbackHost, OWN_PORT_REFUSAL, placeOf, targetUrl, tilde, type FileRules } from "../src/browser/rules.js";
import { BrowserError, YOU, type TabOwner } from "../src/browser/types.js";

const AGENT: TabOwner = { kind: "terminal", id: "t1", label: "codex · AgentSwitch" };
let home: string;
let rules: FileRules;
let site: string;
let asHome: string;
let gateHome: string;

function refusal(fn: () => unknown): BrowserError {
  try { fn(); } catch (err) { if (err instanceof BrowserError) return err; throw err; }
  throw new Error("not refused");
}

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-browser-rules-")));
  asHome = join(home, "Library", "Application Support", "AgentSwitch");
  gateHome = join(home, ".secret-gate");
  site = join(home, "Projects", "site");
  for (const d of [site, asHome, join(asHome, "artifacts"), join(asHome, "browser-profiles", "main"), gateHome, join(gateHome, "keys"), join(home, ".ssh"), join(home, ".config", "gh"), join(home, ".config", "other"),
    join(home, "Library", "Keychains"), join(site, "AgentSwitch"), join(home, "Backups", "old", "Application Support", "AgentSwitch"), join(home, "Backups", ".agentswitch"), join(home, "Backups", ".secret-gate")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "token: x");
  writeFileSync(join(home, "Library", "Keychains", "login.keychain-db"), "");
  writeFileSync(join(gateHome, "keys", "default.priv"), "k");
  writeFileSync(join(site, "AgentSwitch", "index.html"), "<p>a repo named AgentSwitch</p>");
  writeFileSync(join(home, "Backups", "old", "Application Support", "AgentSwitch", "local-token"), "t");
  writeFileSync(join(home, "Backups", ".agentswitch", "notes.html"), "x");
  writeFileSync(join(home, "Backups", ".secret-gate", "keys.json"), "{}");
  writeFileSync(join(site, "index.html"), "<p>hi</p>");
  writeFileSync(join(site, "id_rsa.pub"), "ssh-ed25519 AAAA");
  writeFileSync(join(home, ".ssh", "config"), "Host x");
  writeFileSync(join(home, ".config", "other", "a.html"), "x");
  writeFileSync(join(asHome, "agentswitch.db"), "");
  writeFileSync(join(asHome, "local-token"), "t");
  writeFileSync(join(asHome, "artifacts", "report.html"), "<p>report</p>");
  writeFileSync(join(asHome, "browser-profiles", "main", "Cookies"), "");
  writeFileSync(join(gateHome, "keys.json"), "{}");
  symlinkSync(join(home, ".ssh", "config"), join(site, "innocent.html"));
  symlinkSync(asHome, join(site, "data"));
  rules = { protected: defaultProtected({ HOME: home, AGENTSWITCH_HOME: asHome, SECRET_GATE_HOME: gateHome, SECRET_GATE_PUBLIC: join(home, "gate-public") }), home, ownFolders: [asHome, gateHome] };
});

describe("files a person may open", () => {
  it("allows an ordinary file and folder, and the public half of a key", () => {
    expect(checkLocalFile(join(site, "index.html"), rules)).toBe(join(site, "index.html"));
    expect(checkLocalFile(site, rules)).toBe(site);
    expect(checkLocalFile(join(site, "id_rsa.pub"), rules)).toBe(join(site, "id_rsa.pub"));
    expect(checkLocalFile(join(home, ".config", "other", "a.html"), rules)).toContain("other");
  });

  it("refuses credential file names wherever they are, before looking whether they exist", () => {
    for (const name of [".env", ".env.local", ".ENV", "server.pem", "tls.key", "cert.p12", "cert.pfx", "id_rsa", "id_ed25519", "id_ecdsa_sk",
      ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", "credentials", "credentials.json"]) {
      const err = refusal(() => checkLocalFile(join(site, name), rules));
      expect(err.code, name).toBe("forbidden");
      expect(err.message).toContain("属于凭据文件");
      expect(err.message).toContain("~/Projects/site/");
    }
    expect(CREDENTIAL_NAMES.some((re) => re.test("notes.md"))).toBe(false);
  });

  it("refuses the credential folders: dot-folders anywhere, the others under home, whatever the case", () => {
    for (const p of [join(home, ".ssh", "config"), join(home, ".ssh"), join(home, ".aws", "credentials-x"), join(home, ".gnupg", "pubring.kbx"), join(home, ".config", "gh", "hosts.yml"),
      join(home, "Library", "Keychains", "login.keychain-db"), join(home, ".SSH", "config"), "/Volumes/backup/.ssh/known_hosts", join(home, ".kube", "config")]) {
      const err = refusal(() => checkLocalFile(p, rules));
      expect(err.code, p).toBe("forbidden");
      expect(err.message, p).toMatch(/位于凭据目录中|属于凭据文件/);
    }
    expect(CREDENTIAL_DIRS).toEqual(expect.arrayContaining([".ssh", ".aws", ".gnupg", ".config/gh", "Library/Keychains"]));
  });

  it("refuses AgentSwitch's own data, the gate and the daemon's config, but not the exempt work folders", () => {
    for (const p of [join(asHome, "agentswitch.db"), join(asHome, "local-token"), join(asHome, "browser-profiles", "main", "Cookies"), join(gateHome, "keys.json"), join(DAEMON_CONFIG_DIR, "targets.yaml")]) {
      const err = refusal(() => checkLocalFile(p, rules));
      expect(err.code, p).toBe("forbidden");
      expect(err.message).toContain("AgentSwitch 自己的数据");
    }
    expect(checkLocalFile(join(asHome, "artifacts", "report.html"), rules)).toContain("report.html");
  });

  it("follows `..` and symlinks to the real path", () => {
    expect(refusal(() => checkLocalFile(join(site, "..", "..", ".ssh", "config"), rules)).code).toBe("forbidden");
    const viaLink = refusal(() => checkLocalFile(join(site, "innocent.html"), rules));
    expect(viaLink.code).toBe("forbidden");
    expect(viaLink.message).toContain("实际位置 ~/.ssh/config");
    expect(refusal(() => checkLocalFile(join(site, "data", "agentswitch.db"), rules)).message).toContain("AgentSwitch 自己的数据");
  });

  // 2026-10-02 review: `realpath` keeps the data volume's spelling, so `/System/Volumes/Data<home>/…` was opened.
  it("the data volume's spelling and any letter case lead to the same refusals (real files on this Mac)", () => {
    const data = (p: string) => `/System/Volumes/Data${p}`;
    expect(existsSync(data(join(asHome, "local-token")))).toBe(true);
    for (const p of [data(join(asHome, "local-token")), data(join(asHome, "browser-profiles", "main", "Cookies")), data(join(gateHome, "keys.json")),
      join(asHome, "local-token").toUpperCase(), data(join(asHome, "LOCAL-TOKEN"))]) {
      const err = refusal(() => checkLocalFile(p, rules));
      expect(err.code, p).toBe("forbidden");
      expect(err.message, p).toContain("AgentSwitch 自己的数据");
    }
    for (const p of [data(join(home, ".config", "gh", "hosts.yml")), data(join(home, "Library", "Keychains", "login.keychain-db")), join(home, "LIBRARY", "keychains", "login.keychain-db"), data(join(home, ".ssh", "config"))]) {
      const err = refusal(() => checkLocalFile(p, rules));
      expect(err.code, p).toBe("forbidden");
      expect(err.message, p).toMatch(/位于凭据目录中|属于凭据文件/);
    }
    // A symlink into the data volume's spelling: refused as asked already (the folder it leads to is the real one).
    symlinkSync(data(join(home, ".config", "gh")), join(site, "gh-link"));
    expect(refusal(() => checkLocalFile(join(site, "gh-link", "hosts.yml"), rules)).message).toContain("位于凭据目录中");
    // What is allowed stays allowed in that spelling.
    expect(checkLocalFile(data(join(site, "index.html")), rules)).toBe(data(join(site, "index.html")));
    expect(checkLocalFile(data(join(asHome, "artifacts", "report.html")), rules)).toContain("report.html");
  });

  it("refuses the gate's keys and copies of AgentSwitch's and the gate's folders anywhere; a repo named AgentSwitch stays open", () => {
    expect(refusal(() => checkLocalFile(join(gateHome, "keys", "default.priv"), rules)).code).toBe("forbidden");
    expect(refusal(() => checkLocalFile(join(site, "copy.priv"), rules)).message).toContain("属于凭据文件");
    for (const p of [join(home, "Backups", "old", "Application Support", "AgentSwitch", "local-token"), join(home, "Backups", ".agentswitch", "notes.html"), join(home, "Backups", ".secret-gate", "keys.json")]) {
      const err = refusal(() => checkLocalFile(p, rules));
      expect(err.code, p).toBe("forbidden");
      expect(err.message, p).toContain("AgentSwitch 自己的数据");
    }
    expect(checkLocalFile(join(site, "AgentSwitch", "index.html"), rules)).toContain("index.html");
    expect(AGENTSWITCH_DIRS).toEqual([".agentswitch", ".secret-gate"]);
  });

  it("says when a file is missing, and wants an absolute path", () => {
    const missing = refusal(() => checkLocalFile(join(site, "nope.html"), rules));
    expect(missing.code).toBe("not_found");
    expect(missing.message).toBe("文件不存在：~/Projects/site/nope.html");
    expect(refusal(() => checkLocalFile("site/index.html", rules)).code).toBe("invalid");
  });
});

describe("URLs a tab may go to", () => {
  const own = [4711, 4713];

  it("a person's tab: http(s), about:blank and allowed files; nothing else", () => {
    expect(checkUrl(YOU, "https://github.com/acme", rules, own)).toBe("https://github.com/acme");
    expect(checkUrl(YOU, "about:blank", rules, own)).toBe("about:blank");
    expect(checkUrl(YOU, pathToFileURL(join(site, "index.html")).href, rules, own)).toContain("file://");
    expect(refusal(() => checkUrl(YOU, pathToFileURL(join(site, ".env")).href, rules, own)).code).toBe("forbidden");
    for (const url of ["javascript:alert(1)", "data:text/html,<p>x", "chrome://settings", "view-source:https://x.com", "blob:https://x.com/1"]) {
      const err = refusal(() => checkUrl(YOU, url, rules, own));
      expect(err.code, url).toBe("forbidden");
      expect(err.message).toBe("仅可打开 http(s) 网址、Mac 上的文件路径和 localhost。");
    }
    expect(refusal(() => checkUrl(YOU, "file://server/share/x.html", rules, own)).code).toBe("invalid");
    expect(refusal(() => checkUrl(YOU, "not a url", rules, own)).code).toBe("invalid");
  });

  it("an agent's tab: never a file", () => {
    expect(checkUrl(AGENT, "https://x.com/", rules, own)).toBe("https://x.com/");
    expect(refusal(() => checkUrl(AGENT, pathToFileURL(join(site, "index.html")).href, rules, own)).message).toBe(AGENT_FILE_REFUSAL);
    expect(refusal(() => checkUrl(AGENT, "data:text/html,x", rules, own)).message).toBe("Agent 的标签仅可打开 http(s) 网址。");
  });

  it("nobody opens AgentSwitch's own ports on this Mac, however it is spelled", () => {
    for (const url of ["http://localhost:4711/", "http://127.0.0.1:4711/ui", "http://[::1]:4711", "https://127.0.0.1:4713", "http://foo.localhost:4711", "http://0.0.0.0:4711", "http://2130706433:4711/",
      "http://localhost.:4711/", "http://LocalHost..:4711/", "http://foo.localhost.:4711", "http://127.0.0.1.:4711/", "http://0x7f.1:4711/"]) {
      expect(refusal(() => checkUrl(YOU, url, rules, own)).message, url).toBe(OWN_PORT_REFUSAL);
      expect(refusal(() => checkUrl(AGENT, url, rules, own)).message, url).toBe(OWN_PORT_REFUSAL);
    }
    expect(checkUrl(YOU, "http://localhost:5173/", rules, own)).toBe("http://localhost:5173/");
    expect(checkUrl(YOU, "http://example.com:4711/", rules, own)).toBe("http://example.com:4711/");
  });

  it("knows the loopback names", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1", "0.0.0.0", "[::]", "[::ffff:7f00:1]"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["example.com", "10.0.0.1", "localhost.example.com", "128.0.0.1", "localhost.evil.example."]) expect(isLoopbackHost(h), h).toBe(false);
    for (const a of ["127.0.0.1", "127.8.9.10", "::1", "0:0:0:0:0:0:0:1", "::", "0.0.0.0", "::ffff:127.0.0.1", "::ffff:7f00:1"]) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ["10.0.0.1", "93.184.216.34", "::2", "fe80::1", "::ffff:10.0.0.1"]) expect(isLoopbackAddress(a), a).toBe(false);
  });
});

describe("what is typed becomes a URL", () => {
  it("ports, paths, local addresses, bare hosts and URLs", () => {
    expect(targetUrl({ port: 5173 }, home)).toBe("http://localhost:5173/");
    expect(targetUrl({ path: "~/Projects/site/index.html" }, home)).toBe(pathToFileURL(join(site, "index.html")).href);
    expect(targetUrl({ path: "/tmp/a b.html" }, home)).toBe("file:///tmp/a%20b.html");
    expect(targetUrl({ url: "localhost:5173" }, home)).toBe("http://localhost:5173/");
    expect(targetUrl({ url: "127.0.0.1:3000/x?y=1" }, home)).toBe("http://127.0.0.1:3000/x?y=1");
    expect(targetUrl({ url: "github.com/acme/app" }, home)).toBe("https://github.com/acme/app");
    expect(targetUrl({ url: " https://x.com " }, home)).toBe("https://x.com/");
    expect(targetUrl({ url: "~/Projects/site/index.html" }, home)).toBe(pathToFileURL(join(site, "index.html")).href);
    expect(targetUrl({ url: "about:blank" }, home)).toBe("about:blank");
    for (const bad of ["hello world", "   ", "relative/path"]) expect(refusal(() => targetUrl({ url: bad }, home)).code, bad).toBe("invalid");
    expect(refusal(() => targetUrl({ path: "relative.html" }, home)).code).toBe("invalid");
  });

  it("the list's second line and the audit's URL", () => {
    expect(placeOf("https://www.github.com/acme", home)).toEqual({ kind: "web", site: "github.com" });
    expect(placeOf("http://localhost:5173/x", home)).toEqual({ kind: "local", site: "localhost:5173" });
    expect(placeOf(pathToFileURL(join(site, "index.html")).href, home)).toEqual({ kind: "file", site: "~/Projects/site/index.html" });
    expect(placeOf("about:blank", home)).toEqual({ kind: "blank", site: "" });
    expect(placeOf("chrome-error://chromewebdata/", home)).toEqual({ kind: "web", site: "chrome-error" });
    expect(auditUrl("https://a.com/x?token=1#f")).toBe("https://a.com/x");
    expect(auditUrl("https://user:pw@a.com/x")).toBe("https://a.com/x");
    expect(auditUrl(pathToFileURL("/tmp/a b.html").href)).toBe("/tmp/a b.html");
    expect(auditUrl("nope")).toBe("invalid");
    expect(tilde("/elsewhere/x", home)).toBe("/elsewhere/x");
  });
});
