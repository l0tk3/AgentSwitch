import { describe, expect, it } from "vitest";
import { aggregateRecords, guardsFor, recordText, type RecordRow } from "../src/router/record.js";

const NOW = 100 * 86400_000;
const row = (over: Partial<RecordRow>): RecordRow => ({ taskId: "t", ts: NOW - 1000, kind: "code-multifile", harness: "claude-code", model: "claude-opus-5", status: "done", failureKind: null, ms: 60_000, tokens: 1000, approvals: 0, handedOff: false, pinned: false, userHandoff: false, rating: null, ...over });

describe("track record", () => {
  it("aggregates per kind and target inside the window; text is one line per kind", () => {
    const rows = [
      row({ taskId: "1", ms: 30_000 }),
      row({ taskId: "2", status: "failed", failureKind: "refusal", ms: 10_000, tokens: 0 }),
      row({ taskId: "3", harness: "codex", model: "gpt-5.5", ms: 20_000, userHandoff: true }),
      row({ taskId: "4", kind: "browser", harness: "claude-code", model: "claude-haiku-4-5-20251001", status: "failed", failureKind: "transport" }),
      row({ taskId: "old", ts: NOW - 40 * 86400_000 }),
    ];
    const agg = aggregateRecords(rows, NOW);
    expect(agg.map((k) => k.kind)).toEqual(["browser", "code-multifile"]);
    const code = agg[1]!;
    expect(code.targets[0]).toMatchObject({ harness: "claude-code", runs: 2, ok: 1, refusals: 1, avgMs: 20_000, avgTokens: 500 });
    expect(code.targets[1]).toMatchObject({ harness: "codex", runs: 1, ok: 1, userHandoffs: 1 });
    expect(recordText(agg)).toBe("browser: claude-code/claude-haiku-4-5-20251001 1 runs 0 ok, avg 60 s, 1000 tok (1 transport/quota)\ncode-multifile: claude-code/claude-opus-5 2 runs 1 ok, avg 20 s, 500 tok (1 refused); codex/gpt-5.5 1 runs 1 ok, avg 20 s, 1000 tok (user handed off 1×)");
    expect(recordText([])).toBe("");
  });

  it("guards: three consecutive refusals/failures demote; a success resets; transport does not count; user handoff marks overridden", () => {
    const seq = (kinds: (string | null)[], extra: Partial<RecordRow> = {}) => kinds.map((k, i) => row({ taskId: String(i), ts: NOW - 10_000 + i, status: k ? "failed" : "done", failureKind: k, ...extra }));
    expect(guardsFor(seq(["refusal", "task_failed", "refusal"]), "code-multifile", NOW).demoted).toEqual([{ harness: "claude-code", model: "claude-opus-5" }]);
    expect(guardsFor(seq(["refusal", "refusal", null, "refusal"]), "code-multifile", NOW).demoted).toEqual([]);
    expect(guardsFor(seq(["refusal", "transport", "refusal", "refusal"]), "code-multifile", NOW).demoted).toHaveLength(1);
    expect(guardsFor(seq(["refusal", "refusal", "refusal"]), "browser", NOW).demoted).toEqual([]);           // other kind
    expect(guardsFor(seq(["refusal", "refusal", "refusal"]), null, NOW).demoted).toEqual([]);
    expect(guardsFor(seq(["refusal", "refusal", "refusal"], { ts: NOW - 31 * 86400_000 }), "code-multifile", NOW).demoted).toEqual([]);
    const g = guardsFor([row({ userHandoff: true }), row({ harness: "codex", model: "gpt-5.5" })], "code-multifile", NOW);
    expect(g.overridden).toEqual([{ harness: "claude-code", model: "claude-opus-5" }]);
  });
});
