import { afterEach, describe, expect, it, vi } from "vitest";
import { WritingFeed, WritingText, type Writing } from "../src/core/writing.js";
import { openCodeWriting } from "../src/harness/opencodeEvents.js";

afterEach(() => { vi.useRealTimers(); });

describe("what an agent is writing", () => {
  it("is sent at most every so often, the latest of it, and its end at once", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const sent: (Writing | null)[] = [];
    const feed = new WritingFeed((w) => sent.push(w), 150, () => now);
    feed.set({ text: "终" });
    expect(sent).toEqual([{ text: "终" }]);
    // Two more pieces within the 150 ms: one send, with the latest.
    now += 40; feed.set({ text: "终端" });
    now += 40; feed.set({ text: "终端怎样" });
    expect(sent).toHaveLength(1);
    // The wait was set at the second piece: 150 ms from the first send.
    now += 70; vi.advanceTimersByTime(110);
    expect(sent).toEqual([{ text: "终" }, { text: "终端怎样" }]);
    // Its end at once, and a send still waiting dropped with it.
    now += 20; feed.set({ text: "终端怎样画" });
    feed.clear();
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([{ text: "终" }, { text: "终端怎样" }, null]);
    // The same text again, later, is not sent again.
    now += 500; feed.set({ text: "又一段" });
    now += 500; feed.set({ text: "又一段" });
    expect(sent).toEqual([{ text: "终" }, { text: "终端怎样" }, null, { text: "又一段" }]);
    feed.clear();
    // Nothing being written: no end to say.
    feed.clear();
    expect(sent).toHaveLength(5);
  });

  it("is a part's whole text so far, begun again for another part or for what it thinks", () => {
    const t = new WritingText();
    expect(t.add("a", "终端")).toEqual({ text: "终端" });
    expect(t.add("a", "怎样")).toEqual({ text: "终端怎样" });
    expect(t.add("b", "下一段")).toEqual({ text: "下一段" });
    expect(t.add("b", "先想", true)).toEqual({ text: "先想", thinking: true });
    t.reset();
    expect(t.add("b", "又")).toEqual({ text: "又" });
  });

  it("reads OpenCode's pieces of the session's answer from its event stream", () => {
    const t = new WritingText();
    const ev = (type: string, data: object) => ({ type, data: { sessionID: "s1", assistantMessageID: "m1", ordinal: 1, ...data } });
    expect(openCodeWriting(ev("session.reasoning.delta", { delta: "想" }), "s1", t)).toEqual({ text: "想", thinking: true });
    expect(openCodeWriting(ev("session.reasoning.ended", { text: "想完" }), "s1", t)).toBeNull();
    expect(openCodeWriting(ev("session.text.delta", { delta: "终端", ordinal: 2 }), "s1", t)).toEqual({ text: "终端" });
    expect(openCodeWriting(ev("session.text.delta", { delta: "怎样", ordinal: 2 }), "s1", t)).toEqual({ text: "终端怎样" });
    // Another session's (a sub-agent's) is not this one's.
    expect(openCodeWriting({ type: "session.text.delta", data: { sessionID: "s2", assistantMessageID: "m9", ordinal: 0, delta: "别的" } }, "s1", t)).toBeUndefined();
    // The part ends whole.
    expect(openCodeWriting(ev("session.text.ended", { text: "终端怎样画字", ordinal: 2 }), "s1", t)).toEqual({ text: "终端怎样画字" });
    expect(openCodeWriting({ type: "session.step.ended", data: { sessionID: "s1" } }, "s1", t)).toBeUndefined();
  });
});
