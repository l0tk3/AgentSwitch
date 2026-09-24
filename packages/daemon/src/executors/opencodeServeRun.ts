/** One OpenCode execution on the resident executor server (tech debt #8). Everything `opencode run --standalone`
 *  configures per run stays per run:
 *  - shell env (PUT …/environment, per session): scoped gate proxy, SECRET_GATE_HOME, NO_PROXY; the server's own env
 *    has no proxy, so OpenCode's model calls go direct;
 *  - MCP servers (PUT /api/experimental/mcp/<name>?location=<cwd>): secret-gate with the scope and repair bridge, the
 *    browser gate with the scope and §5.2 grant, the registry's servers; removed again in `finally`;
 *  - permissions (session ruleset = the standalone config's rules), instructions (session instruction entry), model,
 *    agent, location = cwd, resume of the thread's session.
 *  Runtime MCP servers are per location (exact directory, verified: not a parent, a child or another directory), so one
 *  execution holds a directory at a time on this server (`lease`; the engine's cwd lock already serialises tasks per
 *  cwd). A second execution in the same directory, a server that is down, or any API call failing before the prompt is
 *  admitted returns `fallback`, and the caller runs `opencode run --standalone`, whose private server never sees this
 *  server's runtime state. Rules that say "ask" become engine approvals; the question tool becomes engine questions. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Extensions, NO_EXTENSIONS } from "../extensions/index.js";
import { NO_AGENTS, NO_SIDE_EFFECTS, type ExecutionOutcome } from "../core/outcome.js";
import { sleep } from "../util/sleep.js";
import { opencodeMcpFromRegistry } from "./extensions.js";
import { gateRun, mcpServerEnv, opencodeGateConfig, reportTransfer, type GateOptions, type GateRun } from "./gate.js";
import { composePrompt, executorInstructions } from "./instructions.js";
import { interruptedOutcome, watchRunStop, type StopCause } from "./lifecycle.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../core/limits.js";
import { approvalFor, createdAt, foldTurn, formAnswer, formQuestions, isFinal, modelRef, runtimeMcp, shellEnv, toRuleset, type PermissionRequest, type PermissionRule, type TurnItem } from "./opencodeServeMap.js";
import { locationQuery, OpenCodeApiError, type CallOptions, type Json, type OpenCodeExecServer } from "./opencodeServer.js";
import { opencodeExecConfig, outcomeFromRun, SUBAGENT_TOOL } from "./opencodeShared.js";
import { canonicalPath, NO_PROTECTED, type ProtectedPaths } from "./protected.js";
import type { ExecutionInput } from "./types.js";

export type ServeRunOptions = {
  readonly gate?: GateOptions | null;
  readonly browser?: boolean;
  readonly extensions?: Pick<Extensions, "mcpFor" | "skillsInto">;
  readonly protected?: ProtectedPaths;
  readonly maxMs?: number;
  readonly log?: (line: string) => void;
  /** Tests: poll interval. */
  readonly pollMs?: number;
};

export type ServeAttempt = { readonly kind: "done"; readonly outcome: ExecutionOutcome } | { readonly kind: "fallback"; readonly reason: string };

const AGENT = "build";
const INSTRUCTIONS_KEY = "agentswitch";
const POLL_MS = 250;
const PAGE = 100;
const MAX_PAGES = 50;
const MAX_POLL_FAILURES = 8;
const INTERRUPT_GRACE_MS = 5_000;
const WARM_ATTEMPTS = 5;
const PROBE_ATTEMPTS = 5;
const RETRY_MS = 100;
const MCP_TIMEOUT_MS = 120_000;   // `npx @playwright/mcp` may download on first use
const CLEANUP_TIMEOUT_MS = 10_000;
/** The gate's own servers: always cleared from a location before an execution adds its own. */
const RESERVED_MCP = ["secret-gate", "playwright"];
const DENIED = "denied by the user via AgentSwitch";

/** Raised before the prompt is admitted: the run can still go to `opencode run --standalone`. */
class SetupFailure extends Error {}

const enc = encodeURIComponent;

/** Stopped before anything ran (mirrors gateRefs.ts). */
const cancelledOutcome = (): ExecutionOutcome => ({ ok: false, exitCode: null, stderr: "cancelled", lastText: "", sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: true, agents: NO_AGENTS });

