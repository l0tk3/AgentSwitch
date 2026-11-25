/** Taking a member back to before a room's message (rooms/rewind.ts, api/roomRewind.ts; user #288, #290, #293). */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SeatRewind } from "../src/api/roomRewind.js";
import { appendPiBranch, codexCutBeforeHanded, codexCutBeforeSent, cutBeforeHanded, cutBeforeRefused, cutBeforeSent, cutRecord, filesBack, piCutBeforeHanded, piCutBeforeSent, putFilesBack, readRecord, refusedLast, writeCodexCut } from "../src/rooms/rewind.js";
import { RoomStore } from "../src/rooms/store.js";
import type { TerminalHost, TerminalInfo } from "../src/terminals/host.js";

const S = "old-session";
const at = (m: number) => new Date(2026, 10, 25, 10, m).toISOString();

function record(file: string): string[] {
  const env = (n: number) => `[Room login · #${n}]\nFrom: @you (the user)\nTo: @api (you)\n10:0${n}\n\nhello ${n}`;
  return [
    { type: "user", uuid: "u1", sessionId: S, timestamp: at(0), message: { role: "user", content: "start" } },
    { type: "assistant", uuid: "a1", sessionId: S, timestamp: at(1), message: { id: "m0", role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "queue-operation", operation: "enqueue", sessionId: S, timestamp: at(2), content: `<task-notification>\n${env(2)}` },
    { type: "user", uuid: "u2", sessionId: S, timestamp: at(2), message: { role: "user", content: `<task-notification>\n${env(2)}` } },
    { type: "assistant", uuid: "a2", sessionId: S, timestamp: at(3), message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__chatroom__room_post", input: { text: "hi" } }] } },
    { type: "user", uuid: "u3", sessionId: S, timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "#3 sent in \"login\"." }] }] } },
    { type: "user", uuid: "u4", sessionId: S, timestamp: at(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "edited" }] }, toolUseResult: { filePath: file, oldString: "a", newString: "b", originalFile: "a\n", replaceAll: false } },
    { type: "attachment", uuid: "x1", sessionId: S, timestamp: at(5), attachment: { type: "hook_additional_context", content: [env(4)] } },
    { type: "assistant", uuid: "a3", sessionId: S, timestamp: at(6), isApiErrorMessage: true, message: { id: "m2", role: "assistant", stop_reason: "refusal", content: [{ type: "text", text: "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy" }] } },
    { type: "last-prompt", lastPrompt: "x", leafUuid: "a3", sessionId: S },
  ].map((l) => JSON.stringify(l));
}

describe("cutting a record", () => {
  const dir = mkdtempSync(join(tmpdir(), "as-rewind-"));
  const file = join(dir, "f.txt");
  const lines = record(file);

  it("before it was handed a message: from the queue it waited in; what goes is given again", () => {
    const cut = cutBeforeHanded(lines, "login", 2)!;
    expect(cut.line).toBe(2);
    expect(cut.handed).toEqual([2, 4]);
    expect(cut.first).toEqual([2]);
    expect(cut.at).toBe(Date.parse(at(2)));
    expect(cutBeforeHanded(lines, "login", 9)).toBeNull();
    expect(cutBeforeHanded(lines, "other", 2)).toBeNull();
  });

  it("before it sent a message: from the reply that made the call", () => {
    expect(cutBeforeSent(lines, "login", 3)!.line).toBe(4);
    expect(cutBeforeSent(lines, "login", 5)).toBeNull();
  });

  it("a refused reply goes back to before the message it answered", () => {
    const r = refusedLast(lines)!;
    expect(r.uuid).toBe("a3");
    const cut = cutBeforeRefused(lines, "login", r.line)!;
    expect(cut.line).toBe(7);
    expect(cut.first).toEqual([4]);
    expect(refusedLast(lines.slice(0, 8))).toBeNull();
  });

  it("a refusal after a prompt the user typed is not the room's", () => {
    const typed = [...lines.slice(0, 8), JSON.stringify({ type: "user", uuid: "u9", message: { role: "user", content: "do this" } }), lines[8]!];
    expect(cutBeforeRefused(typed, "login", 9)).toBeNull();
  });

  it("the cut record is a new session, without what named the newest prompt", () => {
    const kept = cutRecord([...lines.slice(0, 2), lines[9]!, lines[2]!], 4, "new").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(kept.map((l) => l.type)).toEqual(["user", "assistant"]);
    expect(kept.every((l) => l.sessionId === "new")).toBe(true);
  });

  it("files: its own edits after the cut are put back, one changed since only when asked", () => {
    writeFileSync(file, "b\n");
    expect(filesBack(lines, 2)).toEqual([{ path: file, action: "restore", changed: false }]);
    expect(filesBack(lines, 7)).toEqual([]);
    writeFileSync(file, "c\n");
    expect(filesBack(lines, 2)[0]!.changed).toBe(true);
    expect(putFilesBack(lines, 2)).toEqual([]);
    expect(putFilesBack(lines, 2, true)).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("a\n");
  });
});

