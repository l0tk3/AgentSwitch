/** Per-execution short references (gate-next-v0 §1): one scope per `run()`, the task's enc:v1: tokens registered in it,
 *  every text the executor sees rewritten to enc:ref: references, and everything that leaves the run (outcome, events,
 *  approval requests, questions, errors) mapped back to the stable ciphertext, so records never hold a reference that
 *  dies with the scope and an approver sees which credential is meant. The scope itself (it sits in the shell's proxy
 *  URL, so `env` or `curl -v` can print it) is replaced by "[scope]" on the way out. The scope is released in `finally`,
 *  on success, throw and abort alike. The ref↔token maps live only in this run's closure.
 *  Before any of that, §3: a dead gate proxy stops the run before a harness starts. */

import { randomBytes } from "node:crypto";
import type { UserAnswers, UserQuestion } from "../core/questions.js";
import { NO_AGENTS, NO_SIDE_EFFECTS, type ExecutionOutcome } from "../core/outcome.js";
import { ENCODED_REF_RE, REF_RE, type RefGate } from "../secrets/refs.js";
import type { GateHealth } from "./gate.js";
import { TOKEN_RE } from "./tokens.js";
import type { ExecutionInput, Executor } from "./types.js";

export type GateRefsDeps = {
  readonly refs: RefGate;
  /** TCP reachability of the gate proxy (`gateHealth`). */
  readonly health: () => Promise<GateHealth>;
  /** Operator log (stderr by default). Never receives the scope. */
  readonly log?: (message: string) => void;
};

export const GATE_DOWN_HINT = "请启动凭据网关（secret-gate service install 或 secret-gate proxy）后重试";

/** A failed outcome, before any harness started: no side effects, known. `gateUnavailable` stops the task (reroute.ts). */
export function gateDownOutcome(error: string): ExecutionOutcome {
  return {
    ok: false, exitCode: null, gateUnavailable: true, lastText: "",
    stderr: `凭据网关未运行（${error.slice(0, PROXY_ERROR_CHARS)}），本次未启动执行器。${GATE_DOWN_HINT}。`,
    sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: true, agents: NO_AGENTS,
  };
}

export const SCOPE_MASK = "[scope]";
/** How much of a gate error the user-facing text quotes. */
const PROXY_ERROR_CHARS = 120;
const REFS_ERROR_CHARS = 160;

/** Every printable form of the scope: itself, and the Proxy-Authorization value base64("scope:" + scope) that curl -v
 *  shows, in standard and url-safe base64 (unpadded, so padded copies match too) and URL-encoded. Longest first. */
