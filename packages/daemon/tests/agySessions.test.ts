import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { agyDelete, agyFacts, agyFolder, agyMessages, agyPrompt, agySaid, agySessions, agyTime, agyTranscript } from "../src/sessions/agy.js";

/** A home as Antigravity CLI 1.5.17 leaves it: the index, a conversation's own file, its transcript. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-agy-"));
  const db = new DatabaseSync(join(dir, "conversation_summaries.db"));
  db.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL, parent_conversation_id text NOT NULL DEFAULT '', killed numeric NOT NULL DEFAULT false)");
  db.close();
  return dir;
}

function conversation(dir: string, id: string, o: { title?: string; cwd: string; at: string; parent?: string; lines?: object[] }): void {
  const db = new DatabaseSync(join(dir, "conversation_summaries.db"));
  db.prepare("INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, parent_conversation_id) VALUES (?, ?, ?, ?, ?)")
    .run(id, o.title ?? "", o.at, JSON.stringify([`file://${o.cwd}`]), o.parent ?? "");
  db.close();
  mkdirSync(join(dir, "conversations"), { recursive: true });
  writeFileSync(join(dir, "conversations", `${id}.db`), "");
  const path = agyTranscript(dir, id);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, (o.lines ?? []).map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const A = "ae24b0dd-490b-46c9-8171-746335de2ae8", B = "be24b0dd-490b-46c9-8171-746335de2ae8", C = "ce24b0dd-490b-46c9-8171-746335de2ae8";

describe("Antigravity CLI conversations", () => {
  it("reads a time, a folder and a prompt as the program writes them", () => {
    expect(agyTime("2026-11-26 03:58:34.533384+00:00")).toBe(Date.parse("2026-11-26T03:58:34.533Z"));
    expect(agyTime("")).toBe(0);
    expect(agyFolder('["file:///Users/x/My%20Work","file:///other"]')).toBe("/Users/x/My Work");
    expect(agyFolder("nonsense")).toBe("");
    expect(agyPrompt("<USER_REQUEST>\n你好\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>")).toBe("你好");
    expect(agySaid({ type: "PLANNER_RESPONSE", content: " hi " })).toBe("hi");
    expect(agySaid({ type: "RUN_COMMAND", content: "ls" })).toBeNull();
  });

  it("lists conversations latest first with title, last reply and model; a sub-agent's and a deleted one are left out", () => {
    const dir = home();
    conversation(dir, A, { title: "Chinese Greeting", cwd: "/w/a", at: "2026-11-26 03:58:34+00:00", lines: [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-11-26T03:58:32Z", content: "<USER_REQUEST>\n你好\n</USER_REQUEST>" },
      { step_index: 1, source: "MODEL", type: "RUN_COMMAND", created_at: "2026-11-26T03:58:33Z", content: "ls -la" },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-11-26T03:58:34Z", model: "gemini-4-hydrogen-high", content: "你好！" }] });
    conversation(dir, B, { cwd: "/w/b", at: "2026-11-26 05:00:00+00:00", lines: [{ step_index: 0, type: "USER_INPUT", created_at: "2026-11-26T05:00:00Z", content: "<USER_REQUEST>fix it</USER_REQUEST>" }] });
    conversation(dir, C, { cwd: "/w/a", at: "2026-11-26 06:00:00+00:00", parent: A });
    const list = agySessions(dir, 10);
    expect(list.map((s) => s.id)).toEqual([B, A]);
    expect(list[0]).toMatchObject({ cwd: "/w/b", title: "fix it", lastText: "" });
    expect(list[1]).toMatchObject({ cwd: "/w/a", title: "Chinese Greeting", lastText: "你好！", model: "gemini-4-hydrogen-high", startedAt: Date.parse("2026-11-26T03:58:32Z") });
    expect(agyFacts(dir, A)).toMatchObject({ title: "Chinese Greeting", cwd: "/w/a" });
    expect(agyMessages(dir, A, 10)).toEqual([
      { role: "user", text: "你好", ts: Date.parse("2026-11-26T03:58:32Z"), at: 0 },
      { role: "tool", tool: "run_command", text: "ls -la", ts: Date.parse("2026-11-26T03:58:33Z"), at: 1 },
      { role: "assistant", text: "你好！", ts: Date.parse("2026-11-26T03:58:34Z"), at: 2 }]);
    // Deleted: its files go, the index keeps its row, the list no longer has it.
    expect(agyDelete(dir, A)).toBe(true);
    expect(existsSync(agyTranscript(dir, A))).toBe(false);
    expect(agySessions(dir, 10).map((s) => s.id)).toEqual([B]);
    expect(agyDelete(dir, A)).toBe(false);
    expect(agyDelete(dir, "../../etc")).toBe(false);
  });

  it("has nothing where the program was never run", () => {
    expect(agySessions(join(tmpdir(), "agentswitch-agy-none"), 10)).toEqual([]);
    expect(agyMessages(join(tmpdir(), "agentswitch-agy-none"), A, 10)).toEqual([]);
  });
});