export async function runOnServer(server: OpenCodeExecServer, input: ExecutionInput, opts: ServeRunOptions): Promise<ServeAttempt> {
  if (!(await server.ensureRunning())) return { kind: "fallback", reason: "the resident executor server is not running" };
  const release = server.lease(input.cwd);
  if (!release) return { kind: "fallback", reason: "another execution is using this directory on the resident server" };
  const run = new ServeExecution(server, input, opts);
  try {
    const prompt = await run.prepare();
    return { kind: "done", outcome: await run.drive(prompt) };
  } catch (err) {
    if (!(err instanceof SetupFailure)) throw err;
    if (input.signal.aborted) return { kind: "done", outcome: cancelledOutcome() };
    return { kind: "fallback", reason: run.redact(err.message) };
  } finally {
    try { await run.cleanup(); } finally { release(); }
  }
}

class ServeExecution {
  private readonly gate: GateOptions | null;
  private readonly browser: boolean;
  private readonly wiring: GateRun;
  private readonly loc: string;
  private readonly secrets: readonly string[];
  private sessionId: string | null = null;
  private created = false;
  private prompted = false;
  private profileDir: string | null = null;
  private readonly added: string[] = [];
  /** Our session and the sub-agent sessions under it. */
  private readonly tree = new Set<string>();
  private readonly parents = new Map<string, string | null>();
  private readonly handled = new Set<string>();
  /** Text events held back until the prompt is admitted (a fallback run says its own). */
  private readonly notes: string[] = [];
  private approvals = 0;
  private stopCause: StopCause | null = null;
  private truncated = false;

  constructor(private readonly server: OpenCodeExecServer, private readonly input: ExecutionInput, private readonly opts: ServeRunOptions) {
    this.gate = opts.gate ?? null;
    this.browser = (opts.browser ?? true) && input.browser;
    this.wiring = gateRun(input, this.browser);
    this.loc = locationQuery(input.cwd);
    this.secrets = [this.wiring.scope, input.credentialRepair?.key, this.wiring.transfer ? JSON.stringify(this.wiring.transfer) : null].filter((s): s is string => !!s);
  }

  /** Error text that leaves this module never carries the scope, the repair key or the grant. */
  redact(text: string): string { return this.secrets.reduce((t, s) => t.split(s).join("[redacted]"), text); }

  private log(line: string): void { (this.opts.log ?? ((l: string) => console.error(l)))(this.redact(line)); }