describe("a member taken back", () => {
  function made() {
    const home = mkdtempSync(join(tmpdir(), "as-rewind-room-"));
    let now = new Date(2026, 10, 25, 10, 0).getTime();
    const store = new RoomStore(home, () => now);
    const room = store.create({ name: "login" });
    const was = { agent: "claude-code", name: "api", cwd: "/w", model: null, profile: null };
    const api = store.seat(room.id, { terminal: "t1", was }).handle;
    const ui = store.seat(room.id, { terminal: "t2", was: { ...was, name: "ui" } }).handle;
    store.note(room.id, api, { id: S, cwd: "/w" });
    const dir = mkdtempSync(join(tmpdir(), "as-rewind-rec-"));
    const path = join(dir, `${S}.jsonl`);
    // The room's messages as the record has them: #2 to it, #3 its own, #4 to it.
    // Each dealt with by the one it was for, as at the end of its turn.
    const post = (text: string, from: string, to: string[]) => { now += 60_000; const seq = store.post(room.id, { from, text, to }).seq; for (const h of to) store.setReceipt(room.id, seq, h, null); return seq; };
    const s1 = post("first", "you", [api]); const s2 = post("hello 2", "you", [api]); const s3 = post("hi", api, []); const s4 = post("hello 4", "you", [api]);
    expect([s1, s2, s3, s4]).toEqual([1, 2, 3, 4]);
    writeFileSync(path, `${record(join(dir, "f.txt")).join("\n")}\n`);
    const infos = new Map<string, TerminalInfo>([["t1", { id: "t1", harness: "claude-code", status: "idle", agentSessionId: S, cwd: "/w" } as unknown as TerminalInfo]]);
    const host = { get: (id: string) => infos.get(id) ?? null, recordFileOf: (id: string) => (id === "t1" ? path : null) } as unknown as TerminalHost;
    const calls: string[] = [];
    const callLocal = async (method: string, p: string, body?: unknown) => {
      calls.push(`${method} ${p}${body ? ` ${(body as { agentSessionId?: string }).agentSessionId ?? ""}` : ""}`);
      if (method === "POST" && p === "/terminals/resume") return { status: 201, body: { terminal: { id: "t9" } } };
      if (method === "GET") return { status: 200, body: { terminals: [] } };
      return { status: 200, body: { ok: true } };
    };
    const noted: string[] = [];
    const rewind = new SeatRewind({ rooms: store, host: () => host, callLocal, locate: () => null, noteProfile: (s) => noted.push(s), sessionOf: (i) => ({ id: i.agentSessionId!, cwd: i.cwd }), wasOf: () => was });
    return { store, room, api, ui, rewind, calls, path, noted, host };
  }

  it("recalling its message: it goes back to before it sent it, in a new session; its seat sits in the new terminal", async () => {
    const { store, room, api, rewind, calls, noted } = made();
    const done = await rewind.recall(room.id, 3);
    expect(done.rewound).toEqual([{ handle: api, ok: true, terminal: "t9", again: [4] }]);
    const seat = store.get(room.id).seats.find((s) => s.handle === api)!;
    expect(seat.terminal).toBe("t9");
    expect(seat.session!.id).not.toBe(S);
    expect(noted).toEqual([seat.session!.id]);
    expect(calls).toContain("DELETE /terminals/t1");
    expect(calls).toContain(`POST /terminals/resume ${seat.session!.id}`);
    // What it was handed after it is on its way again; the new record ends before the call.
    expect(store.get(room.id).receipts[4]?.[api]).toBe("sent");
    const kept = readRecord(join(rewind["d"].host()!.recordFileOf("t1")!, "..", `${seat.session!.id}.jsonl`));
    expect(kept).toHaveLength(4);
    expect(seat.rewound).toMatchObject({ why: "recall", seq: 3, line: 4, marked: false });
    expect(store.messages(room.id).find((m) => m.seq === 3)!.deleted).toBeTruthy();
  });

  it("recalling a message it was handed: back to before it; what it said since is 「已退回」", async () => {
    const { store, room, api, rewind } = made();
    const done = await rewind.recall(room.id, 2);
    expect(done.rewound).toEqual([{ handle: api, ok: true, terminal: "t9", again: [4] }]);
    expect(store.messages(room.id).find((m) => m.seq === 3)!.rewound).toBeTruthy();
    expect(store.messages(room.id).find((m) => m.seq === 1)!.rewound).toBeUndefined();
  });

  it("a member whose record does not have it is told to leave it aside", async () => {
    const { store, room, ui, rewind } = made();
    const seq = store.post(room.id, { from: "you", text: "to ui", to: [ui] }).seq;
    store.setReceipt(room.id, seq, ui, "delivered");
    const done = await rewind.recall(room.id, seq);
    expect(done.rewound).toEqual([{ handle: ui, ok: false, error: expect.any(String) }]);
    expect(done.told).toBeGreaterThan(seq);
  });

  it("a refused reply: back to before the message it answered, which it is not given again; its face is marked", async () => {
    const { store, room, api, rewind } = made();
    store.setReceipt(room.id, 4, api, null);
    expect(rewind.refused("t1")).toBe(true);
    expect(rewind.refused("t1")).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    const seat = store.get(room.id).seats.find((s) => s.handle === api)!;
    expect(seat.terminal).toBe("t9");
    expect(seat.rewound).toMatchObject({ why: "safeguard", seq: 4, marked: true });
    expect(store.get(room.id).receipts[4]?.[api]).toBeUndefined();
    expect(store.messages(room.id).at(-1)!.text).toContain("safeguard");
    store.rewindSeen(room.id, api);
    expect(store.get(room.id).seats.find((s) => s.handle === api)!.rewound!.marked).toBe(false);
    expect(existsSync(seat.rewound!.record)).toBe(true);
  });
});

