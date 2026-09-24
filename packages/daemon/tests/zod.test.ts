import { describe, expect, it } from "vitest";
import { z } from "zod";
import { issues } from "../src/api/shared.js";
import { zodIssues } from "../src/util/zod.js";

const failed = (schema: z.ZodType, value: unknown): z.ZodError => {
  const r = schema.safeParse(value);
  if (r.success) throw new Error("expected a validation failure");
  return r.error;
};
const Obj = z.object({ a: z.string(), b: z.object({ c: z.number() }), d: z.boolean(), e: z.string() });
const nested = failed(Obj, { a: 1, b: { c: "x" }, d: "no", e: 2 });
const root = failed(z.string(), 5);

describe("zodIssues keeps each former inline format", () => {
  it("path: message joined with '; ', a root issue as ': message'", () => {
    expect(zodIssues(nested)).toBe(nested.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    expect(zodIssues(nested)).toMatch(/^a: .+; b\.c: .+; d: .+; e: .+$/);
    expect(zodIssues(root)).toBe(`: ${root.issues[0]!.message}`);
  });

  it("a named root, a limit, and messages only", () => {
    expect(zodIssues(root, { root: "transfer" })).toBe(`transfer: ${root.issues[0]!.message}`);
    expect(zodIssues(nested, { root: "transfer", limit: 3 })).toBe(nested.issues.slice(0, 3).map((i) => `${i.path.join(".") || "transfer"}: ${i.message}`).join("; "));
    expect(zodIssues(nested, { paths: false })).toBe(nested.issues.map((i) => i.message).join("; "));
  });

  it("the API's issues() names the body", () => {
    expect(issues(root)).toBe(`body: ${root.issues[0]!.message}`);
    expect(issues(nested)).toBe(zodIssues(nested));
  });
});
