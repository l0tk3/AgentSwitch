/** gate-next-v0 §1/§3: the per-execution enc:ref: wrapper with a fake refs CLI and fake executors; no gate, no model. */
import { describe, expect, it } from "vitest";
import { GATE_DOWN_HINT, gateDownOutcome, gateRefsExecutor, scopeForms, type GateRefsDeps } from "../src/executors/gateRefs.js";
import { composePrompt } from "../src/executors/instructions.js";
import type { ExecutionInput, Executor } from "../src/executors/types.js";
import type { UserAnswers } from "../src/core/questions.js";
import { classifyFailure, excerpt } from "../src/router/failure.js";
import { NO_SIDE_EFFECTS, type ExecutionOutcome } from "../src/core/outcome.js";
import { nextStep } from "../src/router/reroute.js";
import type { RefGate, RefResult } from "../src/secrets/refs.js";
import { aggregateRecords, guardsFor, type RecordRow } from "../src/router/record.js";
import { realTargets } from "./helpers.js";

const T1 = `enc:v1:${"A".repeat(40)}`;
const T2 = `enc:v1:${"B".repeat(40)}`;
const BAD = `enc:v1:${"C".repeat(40)}`;   // the gate cannot open it: stays as ciphertext
const T4 = `enc:v1:${"D".repeat(40)}`;
const SCOPE_RE = /^[A-Za-z0-9_-]{32}$/;

type Call = { readonly kind: "register" | "release"; readonly scope: string; readonly tokens?: readonly string[]; readonly aborted?: boolean };

function fakeRefs(opts: { failRegister?: string; failRelease?: string; unopenable?: ReadonlySet<string> } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const refs: RefGate = {
    async register(scope, tokens, signal) {
      calls.push({ kind: "register", scope, tokens: [...tokens], aborted: signal?.aborted ?? false });
      if (signal?.aborted) throw new Error("secret-gate refs register: cancelled");
      if (opts.failRegister) throw new Error(opts.failRegister);
      return tokens.map((t): RefResult => (opts.unopenable?.has(t) ? { error: "token cannot be opened" } : { ref: `enc:ref:${String(++n).padStart(16, "R")}`, label: "fixture" }));
    },
    async release(scope) {
      calls.push({ kind: "release", scope });
      if (opts.failRelease) throw new Error(opts.failRelease);
      return 1;
    },
  };
  return { refs, calls };
}

const REF1 = `enc:ref:${"1".padStart(16, "R")}`;
const REF2 = `enc:ref:${"2".padStart(16, "R")}`;

function capture(run?: (input: ExecutionInput) => Promise<ExecutionOutcome>): { executor: Executor; seen: ExecutionInput[] } {
  const seen: ExecutionInput[] = [];
  return { seen, executor: { harness: "claude-code", async run(input) { seen.push(input); return run ? run(input) : { ok: true, exitCode: 0, lastText: "done" }; } } };
}

type Emitted = { readonly type: string; readonly payload: Record<string, unknown> };

function execution(over: Partial<ExecutionInput> = {}, answers: UserAnswers | null = null) {
  const emitted: Emitted[] = [];
  const known = new Set([T1, T2, BAD]);
  const input: ExecutionInput = {
    taskId: "t1", task: `登录邮箱，账号密码 ${T1}`, brief: `log in with the mailbox password ${T1}`, cwd: "/tmp", model: "fixture", effort: null,
    handoffNote: `earlier attempt used ${T2}`, context: `- mail: ${T1}\n- legacy: ${BAD}`, platformMemory: `seen ${T2} before`, feedback: `user confirmed ${T1} is the mail password`,
    knownTokens: known, threadHome: null, resume: null, attachments: [], browser: true, signal: new AbortController().signal,
    emit: (type, payload) => { emitted.push({ type, payload }); }, approve: async () => "deny", ask: async () => answers, ...over,
  };
  return { input, emitted, known };
}

function deps(refs: RefGate, logs: string[], health: GateRefsDeps["health"] = async () => ({ ok: true })): GateRefsDeps {
  return { refs, health, log: (m) => logs.push(m) };
}