export function scopeForms(scope: string): readonly string[] {
  const basic = Buffer.from(`scope:${scope}`).toString("base64").replace(/=+$/, "");
  const forms = [scope, basic, basic.replace(/\+/g, "-").replace(/\//g, "_"), encodeURIComponent(basic)];
  return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

/** One run's two-way table. Only exact, registered tokens are rewritten; anything else passes untouched. */
class RefTable {
  private readonly byToken = new Map<string, string>();
  private readonly byRef = new Map<string, string>();
  private readonly scopeForms: readonly string[];

  constructor(scope: string) { this.scopeForms = scopeForms(scope); }

  has(token: string): boolean { return this.byToken.has(token); }

  add(token: string, ref: string): void { this.byToken.set(token, ref); this.byRef.set(ref, token); }

  /** enc:v1: → enc:ref: in text the executor will read. */
  toRefs(text: string): string {
    return this.byToken.size ? text.replace(TOKEN_RE, (m) => this.byToken.get(m) ?? m) : text;
  }

  /** Anything that leaves the run: enc:ref: → enc:v1: (plain and URL-encoded), and the scope masked. */
  toTokens(text: string): string {
    const masked = this.scopeForms.reduce((t, form) => (t.includes(form) ? t.split(form).join(SCOPE_MASK) : t), text);
    if (!this.byRef.size || !masked.includes("enc")) return masked;
    return masked
      .replace(REF_RE, (m) => this.byRef.get(m) ?? m)
      .replace(ENCODED_REF_RE, (m, id: string) => { const token = this.byRef.get(`enc:ref:${id}`); return token ? encodeURIComponent(token) : m; });
  }

  /** Strings inside objects and arrays mapped back; other values untouched. Returns new objects, never mutates. */
  toTokensDeep<T>(value: T): T {
    if (typeof value === "string") return this.toTokens(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.toTokensDeep(v)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.toTokensDeep(v)])) as T;
    return value;
  }
}

const mapText = (text: string | null | undefined, fn: (s: string) => string): string | null => (text == null ? null : fn(text));

type Registration = { readonly ok: true } | { readonly ok: false; readonly error: string };

export function gateRefsExecutor(executor: Executor, deps: GateRefsDeps): Executor {
  const log = deps.log ?? ((message: string) => console.error(message));
  return {
    harness: executor.harness,
    async run(input) {
      const health = await deps.health();
      if (!health.ok) {
        log(`secret-gate proxy unreachable (${health.error}); ${executor.harness} not started`);
        return gateDownOutcome(health.error);
      }
      const scope = randomBytes(24).toString("base64url");
      const table = new RefTable(scope);
      /** Register the tokens not yet in the table; failed items stay as enc:v1:. Throws only when the CLI itself fails. */
      const register = async (tokens: readonly string[], signal?: AbortSignal): Promise<void> => {
        const fresh = [...new Set(tokens)].filter((t) => !table.has(t));
        if (!fresh.length) return;
        const results = await deps.refs.register(scope, fresh, signal);
        const failed = results.filter((r) => "error" in r).length;
        results.forEach((r, i) => { if ("ref" in r) table.add(fresh[i]!, r.ref); });
        if (failed) log(`secret-gate refs: ${failed} of ${fresh.length} token(s) could not be registered for ${input.taskId}; they stay as enc:v1:`);
      };
      let registration: Registration;
      try {
        await register([...input.knownTokens], input.signal);
        registration = { ok: true };
      } catch (err) {
        registration = { ok: false, error: (err as Error).message };
      }
      try {
        // Stopped while registering: nothing started, nothing to report but the stop itself.
        if (input.signal.aborted) return { ok: false, exitCode: null, stderr: "cancelled", lastText: "", sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: true, agents: NO_AGENTS };
        if (!registration.ok) {
          // No references at all: the run goes ahead with the full tokens and no scope, exactly as before gate-next.
          log(`secret-gate refs unavailable for ${input.taskId}: ${registration.error}`);
          // Without a scope the browser gate cannot honour a §5.2 grant either (gate.ts drops it; the executor's
          // transfer_grant "inactive" event records that); say so next to the cause.
          input.emit("text", { text: `(本次执行未启用短引用 enc:ref:，继续使用完整 enc:v1: 密文${input.transfer ? "；授权字段传递本次也不生效" : ""}：${registration.error.slice(0, REFS_ERROR_CHARS)})` });
          return await executor.run(input);
        }
        let outcome: ExecutionOutcome;
        try { outcome = await executor.run(scopedInput(input, scope, table, register, log)); }
        catch (err) { throw err instanceof Error ? new Error(table.toTokens(err.message), { cause: err }) : err; }
        return table.toTokensDeep(outcome);
      } finally {
        try { await deps.refs.release(scope); }
        catch (err) { log(`secret-gate refs release failed for ${input.taskId}: ${(err as Error).message}`); }
      }
    },
  };
}

/** The executor's view: texts on references, the scope for the gate wiring, answers registered on the fly,
 *  events mapped back to ciphertext. `knownTokens` stays the engine's set (tool-argument repair still needs it). */
function scopedInput(input: ExecutionInput, scope: string, table: RefTable, register: (tokens: readonly string[]) => Promise<void>, log: (m: string) => void): ExecutionInput {
  const toRefs = (s: string) => table.toRefs(s);
  return {
    ...input,
    task: toRefs(input.task),
    brief: toRefs(input.brief),
    handoffNote: mapText(input.handoffNote, toRefs),
    context: mapText(input.context, toRefs),
    platformMemory: mapText(input.platformMemory, toRefs),
    feedback: mapText(input.feedback, toRefs),
    gateScope: scope,
    emit: (type, payload) => input.emit(type, table.toTokensDeep(payload)),
    // The approver (and the stored approval_request) sees the credential that is meant, never a dead reference.
    approve: (action, evidence, signal) => input.approve(table.toTokens(action), table.toTokens(evidence), signal),
    ask: async (questions) => {
      const { outward, idBack } = outwardQuestions(questions, table);
      const answers = await input.ask(outward);
      if (!answers) return answers;
      // A credential the user seals while the executor waits joins this scope before the executor reads it.
      const tokens = Object.values(answers).flat().flatMap((a) => a.match(TOKEN_RE) ?? []);
      try { await register(tokens); }
      catch (err) { log(`secret-gate refs: answer tokens not registered for ${input.taskId}: ${(err as Error).message}`); }
      return Object.fromEntries(Object.entries(answers).map(([id, values]) => [idBack.get(id) ?? id, values.map(toRefs)])) as UserAnswers;
    },
  };
}

/** Questions as the user and the records see them (ciphertext, no scope). Claude keys answers by question text, so the
 *  ids are mapped too and answers come back under the executor's own ids; ids that would collide stay as they were. */
function outwardQuestions(questions: readonly UserQuestion[], table: RefTable): { outward: UserQuestion[]; idBack: ReadonlyMap<string, string> } {
  const mapped = questions.map((q) => table.toTokensDeep(q));
  const ids = mapped.map((q) => q.id);
  if (new Set(ids).size !== ids.length) return { outward: mapped.map((q, i) => ({ ...q, id: questions[i]!.id })), idBack: new Map() };
  return { outward: mapped, idBack: new Map(mapped.map((q, i) => [q.id, questions[i]!.id])) };
}