  private call<T = Json>(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<T> { return this.server.call<T>(method, path, body, opts); }

  private get stopped(): boolean { return this.stopCause !== null || this.input.signal.aborted; }

  async prepare(): Promise<string> {
    const { input } = this;
    await this.server.refreshSkills(this.opts.extensions ?? NO_EXTENSIONS);   // registry errors propagate, as in `run`
    const signal = input.signal;
    try {
      await this.warm();
      const mcp = this.mcpServers();
      await this.clearLocation(Object.keys(mcp));
      const sid = await this.openSession();
      await this.configure(sid);
      for (const [name, config] of Object.entries(mcp)) {
        this.added.push(name);   // before the call: a PUT that times out may still have started it
        await this.call("PUT", `/api/experimental/mcp/${enc(name)}?${this.loc}`, { config }, { signal, timeoutMs: MCP_TIMEOUT_MS });
      }
      await this.probe(sid);
    } catch (err) {
      throw err instanceof SetupFailure ? err : new SetupFailure((err as Error).message);
    }
    return composePrompt({ ...input, transfer: this.gate ? this.wiring.transfer ?? null : null });
  }

  /** A cold location answers its first requests half-loaded (permission checks came back wrong, verified): load it and
   *  wait until the build agent is listed. */
  private async warm(): Promise<void> {
    for (let i = 0; i < WARM_ATTEMPTS; i++) {
      const res = await this.call<{ data?: Json[] }>("GET", `/api/agent?${this.loc}`, undefined, { signal: this.input.signal });
      if ((res.data ?? []).some((a) => a.id === AGENT)) return;
      await sleep(RETRY_MS, this.input.signal);
    }
    throw new SetupFailure(`the ${AGENT} agent is not available in this directory`);
  }

  private rules(): PermissionRule[] {
    const { permission } = opencodeExecConfig(this.gate, "", false, { protected: this.opts.protected ?? NO_PROTECTED, skillsDir: this.server.skillsDir }) as { permission: Record<string, unknown> };
    return toRuleset(permission);
  }

  /** The gate's servers with this execution's scope, repair bridge and grant, then the registry's (plain proxy). */
  private mcpServers(): Record<string, Json> {
    const ext = this.opts.extensions ?? NO_EXTENSIONS;
    const registry = opencodeMcpFromRegistry(ext.mcpFor("opencode"), mcpServerEnv(this.gate));
    // A kept session slot is used as is (and never removed here); otherwise a throw-away profile for this run.
    if (this.gate && this.browser && !this.input.browserProfile) this.profileDir = mkdtempSync(join(tmpdir(), "agentswitch-ocs-"));
    const profile = this.input.browserProfile ?? join(this.profileDir ?? tmpdir(), "profile");
    const gated = this.gate ? opencodeGateConfig(this.gate, profile, this.browser, this.input.credentialRepair, this.wiring).mcp : {};
    return runtimeMcp({ ...gated, ...registry });
  }

  /** Runtime MCP servers outlive the session that needed them. Before adding its own, an execution removes the gate's
   *  servers, the names it is about to use and anything an earlier execution failed to remove here, so it never sees
   *  another execution's scope or grant (say, a browser gate left from a run that had the browser). */
  private async clearLocation(names: readonly string[]): Promise<void> {
    const clear = new Set([...names, ...RESERVED_MCP, ...this.server.staleMcp(this.input.cwd)]);
    const listed = await this.call<{ data?: Json[] }>("GET", `/api/mcp?${this.loc}`, undefined, { signal: this.input.signal });
    for (const s of listed.data ?? []) {
      const name = String(s.name ?? "");
      if (clear.has(name)) await this.removeMcp(name, { signal: this.input.signal });
    }
    this.server.setStaleMcp(this.input.cwd, []);
  }

  private async removeMcp(name: string, opts: CallOptions): Promise<void> {
    try { await this.call("DELETE", `/api/experimental/mcp/${enc(name)}?${this.loc}`, undefined, opts); }
    catch (err) { if (!(err instanceof OpenCodeApiError && err.status === 404)) throw err; }
  }

  private async openSession(): Promise<string> {
    const { input } = this;
    const signal = input.signal;
    const permissions = this.rules();
    if (input.resume) {
      const found = await this.resumable(input.resume);
      if (typeof found !== "string") {
        const id = input.resume;
        await this.call("PATCH", `/api/session/${enc(id)}`, { permissions }, { signal });
        const want = modelRef(input.model);
        const has = found.model as { providerID?: string; id?: string } | undefined;
        if (has?.providerID !== want.providerID || has?.id !== want.id) await this.call("POST", `/api/session/${enc(id)}/model`, { model: want }, { signal });
        if (found.agent !== undefined && found.agent !== AGENT) await this.call("POST", `/api/session/${enc(id)}/agent`, { agent: AGENT }, { signal });
        this.notes.push(`(resuming OpenCode session ${id})`);
        return this.adopt(id);
      }
      this.notes.push(`(OpenCode refused to resume ${input.resume}: ${found}; starting a new session)`);
    }
    const res = await this.call<{ data?: Json }>("POST", "/api/session", { title: `AgentSwitch ${input.taskId}`, agent: AGENT, model: modelRef(input.model), location: { directory: input.cwd }, permissions }, { signal });
    const id = String(res.data?.id ?? "");
    if (!id) throw new SetupFailure("session create returned no id");
    this.created = true;
    return this.adopt(id);
  }

  private adopt(id: string): string { this.sessionId = id; this.tree.add(id); return id; }

  /** The session when it can be resumed here, else why not: gone, another directory, a sub-agent's, or still running. */
  private async resumable(id: string): Promise<Json | string> {
    const signal = this.input.signal;
    let session: Json | undefined;
    try { session = (await this.call<{ data?: Json }>("GET", `/api/session/${enc(id)}`, undefined, { signal })).data; }
    catch (err) { if (err instanceof OpenCodeApiError && err.status === 404) return "session not found"; throw err; }
    const dir = String((session?.location as Json | undefined)?.directory ?? "");
    if (!session || !dir || canonicalPath(dir) !== canonicalPath(this.input.cwd)) return "it belongs to another directory";
    if (session.parentID) return "it is a sub-agent session";
    const active = await this.call<{ data?: Json }>("GET", "/api/session/active", undefined, { signal });
    if (active.data && id in active.data) return "it is still running";
    return session;
  }

  /** Per session: the shell env with this execution's scope, and the executor guidance (OpenCode 2.0.8 ignores the
   *  config file's `instructions`; an instruction entry reaches the model, verified). */
  private async configure(sid: string): Promise<void> {
    const signal = this.input.signal;
    await this.call("PUT", `/api/session/${enc(sid)}/environment`, { variables: shellEnv(this.gate, this.wiring.scope ?? null, this.input.cwd) }, { signal });
    await this.call("PUT", `/api/experimental/session/${enc(sid)}/instructions/entries/${INSTRUCTIONS_KEY}`, { value: executorInstructions() }, { signal });
  }

  /** The session's effective rules must say what was configured before a tool can run: deny probes through OpenCode's
   *  own evaluator (a deny leaves nothing behind; an unexpected ask is rejected at once). */
  private async probe(sid: string): Promise<void> {
    const signal = this.input.signal;
    const probes: [string, string][] = [["webfetch", "https://agentswitch.invalid/"], ["shell", "secret-gate keygen --agentswitch-probe"], ...(this.gate ? [["read", `${this.gate.home}/agentswitch-probe`] as [string, string]] : [])];
    for (let i = 0; i < PROBE_ATTEMPTS; i++) {
      let held = true;
      for (const [action, resource] of probes) {
        const res = await this.call<{ data?: { id?: string; effect?: string } }>("POST", `/api/session/${enc(sid)}/permission`, { action, resources: [resource], agent: AGENT }, { signal });
        if (res.data?.effect === "ask" && res.data.id) await this.reply(sid, res.data.id, false);
        if (res.data?.effect !== "deny") held = false;
      }
      if (held) return;
      await sleep(RETRY_MS, signal);
    }
    throw new SetupFailure("the permission rules are not in effect on the resident server");
  }

  async drive(prompt: string): Promise<ExecutionOutcome> {
    const { input } = this;
    const sid = this.sessionId!;
    if (input.signal.aborted) return cancelledOutcome();
    const sentAt = Date.now();
    let since: number;
    try {
      const sent = await this.call<{ data?: Json }>("POST", `/api/session/${enc(sid)}/prompt`, { text: prompt }, { signal: input.signal });
      since = Number((sent.data?.time as Json | undefined)?.created ?? sentAt);
    } catch (err) {
      // An HTTP answer means the prompt was refused, not admitted: the run can still go standalone.
      if (err instanceof OpenCodeApiError && err.status !== null) throw new SetupFailure(err.message);
      await this.interrupt();
      return interruptedOutcome({ ok: false, exitCode: null, stderr: this.redact(`OpenCode executor server connection closed while sending the prompt: ${(err as Error).message}`), lastText: "", timedOut: false, sideEffects: NO_SIDE_EFFECTS, agents: NO_AGENTS });
    }
    this.prompted = true;
    for (const text of this.notes) input.emit("text", { text });
    reportTransfer(input, this.wiring, "opencode", !!this.gate, this.browser);
    return this.follow(sid, since);
  }

  /** Poll the turn until its idle marker: emit text and tool calls, adopt sub-agent sessions, answer approvals and
   *  questions. A stop interrupts the session and waits a short grace for the marker. */
  private async follow(sid: string, since: number): Promise<ExecutionOutcome> {
    const seen = new Map<string, Json>();
    const emitted = new Set<string>();
    let failures = 0;
    let lost: string | null = null;
    let stoppedAt = 0;
    const watch = watchRunStop(this.input.signal, this.opts.maxMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS, (cause) => { this.stopCause ??= cause; void this.interrupt(); });
    try {
      for (;;) {
        if (this.stopped && !stoppedAt) stoppedAt = Date.now();
        let polled = false;
        try {
          await this.collect(sid, since, seen);
          await this.adoptChildren();
          await this.answerPermissions();
          await this.answerForms();
          polled = true; failures = 0;
        } catch (err) {
          if (!this.server.running || ++failures >= MAX_POLL_FAILURES) { lost = (err as Error).message; break; }
        }
        const turn = foldTurn([...seen.values()], since, sid);
        this.emit(turn.items, emitted);
        if (polled && turn.idle) break;
        if (stoppedAt && Date.now() - stoppedAt > INTERRUPT_GRACE_MS) break;
        await sleep(this.opts.pollMs ?? POLL_MS);
      }
    } finally {
      watch.dispose();
    }
    const turn = foldTurn([...seen.values()], since, sid, true);
    this.emit(turn.items, emitted);
    const summary = { ...turn.summary, telemetryComplete: turn.summary.telemetryComplete && !this.truncated };
    const exitCode = turn.idle === "succeeded" ? 0 : turn.idle === "failed" ? 1 : null;
    const stderr = [lost ? `OpenCode executor server connection closed during the run: ${lost}` : "", turn.idle === "failed" && !summary.errors.length ? "OpenCode turn failed" : ""].filter(Boolean).join("\n");
    const outcome: ExecutionOutcome = { ...outcomeFromRun(summary, exitCode, this.redact(stderr), watch.timedOut, this.approvals), ...(turn.httpStatus ? { httpStatus: turn.httpStatus } : {}), ...(turn.tokens ? { tokens: turn.tokens } : {}) };
    return this.input.signal.aborted || !turn.idle || lost ? interruptedOutcome(outcome) : outcome;
  }

  /** This turn's root-session messages, newest first, page by page until one older than the turn or one already seen
   *  final (everything before it is final and seen). */
  private async collect(sid: string, since: number, seen: Map<string, Json>): Promise<void> {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: { data?: Json[]; cursor?: { next?: string | null } } = await this.call("GET", `/api/session/${enc(sid)}/message?limit=${PAGE}${cursor ? `&cursor=${enc(cursor)}` : ""}`);
      const data = res.data ?? [];
      for (const m of data) {
        if (createdAt(m) < since) return;
        const known = seen.get(String(m.id));
        seen.set(String(m.id), m);
        if (known && isFinal(known)) return;
      }
      cursor = res.cursor?.next ?? null;
      if (!cursor || !data.length) return;
    }
    this.truncated = true;
  }

