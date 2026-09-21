import { describe, expect, it } from "vitest";
import { closestToken, knownTokens, repairInValue, repairTokens, shortToken } from "../src/executors/tokens.js";

const A = "enc:v1:" + "GVcy-68pHooQ" + "x".repeat(200) + "n0AnK01g";
const B = "enc:v1:" + "z9_Mh5ySKbOE" + "y".repeat(270) + "6fzho-_g";
const drop = (t: string, at: number) => t.slice(0, at) + t.slice(at + 1);
const flip = (t: string, at: number) => t.slice(0, at) + (t[at] === "x" ? "X" : "x") + t.slice(at + 1);

describe("token repair", () => {
  it("collects the genuine tokens from several texts", () => {
    expect([...knownTokens(`密码 ${A}\n`, null, `token ${B} again ${A}`)]).toEqual([A, B]);
    expect(knownTokens("nothing enc:v1:short").size).toBe(0);
  });

  it("a copy missing or flipping one character in the middle maps back to the genuine token; exact copies pass through", () => {
    const known = knownTokens(A, B);
    expect(closestToken(drop(A, 100), known)).toBe(A);
    expect(closestToken(flip(A, 150), known)).toBe(A);
    expect(closestToken(drop(drop(B, 100), 120), known)).toBe(B);
    expect(closestToken(A, known)).toBe(A);
    expect(closestToken("enc:v1:" + "q".repeat(220), known)).toBeNull();
    expect(closestToken(A.slice(0, 60), known)).toBeNull();                                // far too short
  });

  it("repairTokens rewrites the text and reports each repair; repairInValue walks tool inputs", () => {
    const known = knownTokens(A, B);
    const r = repairTokens(`brief: use ${drop(A, 90)} for the password box and ${B} for mail`, known);
    expect(r.text).toContain(A);
    expect(r.text).toContain(B);
    expect(r.repairs).toEqual([{ from: drop(A, 90), to: A }]);
    expect(repairTokens("no tokens here", known)).toEqual({ text: "no tokens here", repairs: [] });
    const v = repairInValue({ selector: "#pw", value: flip(A, 40), nested: [{ text: drop(B, 50) }], n: 3 }, known);
    expect(v.value).toEqual({ selector: "#pw", value: A, nested: [{ text: B }], n: 3 });
    expect(v.repairs).toHaveLength(2);
    expect(shortToken(A)).toBe("enc:v1:GVcy-68pHooQ…AnK01g (220 chars)");
  });
});