describe("gate refs wrapper: scope, registration and rewrite", () => {
  it("registers the task's tokens under a fresh scope, rewrites every text, gives the scope only to the executor, and releases it", async () => {
    const { refs, calls } = fakeRefs({ unopenable: new Set([BAD]) });
    const { executor, seen } = capture();
    const { input, emitted, known } = execution();
    const logs: string[] = [];
    const outcome = await gateRefsExecutor(executor, deps(refs, logs)).run(input);
    expect(outcome).toMatchObject({ ok: true, lastText: "done" });
    const got = seen[0]!;
    const scope = got.gateScope!;
    expect(scope).toMatch(SCOPE_RE);
    expect(calls).toEqual([{ kind: "register", scope, tokens: [T1, T2, BAD], aborted: false }, { kind: "release", scope }]);
    expect(got.task).toBe(`登录邮箱，账号密码 ${REF1}`);
    expect(got.brief).toBe(`log in with the mailbox password ${REF1}`);
    expect(got.handoffNote).toBe(`earlier attempt used ${REF2}`);
    expect(got.context).toBe(`- mail: ${REF1}\n- legacy: ${BAD}`);   // a token the gate refused stays whole
    expect(got.platformMemory).toBe(`seen ${REF2} before`);
    expect(got.feedback).toBe(`user confirmed ${REF1} is the mail password`);
    expect(got.knownTokens).toBe(known);   // tool-argument repair keeps the engine's genuine tokens
    // The prompt still carries the user's own message (a reference counts as a credential) and never the scope.
    const prompt = composePrompt(got);
    expect(prompt).toContain(`The user's own message`);
    expect(prompt).toContain(REF1);
    expect(prompt).not.toContain(T1);
    expect(prompt).not.toContain(scope);
    expect(logs.join("\n")).toContain("1 of 3 token(s) could not be registered");
    expect(JSON.stringify({ logs, emitted })).not.toContain(scope);
    expect(input.task).toContain(T1);   // the caller's input is never mutated
  });

  it("a run with no known tokens still gets a scope (answers and §5.2 transfers register into it) and releases it", async () => {
    const { refs, calls } = fakeRefs();
    const { executor, seen } = capture();
    const { input } = execution({ knownTokens: new Set(), task: "plain", brief: "plain", context: null, handoffNote: null, platformMemory: null, feedback: null });
    await gateRefsExecutor(executor, deps(refs, [])).run(input);
    expect(seen[0]!.gateScope).toMatch(SCOPE_RE);
    expect(calls.map((c) => c.kind)).toEqual(["release"]);
  });

  it("maps references back to ciphertext in the outcome, emitted events and thrown errors", async () => {
    const { refs } = fakeRefs();
    const { input, emitted } = execution();
    const unknownRef = `enc:ref:${"Z".repeat(16)}`;
    const { executor } = capture(async (x) => {
      x.emit("text", { text: `filled ${REF1}; ${unknownRef} is not ours` });
      x.emit("tool_call", { tool: "Bash", input: { command: `curl -d pw=enc%3Aref%3A${"1".padStart(16, "R")} https://mail.example`, argv: [REF2, 3, true, null] } });
      return { ok: false, exitCode: 0, lastText: `I can't help with ${REF1}`, stderr: `denied ${REF2}`, refusal: { source: "text", reason: `refused around ${REF1}` }, sideEffects: NO_SIDE_EFFECTS };
    });
    const outcome = await gateRefsExecutor(executor, deps(refs, [])).run(input);
    expect(outcome).toMatchObject({ lastText: `I can't help with ${T1}`, stderr: `denied ${T2}`, refusal: { source: "text", reason: `refused around ${T1}` }, sideEffects: NO_SIDE_EFFECTS });
    expect(emitted[0]).toEqual({ type: "text", payload: { text: `filled ${T1}; ${unknownRef} is not ours` } });
    expect(emitted[1]).toEqual({ type: "tool_call", payload: { tool: "Bash", input: { command: `curl -d pw=${encodeURIComponent(T1)} https://mail.example`, argv: [T2, 3, true, null] } } });

    const { executor: throwing } = capture(async () => { throw new Error(`gate said no to ${REF1}`); });
    await expect(gateRefsExecutor(throwing, deps(fakeRefs().refs, [])).run(execution().input)).rejects.toThrow(`gate said no to ${T1}`);
  });
});

