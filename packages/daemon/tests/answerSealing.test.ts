import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.js";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import type { UserAnswers, UserQuestion } from "../src/core/questions.js";
import { Store } from "../src/engine/store.js";
import type { Executor } from "../src/executors/types.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { legend, type SealedEntry, type Sealer } from "../src/secrets/sealer.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const question = (id = "credential", extra: Partial<UserQuestion> = {}): UserQuestion => ({ id, header: "Details", text: "What is the login value for https://demo.test?", options: [], multi: false, secret: true, ...extra });
const entry = (token: string): SealedEntry => ({ label: "demo/login", field: "login value", kind: "secret", hosts: ["demo.test"], uses: ["http"], token });

function build(sealer: Sealer, questions: readonly UserQuestion[] = [question()]) {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-answer-sealing-"));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(home, "threads") });
  const bus = new Bus();
  const received: (UserAnswers | null)[] = [];
  const executor: Executor = { harness: "codex", async run(input) {
    const answers = await input.ask(questions);
    received.push(answers);
    const text = JSON.stringify(answers);
    input.emit("text", { text });
    return { ok: true, lastText: text };
  } };
  const engine = new Engine({ store, bus, executors: [executor], targets, router: echoRouter(() => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })), quota: () => ({}), approvalTimeoutMs: 10_000 });
  const app = createApp({ engine, store, bus, sealer, quota: { snapshot: async () => [], refresh: async () => [] }, targets, uploadsDir: home, policyPath: join(home, "policy.json"), extensions: { list: () => [] } } as never);
  cleanups.push(async () => {
    for (const task of store.listTasks()) engine.cancel(task.id);
    await engine.idle();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const start = async () => {
    let unsubscribe: () => void = () => undefined;
    const pending = new Promise<string>((resolve) => { unsubscribe = bus.subscribe("*", (event) => { if (event.type === "approval_request") { unsubscribe(); resolve(String(event.payload.approvalId)); } }); });
    const task = engine.submit({ task: "Inspect the account on https://demo.test.", cwd: home });
    return { task, approvalId: await pending };
  };
  const answer = (taskId: string, approvalId: string, given: object) => app.request(`/tasks/${taskId}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approval_id: approvalId, ...given }) });
  return { store, engine, received, start, answer };
}

describe("HTTP answers are sealed before storage and execution", () => {
  it("seals a plain text answer before approval records, events and the executor see it", async () => {
    const plaintext = "my-private-password";
    const token = "enc:v1:sealed-password";
    const sealer = vi.fn<Sealer>(async (text) => ({ ok: true, text: text.replace(plaintext, token), sealed: [entry(token)], ms: 1 }));
    const { store, engine, received, start, answer } = build(sealer);
    const { task, approvalId } = await start();

    const response = await answer(task.id, approvalId, { text: plaintext });
    expect(response.status).toBe(200);
    await engine.idle();

    expect(sealer).toHaveBeenCalledWith(plaintext, { parentTask: expect.stringContaining("https://demo.test") });
    expect(sealer.mock.calls[0]![1]?.parentTask).toContain("What is the login value");
    expect(received).toEqual([{ credential: [token] }]);
    expect(store.getApproval(approvalId)).toMatchObject({ status: "allowed", answer: JSON.stringify({ credential: [token] }) });
    expect(store.eventsSince(task.id).find((event) => event.type === "approval_resolved")?.payload).toMatchObject({ decision: "answer", answers: { credential: [token] } });
    expect(store.eventsSince(task.id).find((event) => event.type === "sealed")?.payload).toMatchObject({ entries: [entry(token)], source: "answer", approvalId });
    const persisted = JSON.stringify({ task: store.getTask(task.id), approval: store.getApproval(approvalId), events: store.eventsSince(task.id), received });
    expect(persisted).toContain(token);
    expect(persisted).not.toContain(plaintext);
  });

  it("seals every structured answer value, preserving question IDs and non-sensitive choices", async () => {
    const raw = ["first-private-value", "second-private-value"];
    const tokens = ["enc:v1:sealed-first", "enc:v1:sealed-second"];
    const sealer = vi.fn<Sealer>(async (text) => {
      const index = raw.indexOf(text);
      return { ok: true, text: index < 0 ? text : tokens[index]!, sealed: index < 0 ? [] : [entry(tokens[index]!)], ms: 1 };
    });
    const { store, engine, received, start, answer } = build(sealer, [question("logins", { multi: true }), question("environment", { text: "Which environment?", secret: false })]);
    const { task, approvalId } = await start();
    expect((await answer(task.id, approvalId, { answers: { logins: raw, environment: ["staging"] } })).status).toBe(200);
    await engine.idle();

    expect(sealer.mock.calls.map(([text]) => text)).toEqual([...raw, "staging"]);
    expect(received).toEqual([{ logins: tokens, environment: ["staging"] }]);
    expect(JSON.parse(store.getApproval(approvalId)!.answer!)).toEqual({ logins: tokens, environment: ["staging"] });
    const persisted = JSON.stringify({ task: store.getTask(task.id), approval: store.getApproval(approvalId), events: store.eventsSince(task.id), received });
    for (const value of raw) expect(persisted).not.toContain(value);
    expect(store.eventsSince(task.id).filter((event) => event.type === "sealed")).toHaveLength(1);
  });

  it("accepts a valid raw answer that expands beyond 4000 characters after sealing", async () => {
    const secret = "private-password";
    const raw = "Context. ".repeat(420) + secret;
    const token = "enc:v1:" + "A".repeat(224);
    const sealed = raw.replace(secret, token) + legend([entry(token)], null);
    expect(raw.length).toBeLessThanOrEqual(4000);
    expect(sealed.length).toBeGreaterThan(4000);
    const sealer: Sealer = async () => ({ ok: true, text: sealed, sealed: [entry(token)], ms: 1 });
    const { store, engine, received, start, answer } = build(sealer);
    const { task, approvalId } = await start();
    expect((await answer(task.id, approvalId, { text: raw })).status).toBe(200);
    await engine.idle();
    expect(JSON.parse(store.getApproval(approvalId)!.answer!)).toEqual({ credential: [sealed] });
    expect(received).toEqual([{ credential: [sealed] }]);
    expect(JSON.stringify(store.eventsSince(task.id))).not.toContain(secret);
  });

  it("keeps the raw 4000-character limit even if the HTTP body claims the answer is sealed", async () => {
    const sealer = vi.fn<Sealer>(async (text) => ({ ok: true, text, sealed: [], ms: 1 }));
    const { store, start, answer } = build(sealer);
    const { task, approvalId } = await start();
    const raw = "x".repeat(4001);
    for (const given of [{ text: raw }, { answers: { credential: [raw] } }, { answers: { credential: [raw] }, sealed: true }]) {
      expect((await answer(task.id, approvalId, given)).status).toBe(400);
    }
    expect(sealer).not.toHaveBeenCalled();
    expect(store.getApproval(approvalId)).toMatchObject({ status: "pending", answer: null });
  });

  it("gives the sealer a host supplied in another answer while storing only the sealed credential", async () => {
    const secret = "secret-for-new-host";
    const host = "https://other-demo.test";
    const token = "enc:v1:other-host";
    const questions = [question("credential", { text: "What login value should be used?" }), question("host", { text: "Which destination should receive it?", secret: false })];
    const sealer = vi.fn<Sealer>(async (text, context) => {
      expect(context?.parentTask).toContain(host);
      expect(context?.parentTask).toContain(questions[0]!.text);
      expect(context?.parentTask).toContain(questions[1]!.text);
      if (text === secret) return { ok: true, text: token, sealed: [{ ...entry(token), hosts: ["other-demo.test"] }], ms: 1 };
      return { ok: true, text, sealed: [], ms: 1 };
    });
    const { store, engine, received, start, answer } = build(sealer, questions);
    const { task, approvalId } = await start();
    expect((await answer(task.id, approvalId, { answers: { credential: [secret], host: [host] } })).status).toBe(200);
    await engine.idle();
    expect(received).toEqual([{ credential: [token], host: [host] }]);
    expect(JSON.stringify({ approval: store.getApproval(approvalId), events: store.eventsSince(task.id), received })).not.toContain(secret);
  });

  it.each(["unavailable", "unroutable"] as const)("a %s sealer failure leaves the answer pending with no partial storage", async (code) => {
    const raw = ["first-private-value", "second-private-value"];
    const sealer = vi.fn<Sealer>(async (text) => text === raw[0]
      ? { ok: true, text: "enc:v1:first", sealed: [entry("enc:v1:first")], ms: 1 }
      : { ok: false, code, error: `provider echoed ${raw[1]}`, ms: 1 });
    const { store, received, start, answer } = build(sealer, [question("first"), question("second")]);
    const { task, approvalId } = await start();
    const response = await answer(task.id, approvalId, { answers: { first: [raw[0]], second: [raw[1]] } });
    expect(response.status).toBe(code === "unavailable" ? 503 : 400);
    expect(await response.json()).toEqual({ error: "could not seal the answer; it was not stored" });
    expect(store.getTask(task.id)?.status).toBe("waiting_approval");
    expect(store.getApproval(approvalId)).toMatchObject({ status: "pending", answer: null });
    expect(store.eventsSince(task.id).filter((event) => event.type === "sealed" || event.type === "approval_resolved")).toEqual([]);
    expect(received).toEqual([]);
    const persisted = JSON.stringify({ task: store.getTask(task.id), approval: store.getApproval(approvalId), events: store.eventsSince(task.id) });
    for (const value of raw) expect(persisted).not.toContain(value);
  });

  it("validates answer IDs and complete question coverage before calling the sealer", async () => {
    const sealer = vi.fn<Sealer>(async (text) => ({ ok: true, text, sealed: [], ms: 1 }));
    const { store, start, answer } = build(sealer, [question("first"), question("second")]);
    const { task, approvalId } = await start();
    for (const given of [{ text: "one answer only" }, { answers: { first: ["one"] } }, { answers: { first: ["one"], second: ["two"], extra: ["three"] } }, { answers: { first: [], second: ["two"] } }]) {
      expect((await answer(task.id, approvalId, given)).status).toBe(400);
    }
    expect(sealer).not.toHaveBeenCalled();
    expect(store.getApproval(approvalId)).toMatchObject({ status: "pending", answer: null });
  });

  it("rejects another existing task's approval ID without sending the answer to the sealer", async () => {
    const sealer = vi.fn<Sealer>(async (text) => ({ ok: true, text, sealed: [], ms: 1 }));
    const { store, start, answer } = build(sealer);
    const { task, approvalId } = await start();
    const other = store.createTask({ task: "Other task", cwd: task.cwd });
    expect((await answer(other.id, approvalId, { text: "secret-for-wrong-task" })).status).toBe(404);
    expect(sealer).not.toHaveBeenCalled();
    expect(store.getApproval(approvalId)).toMatchObject({ taskId: task.id, status: "pending", answer: null });
    expect(JSON.stringify(store.eventsSince(other.id))).not.toContain("secret-for-wrong-task");
  });

  it.each(["expired", "cancelled"] as const)("rejects an answer after the question is %s", async (state) => {
    const sealer = vi.fn<Sealer>(async (text) => ({ ok: true, text, sealed: [], ms: 1 }));
    const { store, engine, received, start, answer } = build(sealer);
    const { task, approvalId } = await start();
    if (state === "expired") engine.resolveApproval(approvalId, "deny", "expired", "timeout");
    else engine.cancel(task.id);
    await engine.idle();
    const terminalStatus = store.getTask(task.id)?.status;
    expect((await answer(task.id, approvalId, { text: "too-late-private-value" })).status).toBe(404);
    expect(sealer).not.toHaveBeenCalled();
    expect(store.getTask(task.id)?.status).toBe(terminalStatus);
    expect(store.getApproval(approvalId)).toMatchObject({ status: "expired", answer: null });
    expect(received).toEqual([null]);
    expect(JSON.stringify(store.eventsSince(task.id))).not.toContain("too-late-private-value");
  });

  it.each(["expired", "cancelled"] as const)("does not commit an answer if the question becomes %s during sealing", async (state) => {
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const sealBarrier = new Promise<void>((resolve) => { release = resolve; });
    const sealer: Sealer = async () => {
      started();
      await sealBarrier;
      return { ok: true, text: "enc:v1:late", sealed: [entry("enc:v1:late")], ms: 1 };
    };
    const { store, engine, received, start, answer } = build(sealer);
    const { task, approvalId } = await start();
    const response = answer(task.id, approvalId, { text: "private-value-while-sealing" });
    await startedPromise;
    if (state === "expired") engine.resolveApproval(approvalId, "deny", "expired", "timeout");
    else engine.cancel(task.id);
    release();
    expect((await response).status).toBe(404);
    await engine.idle();
    expect(store.getApproval(approvalId)).toMatchObject({ status: "expired", answer: null });
    expect(received).toEqual([null]);
    expect(store.eventsSince(task.id).filter((event) => event.type === "sealed" || (event.type === "approval_resolved" && event.payload.decision === "answer"))).toEqual([]);
    expect(JSON.stringify(store.eventsSince(task.id))).not.toContain("private-value-while-sealing");
  });
});
