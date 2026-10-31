/** What is typed into `agentswitch config`, read as the Mac's sheets read it (tui/text.ts). */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanSessionKey, maskProxyPassword, portsFrom, proxySite, splitProxy, validSessionKey } from "../src/tui/text.js";
import { vendorOf } from "../src/profiles/vendors.js";

describe("what is typed", () => {
  it("takes a proxy apart as the Mac does: whole URLs, no scheme, host:port alone, the sellers' host:port:user:pass", () => {
    expect(splitProxy("http://me:p%40ss@proxy.example:8080/")).toEqual({ server: "http://proxy.example:8080", username: "me", password: "p@ss" });
    expect(splitProxy("socks5://u@[2001:db8::1]:1080")).toEqual({ server: "socks5://[2001:db8::1]:1080", username: "u", password: "" });
    expect(splitProxy("me:pw@10.0.0.2:3128")).toEqual({ server: "http://10.0.0.2:3128", username: "me", password: "pw" });
    expect(splitProxy("proxy.example:8080")).toEqual({ server: "http://proxy.example:8080", username: "", password: "" });
    expect(splitProxy("gate.example:7000:buyer:secret:with:colons")).toEqual({ server: "http://gate.example:7000", username: "buyer", password: "secret:with:colons" });
    expect(splitProxy("ftp://x:1")).toEqual({ server: "ftp://x:1", username: "", password: "" });
    expect(splitProxy("not a proxy")).toEqual({ server: "not a proxy", username: "", password: "" });
  });

  it("hides a proxy's password on the screen as it is typed, one dot a character, the rest of the line as typed", () => {
    expect(maskProxyPassword("http://me:p%40ss@proxy.example:8080/")).toBe("http://me:••••••@proxy.example:8080/");    // the escape hidden as typed, not as read
    expect(maskProxyPassword("me:pw@10.0.0.2:3128")).toBe("me:••@10.0.0.2:3128");
    expect(maskProxyPassword("gate.example:7000:buyer:secret:with:colons")).toBe("gate.example:7000:buyer:••••••••••••••••••");
    expect(maskProxyPassword("[::1]:7000:buyer:pw ")).toBe("[::1]:7000:buyer:•• ");
    // Typed by hand: hidden from the first character after the name's colon, unless it reads as a port.
    expect(maskProxyPassword("http://me:p4")).toBe("http://me:••");
    expect(maskProxyPassword("http://me:")).toBe("http://me:");
    expect(maskProxyPassword("http://proxy.example:8080")).toBe("http://proxy.example:8080");
    expect(maskProxyPassword("gate.example:7000:buyer")).toBe("gate.example:7000:buyer");
    // Nothing to hide: no password, an IPv6 host's own colons, a line that is not a proxy, the kept line shown to edit.
    expect(maskProxyPassword("socks5://u@[2001:db8::1]:1080")).toBe("socks5://u@[2001:db8::1]:1080");
    expect(maskProxyPassword("http://[2001:db8::1]:1080")).toBe("http://[2001:db8::1]:1080");
    expect(maskProxyPassword("http://me@proxy.example:8080")).toBe("http://me@proxy.example:8080");
    expect(maskProxyPassword("not a proxy")).toBe("not a proxy");
    expect(maskProxyPassword("")).toBe("");
    for (const line of ["http://me:p%40ss@proxy.example:8080/", "gate.example:7000:buyer:secret", "http://me:p4"]) expect(maskProxyPassword(line)).toHaveLength(line.length);
  });

  it("seals a proxy's password for its host and port; one not written scheme://host:port has no site", () => {
    expect(proxySite("http://proxy.example:8080")).toBe("proxy.example:8080");
    expect(proxySite("socks5://[2001:db8::1]:1080")).toBe("[2001:db8::1]:1080");
    expect(proxySite("http://proxy.example")).toBeNull();
    expect(proxySite("http://proxy.example:70000")).toBeNull();
  });

  it("takes a session key out of a pasted cookie", () => {
    const key = `sk-ant-sid01-${"a".repeat(30)}`;
    expect(cleanSessionKey(` sessionKey=${key}; Path=/`)).toBe(key);
    expect(validSessionKey(`"${key}"`)).toBe(true);
    expect(validSessionKey("sk-ant-api03-nope")).toBe(false);
  });

  it("holds ports to node.json's rules", () => {
    const ok = { local: "4711", remote: "4713", gate: "8080", opencode: "4712" };
    expect(portsFrom(ok)).toEqual({ local: 4711, remote: 4713, gate: 8080, opencode: 4712 });
    expect(portsFrom({ ...ok, local: "47a" })).toBe("number");
    expect(portsFrom({ ...ok, local: "80" })).toBe("range");
    expect(portsFrom({ ...ok, local: "4712" })).toBe("distinct");
  });

  it("knows a vendor by its address; none named is the agent's own", () => {
    expect(vendorOf("claude-code", undefined)?.name).toBe("Anthropic");
    expect(vendorOf("claude-code", "https://openrouter.ai/api/")?.name).toBe("OpenRouter");
    expect(vendorOf("codex", undefined)?.name).toBe("OpenAI");
    expect(vendorOf("claude-code", "https://relay.example/api")).toBeNull();
    expect(vendorOf("pi", undefined)).toBeNull();
  });
});