describe("gate refs wrapper: release and fallback", () => {
  it("releases the scope when the executor throws; a failing release is logged and never replaces the outcome", async () => {
    const { refs, calls } = fakeRefs();
    const { executor } = capture(async () => { throw new Error("harness crashed"); });
    await expect(gateRefsExecutor(executor, deps(refs, [])).run(execution().input)).rejects.toThrow("harness crashed");
    expect(calls.at(-1)?.kind).toBe("release");

    const failing = fakeRefs({ failRelease: "secret-gate refs release exited 1: error: disk full" });
    const logs: string[] = [];
    const outcome = await gateRefsExecutor(capture().executor, deps(failing.refs, logs)).run(execution().input);
    expect(outcome).toMatchObject({ ok: true, lastText: "done" });
    expect(logs.at(-1)).toContain("release failed for t1: secret-gate refs release exited 1");
  });

  it("stopped during registration: the harness never starts and the scope is still released", async () => {
    const { refs, calls } = fakeRefs();
    const ctl = new AbortController();
    ctl.abort();
    const { executor, seen } = capture();
    const outcome = await gateRefsExecutor(executor, deps(refs, [])).run(execution({ signal: ctl.signal }).input);
    expect(seen).toHaveLength(0);
    expect(outcome).toMatchObject({ ok: false, stderr: "cancelled", sideEffectsKnown: true });
    expect(calls.map((c) => c.kind)).toEqual(["register", "release"]);
  });

  it("falls back to the unmodified input without a scope when the refs CLI fails, and says so", async () => {
    const { refs, calls } = fakeRefs({ failRegister: "secret-gate refs register: spawn /g/secret-gate ENOENT" });
    const { executor, seen } = capture();
    const { input, emitted } = execution();
    const logs: string[] = [];
    const outcome = await gateRefsExecutor(executor, deps(refs, logs)).run(input);
    expect(outcome).toMatchObject({ ok: true });
    expect(seen[0]).toBe(input);
    expect(seen[0]!.gateScope).toBeUndefined();
    expect(emitted).toEqual([{ type: "text", payload: { text: expect.stringContaining("未启用短引用 enc:ref:") } }]);
    expect(String(emitted[0]!.payload.text)).toContain("ENOENT");
    expect(logs[0]).toContain("refs unavailable for t1");
    expect(calls.map((c) => c.kind)).toEqual(["register", "release"]);
    const withGrant = execution({ transfer: { source: ["crm.example.com"], destination: ["erp.example.com"], fields: ["email"], purpose: "sync" } });
    await gateRefsExecutor(capture().executor, deps(fakeRefs({ failRegister: "exited 2" }).refs, [])).run(withGrant.input);
    expect(String(withGrant.emitted[0]!.payload.text)).toContain("授权字段传递本次也不生效");
  });
});

describe("gate refs wrapper: answers during the run", () => {
  it("registers newly sealed answer tokens in the same scope and hands them to the executor as references", async () => {
    const { refs, calls } = fakeRefs();
    const answers: UserAnswers = { which: [`the new password is ${T4}`], again: [`same as ${T1}`] };
    let seenAnswers: UserAnswers | null = null;
    const { executor, seen } = capture(async (x) => {
      seenAnswers = await x.ask([{ id: "which", header: "", text: "which password?", options: [], multi: false, secret: true }]);
      return { ok: true, exitCode: 0, lastText: `used ${(seenAnswers?.which ?? [""])[0]!.split(" ").at(-1)}` };
    });
    const outcome = await gateRefsExecutor(executor, deps(refs, [])).run(execution({}, answers).input);
    const scope = seen[0]!.gateScope!;
    const ref4 = `enc:ref:${"4".padStart(16, "R")}`;   // T1, T2, BAD took 1-3
    expect(seenAnswers).toEqual({ which: [`the new password is ${ref4}`], again: [`same as ${REF1}`] });
    expect(calls.filter((c) => c.kind === "register")).toEqual([
      { kind: "register", scope, tokens: [T1, T2, BAD], aborted: false },
      { kind: "register", scope, tokens: [T4], aborted: false },
    ]);
    expect(outcome.lastText).toBe(`used ${T4}`);   // the stored result keeps the stable ciphertext
  });

  it("an answer whose registration fails reaches the executor unchanged; no answer stays null", async () => {
    let registerCalls = 0;
    const refs: RefGate = {
      async register(_scope, tokens) { if (++registerCalls > 1) throw new Error("refs register timed out"); return tokens.map((_, i) => ({ ref: `enc:ref:${String(i).padStart(16, "Q")}`, label: "x" })); },
      async release() { return 0; },
    };
    const logs: string[] = [];
    const replies: (UserAnswers | null)[] = [];
    const { executor } = capture(async (x) => { replies.push(await x.ask([])); return { ok: true, exitCode: 0, lastText: "ok" }; });
    await gateRefsExecutor(executor, deps(refs, logs)).run(execution({}, { q: [T4] }).input);
    expect(replies).toEqual([{ q: [T4] }]);
    expect(logs.join("\n")).toContain("answer tokens not registered for t1: refs register timed out");
    const none: (UserAnswers | null)[] = [];
    const { executor: silent } = capture(async (x) => { none.push(await x.ask([])); return { ok: true, exitCode: 0, lastText: "ok" }; });
    await gateRefsExecutor(silent, deps(fakeRefs().refs, [])).run(execution({}, null).input);
    expect(none).toEqual([null]);
  });
});