describe("the other agents (user #296)", () => {
  const ID = "01a2093d-6b8d-7c92-9b53-9e1acf5f1e9d";
  const env = (n: number) => `[Room login · #${n}]\nFrom: @you (the user)\nhello ${n}`;
  const codexLines = () => [
    { type: "session_meta", payload: { id: ID, session_id: ID, cwd: "/w" } },
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "start" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
    { type: "world_state", payload: {} },
    { type: "turn_context", payload: { turn_id: "t2" } },
    { timestamp: at(2), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: env(2) }] } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: ID, item: { type: "UserMessage", content: [{ type: "text", text: env(2) }] } } },
    { type: "response_item", payload: { type: "reasoning", summary: [] } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: "post" } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: ID, item: { type: "McpToolCall", tool: "room_post", result: { content: [{ type: "text", text: "#3 sent in \"login\"." }] } } } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: "done" } },
  ].map((l) => JSON.stringify(l));

  it("Codex: before it was handed a message, from the turn's start; before it sent one, from the call", () => {
    const lines = codexLines();
    const h = codexCutBeforeHanded(lines, "login", 2)!;
    expect(h).toMatchObject({ line: 4, handed: [2], first: [2], at: Date.parse(at(2)) });
    expect(codexCutBeforeSent(lines, "login", 3)!.line).toBe(8);
    expect(codexCutBeforeSent(lines, "login", 4)).toBeNull();
  });

  it("Codex: the cut is a new thread, named so in its file and its lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "as-rewind-codex-"));
    const path = join(dir, "sessions", "2026", "11", "24", `rollout-2026-11-24T00-29-09-${ID}.jsonl`);
    const made = writeCodexCut(path, codexLines(), 4, new Date(2026, 10, 25, 10, 1, 2));
    expect(made.path).toBe(join(dir, "sessions", "2026", "11", "25", `rollout-2026-11-25T10-01-02-${made.id}.jsonl`));
    const kept = readRecord(made.path);
    expect(kept).toHaveLength(4);
    expect(kept.join("\n")).not.toContain(ID);
    expect(JSON.parse(kept[0]!).payload.id).toBe(made.id);
  });

  const piLines = () => [
    { type: "session", id: "pi-1", cwd: "/w" },
    { type: "message", id: "a", parentId: null, message: { role: "user", content: [{ type: "text", text: "start" }] } },
    { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    // An abandoned branch: not on the path.
    { type: "custom_message", id: "x", parentId: "b", customType: "agentswitch-room", content: env(9) },
    { type: "custom_message", id: "c", parentId: "b", customType: "agentswitch-room", content: env(2), timestamp: at(2) },
    { type: "message", id: "d", parentId: "c", message: { role: "assistant", content: [{ type: "toolCall", id: "call1", name: "room_post" }] } },
    { type: "message", id: "e", parentId: "d", message: { role: "toolResult", toolCallId: "call1", content: [{ type: "text", text: "#3 sent in \"login\"." }] } },
    { type: "custom_message", id: "f", parentId: "e", customType: "agentswitch-room", content: env(4) },
  ].map((l) => JSON.stringify(l));

  it("pi: along its branch only; taken back with an entry whose parent is the one before", () => {
    const lines = piLines();
    expect(piCutBeforeHanded(lines, "login", 9)).toBeNull();
    const h = piCutBeforeHanded(lines, "login", 2)!;
    expect(h).toMatchObject({ handed: [2, 4], first: [2], parent: "b", leaf: "f" });
    expect(piCutBeforeSent(lines, "login", 3)).toMatchObject({ parent: "c", handed: [4] });
    const dir = mkdtempSync(join(tmpdir(), "as-rewind-pi-"));
    const path = join(dir, "t_pi-1.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`);
    appendPiBranch(path, h);
    const last = JSON.parse(readRecord(path).at(-1)!);
    expect(last).toMatchObject({ type: "branch_summary", parentId: "b", fromId: "f", summary: "" });
    // From there, its branch ends at "b".
    expect(piCutBeforeHanded(readRecord(path), "login", 2)).toBeNull();
  });

  it("OpenCode: its own server reverts the session in place; the seat stays where it is", async () => {
    const home = mkdtempSync(join(tmpdir(), "as-rewind-oc-"));
    const store = new RoomStore(home);
    const room = store.create({ name: "login" });
    const was = { agent: "opencode", name: "oc", cwd: "/w", model: null, profile: null };
    const oc = store.seat(room.id, { terminal: "t1", was }).handle;
    for (const n of [1, 2]) { const seq = store.post(room.id, { from: "you", text: `m${n}`, to: [oc] }).seq; store.setReceipt(room.id, seq, oc, null); }
    const messages = [
      { id: "m1", type: "user", text: "start", time: { created: 1 } },
      { id: "m2", type: "user", text: env(1), time: { created: 2 } },
      { id: "m3", type: "assistant", time: { created: 3 } },
      { id: "m4", type: "user", text: env(2), time: { created: 4 } },
    ];
    let picked = -1;
    const host = { get: () => ({ id: "t1", harness: "opencode", status: "idle" }), recordFileOf: () => null,
      revertTo: async (_t: string, pick: (m: readonly Record<string, unknown>[]) => number) => { picked = pick(messages); return picked < 0 ? null : { removed: messages.slice(picked) }; } } as unknown as TerminalHost;
    const rewind = new SeatRewind({ rooms: store, host: () => host, locate: () => null, noteProfile: () => {}, sessionOf: () => null, wasOf: () => was });
    const done = await rewind.recall(room.id, 1);
    expect(picked).toBe(1);
    expect(done.rewound).toEqual([{ handle: oc, ok: true, terminal: "t1", again: [2] }]);
    expect(store.get(room.id).receipts[2]?.[oc]).toBe("sent");
    expect(store.get(room.id).seats.find((s) => s.handle === oc)!.terminal).toBe("t1");
    expect(() => rewind.filesOf(room.id, oc)).toThrow(/Claude Code/);
  });
});
