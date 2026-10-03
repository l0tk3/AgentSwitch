/** A session whose folder is gone (docs/terminal-v0.md §5, 2026-10-03, user: 如果会话没了选择新目录继续): where it is
 *  listed once it went on elsewhere, and where a gone folder may be now. */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeFacts } from "../src/sessions/claude.js";
import { codexFacts } from "../src/sessions/codex.js";
import { currentFolder, whereNow } from "../src/sessions/moved.js";

const line = (o: unknown) => JSON.stringify(o);
const place = () => realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-moved-")));

describe("a session whose folder is gone", () => {
  it("is listed where it began, unless that is gone and it went on in a folder that is there", () => {
    const root = place();
    const here = join(root, "here");
    mkdirSync(here);
    const gone = join(root, "gone");
    expect(currentFolder(here, join(here, "sub"))).toBe(here);
    expect(currentFolder(gone, here)).toBe(here);
    expect(currentFolder(gone, join(root, "also-gone"))).toBe(gone);
    expect(currentFolder(gone, undefined)).toBe(gone);
  });

  it("offers folders of the same name the Mac knows, and the nearest folder above it that is still there", () => {
    const root = place();
    const moved = join(root, "Projects", "AgentSwitch");
    mkdirSync(moved, { recursive: true });
    mkdirSync(join(root, "Worktop"));
    const gone = join(root, "Worktop", "AgentSwitch");
    expect(whereNow(gone, [moved, join(root, "Other"), gone, moved])).toEqual({ alike: [moved], near: join(root, "Worktop") });
    expect(whereNow(join(root, "a", "b", "c"), [])).toEqual({ alike: [], near: root });
    // Offered once: the nearest folder above may be the one of the same name (MyApp/MyApp).
    const outer = join(root, "MyApp");
    mkdirSync(outer);
    expect(whereNow(join(outer, "MyApp"), [outer])).toEqual({ alike: [outer], near: null });
  });

  it("Claude Code: listed in the folder it was continued in, after its own one is gone", () => {
    const root = place();
    const now = join(root, "now");
    mkdirSync(now);
    const file = join(root, "s1.jsonl");
    const old = join(root, "was-here");
    writeFileSync(file, [
      line({ type: "user", cwd: old, message: { role: "user", content: "整理靶场" }, timestamp: "2026-10-01T08:00:00Z" }),
      line({ type: "relocated", sessionId: "s1", relocatedCwd: now }),
      line({ type: "user", cwd: now, message: { role: "user", content: "继续" }, timestamp: "2026-10-03T08:00:00Z" }),
    ].join("\n") + "\n");
    expect(claudeFacts(file, Date.now())?.cwd).toBe(now);
    // Moved by Claude Code itself: listed where it went, even with its old folder there.
    mkdirSync(old);
    expect(claudeFacts(file, Date.now())?.cwd).toBe(now);
    // Only a later line in another folder (a `cd`), its own folder there: listed where it began.
    const cd = join(root, "s2.jsonl");
    writeFileSync(cd, [
      line({ type: "user", cwd: old, message: { role: "user", content: "看看子目录" }, timestamp: "2026-10-01T08:00:00Z" }),
      line({ type: "assistant", cwd: join(old, "sub"), message: { role: "assistant", content: [{ type: "text", text: "好" }] }, timestamp: "2026-10-01T08:01:00Z" }),
    ].join("\n") + "\n");
    mkdirSync(join(old, "sub"));
    expect(claudeFacts(cd, Date.now())?.cwd).toBe(old);
  });

  it("Codex: listed in the folder its latest turn ran in, after its own one is gone", () => {
    const root = place();
    const now = join(root, "now");
    mkdirSync(now);
    const file = join(root, "rollout-x1.jsonl");
    writeFileSync(file, [
      line({ timestamp: "2026-10-01T08:00:00Z", type: "session_meta", payload: { id: "x1", cwd: join(root, "was-here") } }),
      line({ timestamp: "2026-10-01T08:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "跑测试" }] } }),
      line({ timestamp: "2026-10-03T08:00:00Z", type: "turn_context", payload: { cwd: now, model: "gpt-6" } }),
    ].join("\n") + "\n");
    expect(codexFacts(file, Date.now())?.cwd).toBe(now);
    // Continued elsewhere with its own folder still there: listed where it went on.
    mkdirSync(join(root, "was-here"));
    expect(codexFacts(file, Date.now())?.cwd).toBe(now);
  });
});
