import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, decideTool } from "../src/core/toolGuard.js";

describe("the tool guard (core/toolGuard.ts)", () => {
  it("tool policy: read-only and gate tools pass, edits anywhere but a protected folder pass (2026-09-25), the rest asks", () => {
    expect(decideTool("Read", { file_path: "/etc/passwd" }, "/w")).toEqual({ kind: "allow" });
    expect(decideTool("mcp__secret-gate__secret_fill", {}, "/w")).toEqual({ kind: "allow" });
    expect(decideTool("Edit", { file_path: "src/a.ts" }, "/w")).toEqual({ kind: "allow" });
    expect(decideTool("Write", { file_path: "/etc/hosts" }, "/w")).toEqual({ kind: "allow" });
    expect(decideTool("Write", {}, "/w")).toMatchObject({ kind: "ask" });
    expect(decideTool("Bash", { command: "rm -rf /", description: "clean" }, "/w")).toEqual({ kind: "ask", action: "Bash: rm -rf /", evidence: "clean" });
    expect(decideTool("WebFetch", { url: "http://x" }, "/w")).toMatchObject({ kind: "ask", action: "WebFetch" });
  });
  it("edits inside cwd stay allowed across symlinked path spellings (macOS /var vs /private/var)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-canon-"));   // /var/folders/... on macOS
    const cwd = canonical(dir);
    expect(canonical(join(dir, "new", "file.txt"))).toBe(join(cwd, "new", "file.txt"));
    expect(decideTool("Write", { file_path: join(dir, "hello.txt") }, cwd)).toEqual({ kind: "allow" });
    expect(decideTool("Write", { file_path: join(cwd, "sub", "x.txt") }, cwd)).toEqual({ kind: "allow" });
    expect(canonical("/definitely/not/here/x")).toBe("/definitely/not/here/x");
    expect(decideTool("Write", { file_path: join(dir, "..", "escape.txt") }, cwd)).toEqual({ kind: "allow" });   // other folders are open too
  });
});