describe("the client and an older service", () => {
  it("says the status of a route the service does not have, not a JSON error", async () => {
    const { Client } = await import("../src/client.js");
    const old = new Client("http://test", (async () => new Response("404 Not Found", { status: 404 })) as unknown as typeof fetch);
    await expect(old.profileModels("claude-code", { profile: "k1" })).rejects.toThrow("HTTP 404: 404 Not Found");
    const odd = new Client("http://test", (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch);
    await expect(odd.health()).rejects.toThrow("GET /healthz: not JSON");
  });
});

describe("the editor and the gate's key pairs", () => {
  it("edits text in $VISUAL or $EDITOR (with its own arguments) and leaves no file behind", async () => {
    const { editText, editorOf } = await import("../src/tui/editor.js");
    expect(editorOf({ VISUAL: "nvim", EDITOR: "nano" })).toBe("nvim");
    expect(editorOf({ EDITOR: " " })).toBe("vi");
    // An editor of our own, given a word as its argument, writes that word into the file it is opened on. (GNU sed's
    // `-i` with no suffix is not BSD sed's: the Mac has no one-line editor both know.)
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-editor-"));
    try {
      const editor = join(dir, "fake-editor");
      writeFileSync(editor, `#!/bin/sh\nprintf '%s\\n' "$1" > "$2"\n`);
      chmodSync(editor, 0o755);
      const out = editText("hello\n", "CONTEXT.md", { ...process.env, VISUAL: "", EDITOR: `"${editor}" bye` });
      expect(out).toBe("bye\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(() => editText("x", "a.md", { ...process.env, VISUAL: "false", EDITOR: "" })).toThrow(/false exited 1/);
  });

  it("asks the gate for its key pairs in JSON, and says its refusal in its own words", async () => {
    const { GateKeys } = await import("../src/keeper/gateKeys.js");
    const calls: (readonly string[])[] = [];
    const list = JSON.stringify([{ name: "main", public: "P", current: true }]);
    const keys = new GateKeys(async (args) => {
      calls.push(args);
      if (args.includes("retire") && args.includes("main")) return { code: 1, stdout: "", stderr: "error: 密钥 main 是当前密钥，无法删除。\n" };
      if (args.includes("retire")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: list, stderr: "" };
    });
    expect(await keys.list()).toEqual([{ name: "main", public: "P", current: true }]);
    await keys.create("work", true);
    await keys.use("work");
    await expect(keys.retire("main")).rejects.toThrow("密钥 main 是当前密钥，无法删除。");
    expect(await keys.retire("old")).toHaveLength(1);    // an older gate says nothing on retiring: the list is asked for
    await expect(keys.create("bad name", false)).rejects.toThrow(/letters, digits/);
    expect(calls).toEqual([["keys", "--json"], ["keys", "--json", "new", "work", "--use"], ["keys", "--json", "use", "work"], ["keys", "--json", "retire", "main"], ["keys", "--json", "retire", "old"], ["keys", "--json"]]);
  });
});