describe("gate proxy down (gate-next-v0 §3)", () => {
  it("does not start the harness or touch the refs CLI, and returns a clear gate_unavailable outcome", async () => {
    const { refs, calls } = fakeRefs();
    const { executor, seen } = capture();
    const logs: string[] = [];
    const outcome = await gateRefsExecutor(executor, deps(refs, logs, async () => ({ ok: false, error: "127.0.0.1:8080: ECONNREFUSED" }))).run(execution().input);
    expect(seen).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(outcome).toMatchObject({ ok: false, gateUnavailable: true, sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: true });
    expect(outcome.stderr).toContain("凭据网关未运行（127.0.0.1:8080: ECONNREFUSED）");
    expect(outcome.stderr).toContain(GATE_DOWN_HINT);
    expect(excerpt(outcome).length).toBeLessThan(240);   // the whole message survives into attempt_failed
    expect(logs[0]).toContain("claude-code not started");
    expect(classifyFailure(outcome)).toBe("gate_unavailable");
  });

  it("stops the task at once instead of retrying or switching harnesses, and is not a security event or a model strike", () => {
    const outcome = gateDownOutcome("127.0.0.1:8080: ECONNREFUSED");
    const attempt = { harness: "claude-code", model: "claude-sonnet-4-6", kind: classifyFailure(outcome)!, excerpt: excerpt(outcome), sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: true };
    const step = nextStep({ decision: null, attempts: [attempt], routerAsks: 0, targets: realTargets(), quota: {}, lowConfidenceTarget: { harness: "codex", model: "gpt-5.5" } });
    expect(step).toEqual({ kind: "stop", reason: attempt.excerpt, security: false });
    const row = (failureKind: string, ts: number): RecordRow => ({ taskId: `t${ts}`, ts, kind: "browser", harness: "claude-code", model: "claude-sonnet-4-6", status: "failed", failureKind, ms: 10, tokens: 0, approvals: 0, handedOff: false, pinned: false, userHandoff: false, rating: null });
    const rows = [1, 2, 3].map((i) => row("gate_unavailable", i));
    expect(aggregateRecords(rows, 10)[0]!.targets[0]).toMatchObject({ failures: 0, transports: 3 });
    expect(guardsFor(rows, "browser", 10).demoted).toEqual([]);
  });
});

