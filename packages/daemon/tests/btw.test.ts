/** A member at work answering a room's question at once through its own `/btw` (docs/chatroom-v0.md §13; user #529,
 *  #538): the panel Claude Code draws, its answer read from it and the panel closed, and the room message that says
 *  that answer while the user's own message keeps its place in the queue. The screens are the ones a real Claude Code
 *  2.1.332 drew on the user's Mac (2026-11-26); the panel is also drawn by the fake agent, in a real pty. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asideOnScreen, TerminalHost, type Launcher } from "../src/terminals/host.js";
import { RoomDelivery } from "../src/rooms/delivery.js";
import type { SeatLive, SeatState } from "../src/rooms/state.js";
import { RoomStore } from "../src/rooms/store.js";

const FAKE = join(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

const fakeLauncher = (): Launcher => (req) => ({
  file: process.execPath,
  args: [FAKE],
  env: { ...(process.env as Record<string, string>), AGENTSWITCH_TERMINAL_ID: req.id },
  hooks: true,
});

async function until<T>(get: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("the /btw panel on a Claude Code's screen", () => {
  /** The answer a side question got when one was asked of a Claude Code at work: the panel over the bottom of its
   *  screen, the question echoed, the answer under it, the keys named at the end (seen 2026-11-26). */
  const PANEL = [
    "  with similar RTTs, but shorter-RTT flows gain window faster and thus get more bandwidth — a well-known bias.",
    "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
    "  /btw 请问你现在做到哪一步了？请用两三句话简短说明。",
    "",
    "    我是一个被单独派来回答这个旁支问题的轻量代理，看不到主对话里正在进行的任务进度，因此无法告诉你主代理目前具体做到哪",
    "    一步了——它仍在后台独立运行。",
    "",
    "    从我能看到的上下文快照来看（仅供参考，可能已过时）：仓库在 main 分支、工作区干净，最近的提交集中在 mac",
    "    端像素级修正（文件预览信息行、成员行对齐、Chat Room 预览的 New Channel 面板）和 Antigravity",
    "    经网关的流式读取与受保护路径规则。",
    "",
    "    如果需要真实的当前进度，请回到主对话直接问主代理。",
    "",
    "  c to copy · f to fork · Esc to close",
  ];
  const ANSWER = "我是一个被单独派来回答这个旁支问题的轻量代理，看不到主对话里正在进行的任务进度，因此无法告诉你主代理目前具体做到哪一步了——它仍在后台独立运行。\n\n"
    + "从我能看到的上下文快照来看（仅供参考，可能已过时）：仓库在 main 分支、工作区干净，最近的提交集中在 mac端像素级修正（文件预览信息行、成员行对齐、Chat Room 预览的 New Channel 面板）和 Antigravity经网关的流式读取与受保护路径规则。\n\n"
    + "如果需要真实的当前进度，请回到主对话直接问主代理。";

  it("is read whole: the answer's rows joined, a paragraph a line, the keys' line not part of it", () => {
    expect(asideOnScreen(PANEL)).toEqual({ answer: ANSWER, complete: true, working: false });
    // While the answer is still coming there is no line naming the keys: read up to what stands there.
    const streaming = PANEL.slice(0, -2);
    expect(asideOnScreen(streaming)).toEqual({ answer: ANSWER, complete: false, working: false });
    // An English answer's wrapped rows keep their spaces.
    const english = ["▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔", "  /btw where are you?", "", "    I have read the config and", "    am now writing the parser.", "", "  c to copy · f to fork · Esc to close"];
    expect(asideOnScreen(english)).toEqual({ answer: "I have read the config and am now writing the parser.", complete: true, working: false });
    // An answer still coming: its spinner is not part of the answer, and it is not whole without its keys' line.
    const coming = ["▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔", "  /btw where are you?", "", "    I have read the config and", "    ✽ Answering…", "", "  c to copy · f to fork · Esc to close"];
    expect(asideOnScreen(coming)).toEqual({ answer: "I have read the config and", complete: true, working: true });
    expect(asideOnScreen(["▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔", "  /btw where are you?", "", "    ✽ Answering…"])).toEqual({ answer: "", complete: false, working: true });
    // Its spinner turns (`· Answering…` is one frame of it), and its keys' line may be drawn before the answer is.
    const turning = ["▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔", "  /btw where are you?", "", "    · Answering…", "", "  c to copy · f to fork · Esc to close"];
    expect(asideOnScreen(turning)).toEqual({ answer: "", complete: true, working: true });
    // Not a panel: no question under the rule, no answer, or the panel gone.
    expect(asideOnScreen(PANEL.filter((l) => !l.includes("/btw ")))).toBeNull();
    expect(asideOnScreen(["▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔", "  /btw where are you?", "", "  c to copy · f to fork · Esc to close"])).toBeNull();
    expect(asideOnScreen(["  with similar RTTs, but shorter-RTT flows gain window faster."])).toBeNull();
  });

  it("a Claude Code at work is asked with /btw; the answer is read and Esc closes the panel", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(), idleAfterMs: 10_000 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir() });
    await until(() => host.screenTail(info.id, 20).join("\n").includes("fake agent ready"));
    // Its input line, empty, as Claude Code's is while it works (the check before anything is typed).
    host.write(info.id, "suggest Ask anything\r");
    await until(() => host.screenTail(info.id, 20).join("\n").includes("❯"));
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    // At rest it is not asked: /btw is for a turn in progress.
    expect(await host.aside(info.id, "where are you?", { waitMs: 2000 })).toMatchObject({ ok: false });
    expect(host.screenTail(info.id, 20).join("\n")).not.toContain("/btw");
    await host.hook(info.id, token, { event: "UserPromptSubmit", payload: { session_id: "s-1" } });
    expect(host.get(info.id)!.status).toBe("working");
    const said = await host.aside(info.id, "where are you?", { waitMs: 10_000 });
    expect(said).toEqual({ ok: true, answer: "I have read the config and am now writing the parser." });
    // Closed, and the turn goes on: Esc went to the panel, not the turn.
    await until(() => host.screenTail(info.id, 20).join("\n").includes("aside closed"));
    expect(host.get(info.id)!.status).toBe("working");
    expect(host.screenTail(info.id, 20).join("\n")).not.toContain("Esc to close");
  }, 30_000);
});

