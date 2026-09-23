import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deletePlatformMemory, exactPlatformOrigin, loadPlatformMemory, platformCheckpoint, platformOrigins, PLATFORM_MEMORY_TTL, rememberPlatformFacts, removeTaskPlatformMemories, safePlatformText, type PlatformCheckpoint, type PlatformFactCandidate } from "../src/threads/platformMemory.js";

const NOW = 1780000000000;
const ORIGIN = "https://admin.example.test:8443";
const QUOTE = "The Users menu opens the members table.";
const dirs: string[] = [];
const file = () => { const dir = mkdtempSync(join(tmpdir(), "agentswitch-platform-")); dirs.push(dir); return join(dir, "platform-memory.json"); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const checkpoint = (overrides: Partial<PlatformCheckpoint> = {}): PlatformCheckpoint => ({ seq: 4, ts: NOW, purpose: "do", ok: true, result: `Observed: ${QUOTE}`, brief: `Inspect ${ORIGIN}/admin`, ...overrides });
const fact = (overrides: Partial<PlatformFactCandidate> = {}): PlatformFactCandidate => ({ origin: ORIGIN, key: "users.list", text: "Open the Users menu to reach the members table.", kind: "operation", eventSeq: 4, quote: QUOTE, ...overrides });
const source = (overrides: Partial<Parameters<typeof rememberPlatformFacts>[2]> = {}) => ({ taskId: "task-a", task: `Inspect ${ORIGIN}/admin`, checkpoints: [checkpoint()], now: NOW, ...overrides });

describe("platform memory scope and evidence", () => {
  it("uses exact scheme/host/port origins and extracts scoped URLs without wildcards or credentials", () => {
    expect(exactPlatformOrigin("https://EXAMPLE.test:443/")).toBe("https://example.test");
    expect(exactPlatformOrigin("http://example.test:8443")).toBe("http://example.test:8443");
    for (const bad of ["https://*.example.test", "https://me:pass@example.test", "https://example.test/a", "https://example.test?x=1", "ftp://example.test", "example.test"]) expect(exactPlatformOrigin(bad)).toBeNull();
    expect(platformOrigins("Use [admin](https://admin.example.test:8443/members), https://admin.example.test and http://[::1]:8080/", "https://user:pass@example.test https://*.example.test", "https://[::1]")).toEqual([ORIGIN, "https://admin.example.test", "http://[::1]:8080", "https://[::1]"]);
  });

  it("persists an observed fact with exact checkpoint provenance and private file mode", () => {
    const path = file();
    const result = rememberPlatformFacts(path, [fact()], source());
    expect(result.skipped).toEqual([]);
    expect(result.added[0]).toMatchObject({ origin: ORIGIN, status: "observed", source: { taskId: "task-a", eventSeq: 4, quote: QUOTE }, createdAt: NOW, updatedAt: NOW, expiresAt: NOW + PLATFORM_MEMORY_TTL.observed });
    expect(loadPlatformMemory(path, NOW)).toEqual(result.added);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("requires a quoted real checkpoint and a task or user-context origin", () => {
    const path = file();
    const bad = [fact({ origin: "https://other.example.test" }), fact({ origin: "http://admin.example.test:8443" }), fact({ origin: "https://admin.example.test" }), fact({ eventSeq: 8 }), fact({ quote: "The platform invents this quote." }), fact({ quote: " " })];
    expect(rememberPlatformFacts(path, bad, source()).added).toEqual([]);
    expect(rememberPlatformFacts(path, [fact()], source({ task: "Inspect the named internal platform", context: `Admin: ${ORIGIN}` })).added).toHaveLength(1);
  });

  it("only successful verification with known nonmutating effects earns verified status", () => {
    const path = file();
    const cases: Partial<PlatformCheckpoint>[] = [
      { purpose: "verify", sideEffectsKnown: true, sideEffects: { filesChanged: 0, commandsRun: 2, approvalsGranted: 0 } },
      { purpose: "verify", sideEffectsKnown: false, sideEffects: { filesChanged: 0, commandsRun: 0, approvalsGranted: 0 } },
      { purpose: "verify", sideEffectsKnown: true, sideEffects: { filesChanged: 1, commandsRun: 0, approvalsGranted: 0 } },
      { purpose: "verify", sideEffectsKnown: true, sideEffects: { filesChanged: 0, commandsRun: 0, approvalsGranted: 1 } },
      { purpose: "research", sideEffectsKnown: true, sideEffects: { filesChanged: 0, commandsRun: 0, approvalsGranted: 0 } },
    ];
    cases.forEach((input, i) => {
      const remembered = rememberPlatformFacts(path, [fact({ key: `case.${i}` })], source({ checkpoints: [checkpoint(input)] })).added[0]!;
      expect(remembered.status).toBe(i === 0 ? "verified" : "observed");
      expect(remembered.expiresAt).toBe(NOW + (i === 0 ? PLATFORM_MEMORY_TTL.verified : PLATFORM_MEMORY_TTL.observed));
    });
  });

  it("records failed attempts only as short-lived incidents, never operation facts", () => {
    const path = file();
    const evidence = source({ checkpoints: [checkpoint({ purpose: "verify", ok: false })] });
    expect(rememberPlatformFacts(path, [fact()], evidence).added).toEqual([]);
    const incident = rememberPlatformFacts(path, [fact({ kind: "incident" })], evidence).added[0]!;
    expect(incident).toMatchObject({ kind: "incident", status: "observed", expiresAt: NOW + PLATFORM_MEMORY_TTL.incident });
    expect(loadPlatformMemory(path, incident.expiresAt)).toEqual([]);
    expect(loadPlatformMemory(path, incident.expiresAt, true)).toEqual([incident]);
  });

  it("does not treat unrelated CONTEXT origins as evidence of a verified platform observation", () => {
    const path = file();
    const verify = { purpose: "verify" as const, sideEffectsKnown: true, sideEffects: { filesChanged: 0, commandsRun: 0, approvalsGranted: 0 } };
    const base = source({ task: "Inspect the admin platform", context: `${ORIGIN}\nhttps://elsewhere.example.test` });
    expect(rememberPlatformFacts(path, [fact()], { ...base, checkpoints: [checkpoint({ ...verify, brief: "Check the current page" })] }).added[0]?.status).toBe("observed");
    expect(rememberPlatformFacts(path, [fact()], { ...base, checkpoints: [checkpoint({ ...verify, result: `At https://elsewhere.example.test: ${QUOTE}` })] }).added).toEqual([]);
    expect(rememberPlatformFacts(path, [fact()], { ...base, checkpoints: [checkpoint({ ...verify, brief: `Inspect ${ORIGIN} and https://elsewhere.example.test` })] }).added[0]?.status).toBe("observed");
    const exactQuote = `At ${ORIGIN}/admin — ${QUOTE}`;
    expect(rememberPlatformFacts(path, [fact({ quote: exactQuote })], { ...base, checkpoints: [checkpoint({ ...verify, result: `${exactQuote}\nAnother link: https://elsewhere.example.test` })] }).added[0]?.status).toBe("verified");
  });

  it("ignores non-checkpoint and malformed evidence and trusts event sequence/time over payload", () => {
    expect(platformCheckpoint({ seq: 3, ts: NOW, type: "done", payload: { purpose: "verify", ok: true, result: QUOTE } })).toBeNull();
    expect(platformCheckpoint({ seq: 3, ts: NOW, type: "checkpoint", payload: { purpose: "verify", result: QUOTE } })).toBeNull();
    expect(platformCheckpoint({ seq: 3, ts: NOW, type: "checkpoint", payload: { seq: 900, ts: 0, purpose: "verify", ok: true, result: QUOTE } })).toMatchObject({ seq: 3, ts: NOW });
  });
});

describe("platform memory retention and confidentiality", () => {
  it("replaces a stable property, keeps platforms separate and refuses older evidence", () => {
    const path = file();
    const first = rememberPlatformFacts(path, [fact()], source()).added[0]!;
    const changed = "The Users menu is under Settings.";
    const second = rememberPlatformFacts(path, [fact({ text: changed, quote: changed })], source({ taskId: "task-b", now: NOW + 1000, checkpoints: [checkpoint({ ts: NOW + 1000, result: changed })] })).added[0]!;
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(NOW);
    expect(second.source.taskId).toBe("task-b");
    expect(rememberPlatformFacts(path, [fact()], source({ now: NOW + 2000 })).added).toEqual([]);
    const otherOrigin = "https://elsewhere.example.test";
    rememberPlatformFacts(path, [fact({ origin: otherOrigin })], source({ task: otherOrigin, now: NOW + 2000, checkpoints: [checkpoint({ brief: `Inspect ${otherOrigin}` })] }));
    expect(loadPlatformMemory(path, NOW + 2000)).toHaveLength(2);
    expect(removeTaskPlatformMemories(path, ["task-a"])).toBe(1);
    expect(loadPlatformMemory(path, NOW + 2000)).toEqual([second]);
    expect(deletePlatformMemory(path, second.id)).toBe(true);
    expect(deletePlatformMemory(path, second.id)).toBe(false);
    expect(loadPlatformMemory(path, NOW)).toEqual([]);
  });

  it("never persists credentials, account identifiers, authorization or task progress in content or quotes", () => {
    const path = file();
    const unsafe = ["Use enc:v1:AAAAAAAAAAAAAAAAAAAA", "password: a-private-value", "password is a-private-value", "account: administrator", "用户名是管理员", "Logged in as administrator", "邮箱：boss@example.test", "Session remains usable", "User approved future submissions", "用户授权自动批准", "已创建一个账号", "Created the account", "JBSWY3DPEHPK3PXP", "api_key=private-value"];
    for (const text of unsafe) {
      expect(safePlatformText(text), text).toBe(false);
      expect(rememberPlatformFacts(path, [fact({ text })], source()).added, text).toEqual([]);
      expect(rememberPlatformFacts(path, [fact({ quote: text })], source({ checkpoints: [checkpoint({ result: text })] })).added, text).toEqual([]);
    }
    expect(safePlatformText("The password input is inside the login form.")).toBe(true);
    expect(safePlatformText("账号管理页面位于设置菜单。")).toBe(true);
  });

  it("preserves malformed storage instead of overwriting it and does not revive expired evidence", () => {
    const path = file();
    writeFileSync(path, "invalid existing data");
    expect(loadPlatformMemory(path)).toEqual([]);
    expect(rememberPlatformFacts(path, [fact()], source())).toMatchObject({ added: [], skipped: [expect.stringContaining("preserved")] });
    expect(removeTaskPlatformMemories(path, ["task-a"])).toBe(0);
    expect(deletePlatformMemory(path, "invalid")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("invalid existing data");
    rmSync(path);
    expect(rememberPlatformFacts(path, [fact()], source({ now: NOW + PLATFORM_MEMORY_TTL.observed })).added).toEqual([]);
    expect(loadPlatformMemory(undefined)).toEqual([]);
  });
});