  private emit(items: readonly TurnItem[], emitted: Set<string>): void {
    for (const item of items) {
      if (emitted.has(item.key)) continue;
      emitted.add(item.key);
      if (item.kind === "text") { if (item.text) this.input.emit("text", { text: item.text }); continue; }
      this.input.emit("tool_call", { tool: item.tool, input: item.input, ...(item.error ? { error: item.error } : {}) });
      if (SUBAGENT_TOOL.test(item.tool)) this.input.emit("agent", { harness: "opencode", agentId: "", status: item.error ? "failed" : "completed", description: String((item.input as { description?: string } | null)?.description ?? "sub-agent") });
    }
  }

  /** Sub-agent sessions inherit the permission rules but not the shell env or the instruction entry (verified), so both
   *  are set as soon as a child shows up among the active sessions. A child's first shell call can come before that
   *  poll; it then runs with the server's env: no proxy, no scope, so gate substitution fails closed. */
  private async adoptChildren(): Promise<void> {
    const active = await this.call<{ data?: Json }>("GET", "/api/session/active");
    for (const id of Object.keys(active.data ?? {})) {
      if (this.tree.has(id) || this.parents.has(id)) continue;
      const s = await this.call<{ data?: Json }>("GET", `/api/session/${enc(id)}`);
      this.parents.set(id, typeof s.data?.parentID === "string" ? s.data.parentID : null);
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, parent] of this.parents) {
        if (this.tree.has(id) || !parent || !this.tree.has(parent)) continue;
        await this.configure(id);
        this.tree.add(id); grew = true;
      }
    }
  }

  private async answerPermissions(): Promise<void> {
    for (const sid of [...this.tree]) {
      const res = await this.call<{ data?: PermissionRequest[] }>("GET", `/api/session/${enc(sid)}/permission`);
      for (const req of res.data ?? []) {
        if (this.handled.has(req.id)) continue;
        this.handled.add(req.id);
        void this.decide(sid, req);
      }
    }
  }

  /** A rule that says "ask" goes to the engine's approval flow (allow and deny rules never get here). Only `once`:
   *  `always` would save a rule in OpenCode's shared database for later sessions. */
  private async decide(sid: string, req: PermissionRequest): Promise<void> {
    let allow = false;
    if (!this.stopped) {
      const { action, evidence } = approvalFor(req);
      try { allow = (await this.input.approve(action, evidence)) === "allow"; }
      catch (err) { this.log(`OpenCode approval for ${this.input.taskId} failed: ${(err as Error).message}`); }
    }
    allow = allow && !this.stopped;
    if (allow) this.approvals++;
    await this.reply(sid, req.id, allow);
  }

  private async reply(sid: string, id: string, allow: boolean): Promise<void> {
    await this.call("POST", `/api/session/${enc(sid)}/permission/${enc(id)}/reply`, allow ? { decision: "once" } : { decision: "reject", message: DENIED }, { timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
  }

  private async answerForms(): Promise<void> {
    for (const sid of [...this.tree]) {
      const res = await this.call<{ data?: Json[] }>("GET", `/api/session/${enc(sid)}/form`);
      for (const form of res.data ?? []) {
        const id = String(form.id ?? "");
        if (!id || this.handled.has(id)) continue;
        this.handled.add(id);
        void this.answer(sid, id, form);
      }
    }
  }

  /** The question tool goes to the engine's questions (the router answers from evidence or asks the user); an
   *  unanswered question tells the model so. Any other form, or a reply OpenCode refuses, is cancelled. */
  private async answer(sid: string, id: string, form: Json): Promise<void> {
    const questions = formQuestions(form);
    let reply: Record<string, string | string[]> | null = null;
    if (questions) {
      let answers = null;
      if (!this.stopped) {
        try { answers = await this.input.ask(questions); }
        catch (err) { this.log(`OpenCode question for ${this.input.taskId} failed: ${(err as Error).message}`); }
      }
      reply = formAnswer(form, answers);
    }
    const path = `/api/session/${enc(sid)}/form/${enc(id)}`;
    const sent = reply ? await this.call("POST", `${path}/reply`, { answer: reply }, { timeoutMs: CLEANUP_TIMEOUT_MS }).then(() => true, () => false) : false;
    if (!sent) await this.call("DELETE", path, undefined, { timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
  }

  private async interrupt(): Promise<void> {
    for (const id of [...this.tree]) await this.call("POST", `/api/session/${enc(id)}/interrupt`, undefined, { timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
  }

  /** Always, after success, fallback, throw and abort: the MCP servers this execution added leave the location (a name
   *  that cannot be removed is recorded, and the next execution here removes it first or runs standalone), the sessions'
   *  shell env loses the scope (it is released anyway; a later resume must not start with it), an unused new session is
   *  deleted, and the browser profile goes. */
  async cleanup(): Promise<void> {
    const t: CallOptions = { timeoutMs: CLEANUP_TIMEOUT_MS };
    const left: string[] = [];
    for (const name of this.added) {
      try { await this.removeMcp(name, t); } catch { left.push(name); }
    }
    if (left.length) {
      this.server.setStaleMcp(this.input.cwd, [...this.server.staleMcp(this.input.cwd), ...left]);
      this.log(`OpenCode executor server: could not remove MCP server(s) ${left.join(", ")} from ${this.input.cwd}; the next execution there removes them first or runs standalone`);
    }
    for (const id of this.tree) await this.call("PUT", `/api/session/${enc(id)}/environment`, { variables: shellEnv(this.gate, null, this.input.cwd) }, t).catch(() => undefined);
    if (this.created && !this.prompted && this.sessionId) await this.call("DELETE", `/api/session/${enc(this.sessionId)}`, undefined, t).catch(() => undefined);
    if (this.profileDir) rmSync(this.profileDir, { recursive: true, force: true });
  }
}