describe("a room's question answered beside the turn", () => {
  function made(state: SeatState = "busy", agent = "claude-code") {
    const states = new Map<string, SeatState>([["t1", state], ["t2", state]]);
    const seat = (terminal: string): SeatLive | null => (states.has(terminal)
      ? { state: states.get(terminal)!, card: { agent, name: terminal === "t1" ? "api" : "ui", cwd: "/w", model: null, profile: null, mode: "default", node: null } }
      : null);
    const store = new RoomStore(mkdtempSync(join(tmpdir(), "as-aside-")));
    const asked: [string, string][] = [];
    const delivery = new RoomDelivery({ store, seat, home: "/Users/x", aside: async (terminal, question) => (asked.push([terminal, question]), { ok: true, answer: terminal === "t1" ? "读完了接口，正在写登录。" : "还在改样式。" }) });
    const room = store.create({ name: "重构登录模块" });
    for (const t of ["t1", "t2"]) store.seat(room.id, { terminal: t, was: seat(t)!.card });
    const post = (text: string, o: { from?: string; expects?: "none" | "answer" } = {}) => store.post(room.id, { from: o.from ?? "you", text, ...(o.expects ? { expects: o.expects } : {}) });
    return { store, delivery, room, asked, states, post };
  }

  it("asks each member at work through its own /btw and says that answer in the room, marked; the message stays queued", async () => {
    const { store, delivery, room, asked, post } = made();
    const given = post("@api @ui 做到哪了？", { expects: "answer" });
    expect(store.get(room.id).receipts[given.seq]).toEqual({ api: "sent", ui: "sent" });
    await delivery.quickAnswer(room.id, given.seq);
    expect(asked.map(([t]) => t)).toEqual(["t1", "t2"]);
    expect(asked[0]![1]).toContain("做到哪了？");
    expect(asked[0]![1]).toContain("two or three sentences");   // the wrapper says what is wanted of it
    expect(asked[0]![1]).toContain("reaches your main conversation");
    const said = store.messages(room.id).slice(-2);
    expect(said.map((m) => m.from)).toEqual(["api", "ui"]);
    expect(said[0]).toMatchObject({ aside: true, replyTo: given.seq, expects: "none", to: ["you"], text: expect.stringContaining("读完了接口，正在写登录。") });
    expect(said[0]!.text).toContain(`#${given.seq} 已排队`);
    // The user's message is still on its way: the aside did not take its place.
    expect(store.get(room.id).receipts[given.seq]).toEqual({ api: "sent", ui: "sent" });
  });

  it("is not done for a colleague's message, one that expects no answer, an idle member, another agent, or twice at once", async () => {
    const { store, delivery, room, asked, post, states } = made();
    const colleague = post("@api 帮我看看", { from: "ui", expects: "answer" });
    await delivery.quickAnswer(room.id, colleague.seq);
    const quiet = post("@api 先别动", { expects: "none" });
    await delivery.quickAnswer(room.id, quiet.seq);
    expect(asked).toEqual([]);
    // At rest: it gets the message in its own time; nothing is asked beside it.
    states.set("t1", "idle"); states.set("t2", "idle");
    const atRest = post("@api 做到哪了？", { expects: "answer" });
    await delivery.quickAnswer(room.id, atRest.seq);
    expect(asked).toEqual([]);
    // Another agent's /btw is not wired yet: Claude Code only.
    const other = made("busy", "codex");
    const forIt = other.post("@api 做到哪了？", { expects: "answer" });
    await other.delivery.quickAnswer(other.room.id, forIt.seq);
    expect(other.asked).toEqual([]);
    expect(store.messages(room.id).filter((m) => m.aside)).toEqual([]);
  });

  it("says nothing when the aside read nothing, and cuts a long answer to what a message may hold", async () => {
    const states = new Map<string, SeatState>([["t1", "busy"]]);
    const seat = (terminal: string): SeatLive | null => (states.has(terminal) ? { state: "busy", card: { agent: "claude-code", name: "api", cwd: "/w", model: null, profile: null, mode: "default", node: null } } : null);
    const store = new RoomStore(mkdtempSync(join(tmpdir(), "as-aside2-")));
    let answer = "";
    const delivery = new RoomDelivery({ store, seat, aside: async () => ({ ok: true, answer }) });
    const room = store.create({ name: "r" });
    store.seat(room.id, { terminal: "t1", was: seat("t1")!.card });
    const given = store.post(room.id, { from: "you", text: "@api 做到哪了？", expects: "answer" });
    await delivery.quickAnswer(room.id, given.seq);
    expect(store.messages(room.id).filter((m) => m.aside)).toEqual([]);
    answer = "长".repeat(900);
    await delivery.quickAnswer(room.id, given.seq);
    const said = store.messages(room.id).filter((m) => m.aside);
    expect(said).toHaveLength(1);
    expect([...said[0]!.text].length).toBeLessThanOrEqual(800);
    expect(said[0]!.text.endsWith(`原消息 #${given.seq} 已排队：这一轮结束后主线会看到。`)).toBe(true);
  });
});