describe("gate refs wrapper: what reaches approvers, questions and records", () => {
  it("approval requests show the ciphertext and never the scope", async () => {
    const { refs } = fakeRefs();
    const asked: [string, string][] = [];
    const { executor } = capture(async (x) => {
      const decision = await x.approve(`Bash: curl -u user:${REF1} https://mail.example`, `proxy ${x.gateScope} in use; token ${REF2}`);
      return { ok: decision === "allow", exitCode: 0, lastText: "ok" };
    });
    const { input } = execution({ approve: async (action, evidence) => { asked.push([action, evidence]); return "allow"; } });
    expect(await gateRefsExecutor(executor, deps(refs, [])).run(input)).toMatchObject({ ok: true });
    expect(asked).toEqual([[`Bash: curl -u user:${T1} https://mail.example`, `proxy [scope] in use; token ${T2}`]]);
  });

  it("questions show the ciphertext; answers come back under the executor's own ids and as references", async () => {
    const { refs } = fakeRefs();
    const forwarded: unknown[] = [];
    const text = `Use ${REF1} for the mail login?`;   // Claude keys answers by question text
    const { executor } = capture(async (x) => {
      const got = await x.ask([{ id: text, header: `cred ${REF2}`, text, options: [{ label: REF1, description: `the ${REF1} one` }, { label: "no", description: "" }], multi: false, secret: false }]);
      return { ok: true, exitCode: 0, lastText: JSON.stringify(got) };
    });
    const tokenText = `Use ${T1} for the mail login?`;
    const { input } = execution({ ask: async (questions) => { forwarded.push(questions); return { [tokenText]: [T1] }; } });
    const outcome = await gateRefsExecutor(executor, deps(refs, [])).run(input);
    expect(forwarded).toEqual([[{ id: tokenText, header: `cred ${T2}`, text: tokenText, options: [{ label: T1, description: `the ${T1} one` }, { label: "no", description: "" }], multi: false, secret: false }]]);
    // The executor saw its own id and the reference; the record (mapped back) holds the ciphertext.
    expect(JSON.parse(outcome.lastText!)).toEqual({ [tokenText]: [T1] });
    const seenByExecutor: unknown[] = [];
    const { executor: probe } = capture(async (x) => { seenByExecutor.push(await x.ask([{ id: text, header: "", text, options: [], multi: false, secret: false }])); return { ok: true, exitCode: 0, lastText: "" }; });
    await gateRefsExecutor(probe, deps(fakeRefs().refs, [])).run(execution({ ask: async () => ({ [tokenText]: [T1] }) }).input);
    expect(seenByExecutor).toEqual([{ [text]: [REF1] }]);
  });

  it("colliding ids after mapping stay as the executor sent them", async () => {
    const forwarded: { id: string }[][] = [];
    const { executor } = capture(async (x) => {
      await x.ask([{ id: REF1, header: "", text: "a", options: [], multi: false, secret: false }, { id: T1, header: "", text: "b", options: [], multi: false, secret: false }]);
      return { ok: true, exitCode: 0, lastText: "" };
    });
    await gateRefsExecutor(executor, deps(fakeRefs().refs, [])).run(execution({ ask: async (q) => { forwarded.push(q.map((x) => ({ id: x.id }))); return null; } }).input);
    expect(forwarded).toEqual([[{ id: REF1 }, { id: T1 }]]);
  });

  it("masks the scope, raw and as the Proxy-Authorization value, in events, the outcome and errors", async () => {
    const { refs } = fakeRefs();
    const { input, emitted } = execution();
    let scope = "";
    const { executor } = capture(async (x) => {
      scope = x.gateScope!;
      const basic = Buffer.from(`scope:${scope}`).toString("base64");
      x.emit("tool_call", { tool: "Bash", command: "env", output: `HTTPS_PROXY=http://scope:${scope}@127.0.0.1:8080` });
      x.emit("text", { text: `> Proxy-Authorization: Basic ${basic}\n${encodeURIComponent(basic)} ${basic.replace(/\+/g, "-").replace(/\//g, "_")}` });
      return { ok: true, exitCode: 0, lastText: `proxy was http://scope:${scope}@127.0.0.1:8080`, stderr: basic };
    });
    const outcome = await gateRefsExecutor(executor, deps(refs, [])).run(input);
    const everything = JSON.stringify({ emitted, outcome });
    expect(everything).not.toContain(scope);
    for (const form of scopeForms(scope)) expect(everything).not.toContain(form);
    expect(emitted[0]!.payload.output).toBe("HTTPS_PROXY=http://scope:[scope]@127.0.0.1:8080");
    expect(outcome.lastText).toBe("proxy was http://scope:[scope]@127.0.0.1:8080");
    expect(outcome.stderr).toMatch(/^\[scope\]=*$/);
    const { executor: throwing } = capture(async (x) => { throw new Error(`curl: proxy http://scope:${x.gateScope}@127.0.0.1:8080 refused`); });
    const err = await gateRefsExecutor(throwing, deps(fakeRefs().refs, [])).run(execution().input).catch((e: Error) => e);
    expect(String(err)).toBe("Error: curl: proxy http://scope:[scope]@127.0.0.1:8080 refused");
  });

  it("scope forms: raw, standard and url-safe base64 of scope:<scope>, URL-encoded, longest first", () => {
    const forms = scopeForms("a".repeat(22) + "+/");
    expect(forms[forms.length - 1]).toBe("a".repeat(22) + "+/");
    expect(forms).toContain(Buffer.from(`scope:${"a".repeat(22)}+/`).toString("base64").replace(/=+$/, ""));
    expect([...forms].sort((a, b) => b.length - a.length)).toEqual(forms);
  });
});
