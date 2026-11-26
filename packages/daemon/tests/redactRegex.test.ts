/** Replacement words that are regular expressions (vault/words.ts, user #596): what is refused, what the gateway is
 *  given, and that a match's placeholder is the one the same text gets as a plain word. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPattern, hashRef, RedactionError, RedactionStore } from "../src/vault/words.js";

const WHO = { user: "nobody-here", host: "box" };
const store = () => new RedactionStore(mkdtempSync(join(tmpdir(), "agentswitch-regex-")), [Buffer.alloc(32, 7)], () => 1, WHO);

describe("a regular expression as a word", () => {
  it("is taken when both sides read it alike, matches something and nothing ordinary", () => {
    for (const ok of ["sk-[A-Za-z0-9]{20,}", "ghp_[A-Za-z0-9]{36}", "\\b1[3-9]\\d{9}\\b", "(?:AKIA|ASIA)[A-Z0-9]{16}", "acct-\\d{6}(?=\\D|$)"]) expect(checkPattern(ok), ok).toBeNull();
  });

  it("is refused, with the reason in Chinese, when it is broken, empty-matching, too wide, runaway or read otherwise by Python", () => {
    const refused: [string, RegExp][] = [
      ["sk-[A-Z", /不是有效的正则/],
      ["(abc)?", /空字符串/],
      ["x*y*z*", /空字符串/],
      ["\\w+", /普通文字/],
      ["[a-z]{3,}", /普通文字/],
      ["(qq\\d+)+z", /嵌套的重复/],
      ["(q[0-9]*_)*zz9", /嵌套的重复/],
      ["(?<id>tok\\d+)", /命名分组/],
      ["(?<=key=)\\d+", /后行断言/],
      ["(?i)secret", /内联标记/],
      ["\\p{L}{40}", /\\p/],
      ["ab", /至少/],
      ["x".repeat(201), /最长/],
    ];
    for (const [bad, why] of refused) expect(checkPattern(bad), bad).toMatch(why);
    const s = store();
    expect(() => s.add({ value: "\\w+", regex: true })).toThrow(RedactionError);
  });

  it("goes to the gateway with the profile's salt — the same placeholder a plain word of that text gets — and not as a pair", () => {
    const s = store();
    s.add({ value: "sk-[A-Za-z0-9]{20,}", regex: true });
    s.add({ value: "acct-\\d{6}", regex: true, replace: "ACCOUNT_ID" }, "room1");
    s.add({ value: "plain-secret" });
    const [p] = s.patterns("work", []);
    expect(p).toMatchObject({ pattern: "sk-[A-Za-z0-9]{20,}", restore: true });
    expect(s.pairs("work", ["room1"]).map((x) => x.value)).toEqual(["nobody-here", "plain-secret"]);
    // The gateway works out a match's placeholder from the salt as hashRef does here.
    const match = "sk-abcdefghijklmnopqrstuv";
    s.add({ value: match });
    expect(hashRef(p!.salt!, match)).toBe(s.pairs("work", []).find((x) => x.value === match)!.ref);
    // A placeholder of the user's own: every match becomes it, one way only; the room's pattern only in that room.
    expect(s.patterns("work", ["room1"])[1]).toEqual({ pattern: "acct-\\d{6}", ref: "ACCOUNT_ID", restore: false });
    expect(s.patterns("work", [])).toHaveLength(1);
    expect(() => s.add({ value: "acct-\\d{6}", regex: true, replace: "acct-123456" })).toThrow(/不能被这个正则匹配到/);
    // Listed as it was written, and marked.
    expect(s.words().find((w) => w.regex)).toMatchObject({ value: "sk-[A-Za-z0-9]{20,}", regex: true, restore: true });
  });

  it("fixes the gateway's formula: this salt and text give this placeholder (secret-gate test_model_gate.py has the same)", () => {
    expect(hashRef("01".repeat(32), "sk-abcdefghijklmnopqrstuv")).toBe(KNOWN);
  });
});

const KNOWN = "h_dqmolpdzrc";
