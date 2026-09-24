/** Real-model experiment: can each harness keep its session transcript in a PRIVATE directory
 *  (one per AgentSwitch thread) and natively resume it in a later process, without touching the
 *  user's ~/.claude or ~/.codex? Costs a few cents (haiku / gpt-5.5 low).
 *    npx tsx scripts/resume_experiment.ts [claude|codex|all]
 *  Prints one JSON document with both experiments' findings. Does not touch src/. */

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { AppServerClient, type Json } from "../src/harness/appserver.js";
import { stripProxy } from "../src/util/env.js";

const HERE = new URL(".", import.meta.url).pathname;
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CODEX_MODEL = "gpt-5.5";
const CODEX_EFFORT = "low";
const READ_PROMPT = "Read note.txt in the working directory and reply with its exact content.";
const RECALL_PROMPT = "Without reading any file, what word was in note.txt earlier in this conversation? Reply with only the word.";
const CLAUDE_ALLOWED = new Set(["Read", "Glob", "Grep"]);
const TURN_TIMEOUT_MS = 180_000;

type Listing = readonly string[];
type StepTiming = Readonly<Record<string, number>>;

// ---------- shared helpers ----------

const log = (msg: string): void => { process.stderr.write(`[resume_experiment] ${msg}\n`); };

function randomWord(): string {
  return `zebra-${Math.floor(1000 + Math.random() * 9000)}`;
}

function makeCwd(prefix: string, word: string): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  writeFileSync(join(cwd, "note.txt"), `${word}\n`);
  return cwd;
}

/** Subtrees Codex fills with bundled content on every start; collapsed to one entry so diffs stay readable. */
const COLLAPSED = ["skills/.system/", "plugins/", "tmp/arg0/", "cache/"];

/** Recursive listing of relative paths (files and dirs) under `root`; empty if `root` is missing. */
function listTree(root: string): Listing {
  if (!existsSync(root)) return [];
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    const rel = relative(root, p) + (e.isDirectory() ? "/" : "");
    if (COLLAPSED.includes(rel)) return [`${rel}…`];
    return e.isDirectory() ? [rel, ...walk(p)] : [rel];
  });
  return walk(root).sort();
}

const added = (before: Listing, after: Listing): string[] => after.filter((p) => !before.includes(p));

const withTiming = async <T>(timings: StepTiming, name: string, fn: () => Promise<T>): Promise<{ value: T; timings: StepTiming }> => {
  const started = Date.now();
  const value = await fn();
  return { value, timings: { ...timings, [name]: Date.now() - started } };
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------- experiment 1: Claude Agent SDK ----------

type ClaudeRun = { sessionIdFromInit: string | null; sessionIdFromResult: string | null; text: string; toolCalls: string[]; resultSubtype: string | null; error: string | null };

async function runClaude(prompt: string, base: Options, resume?: string): Promise<ClaudeRun> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  const options: Options = { ...base, abortController: abort, ...(resume ? { resume } : {}) };
  let run: ClaudeRun = { sessionIdFromInit: null, sessionIdFromResult: null, text: "", toolCalls: [], resultSubtype: null, error: null };
  try {
    for await (const msg of query({ prompt, options })) run = foldClaude(run, msg);
  } catch (err) {
    run = { ...run, error: errorText(err) };
  } finally {
    clearTimeout(timer);
  }
  return run;
}

function foldClaude(run: ClaudeRun, msg: SDKMessage): ClaudeRun {
  if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") return { ...run, sessionIdFromInit: (msg as { session_id?: string }).session_id ?? null };
  if (msg.type === "assistant") {
    const blocks = (msg.message as { content?: { type: string; text?: string; name?: string }[] }).content ?? [];
    const text = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n");
    const tools = blocks.filter((b) => b.type === "tool_use").map((b) => b.name ?? "?");
    return { ...run, text: [run.text, text].filter(Boolean).join("\n"), toolCalls: [...run.toolCalls, ...tools] };
  }
  if (msg.type === "result") {
    const r = msg as { subtype: string; session_id?: string; result?: string };
    return { ...run, sessionIdFromResult: r.session_id ?? null, resultSubtype: r.subtype, text: r.result ?? run.text };
  }
  return run;
}

type ClaudeVariant = { name: string; options: Partial<Options>; env: () => Record<string, string> };

/** macOS keeps the OAuth login in the keychain under "Claude Code-credentials"; with CLAUDE_CONFIG_DIR set,
 *  the CLI looks up "Claude Code-credentials-<sha256(configDir)[:8]>" instead (see bO() in the binary).
 *  CLAUDE_SECURESTORAGE_CONFIG_DIR="" forces the unsuffixed name. Fallback: hand the token over explicitly. */
function oauthTokenFromKeychain(): Record<string, string> {
  try {
    const raw = execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? "", "-w", "-s", "Claude Code-credentials"], { encoding: "utf8", timeout: 5000 }).trim();
    const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken;
    return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
  } catch (err) {
    log(`keychain read failed: ${errorText(err)}`);
    return {};
  }
}

const CLAUDE_VARIANTS: readonly ClaudeVariant[] = [
  { name: "settingSources: [] + env.CLAUDE_CONFIG_DIR", options: { settingSources: [] }, env: () => ({}) },
  { name: "settingSources: [] + env.CLAUDE_CONFIG_DIR + CLAUDE_SECURESTORAGE_CONFIG_DIR=''", options: { settingSources: [] }, env: () => ({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }) },
  { name: "settingSources: [] + env.CLAUDE_CONFIG_DIR + CLAUDE_CODE_OAUTH_TOKEN (from keychain)", options: { settingSources: [] }, env: oauthTokenFromKeychain },
  { name: "settingSources omitted + env.CLAUDE_CONFIG_DIR + CLAUDE_SECURESTORAGE_CONFIG_DIR=''", options: {}, env: () => ({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }) },
];

async function claudeExperimentVariant(variant: ClaudeVariant): Promise<Json> {
  const word = randomWord();
  const cwd = makeCwd("agentswitch-resume-claude-", word);
  const privateDir = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-claude-home-")));
  const userProjects = join(homedir(), ".claude", "projects");
  const cwdKey = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const userProjectDir = join(userProjects, cwdKey);
  const userBefore = listTree(userProjectDir);
  const userProjectsBefore = listTree(userProjects).filter((p) => !p.includes("/"));
  const base: Options = {
    cwd, model: CLAUDE_MODEL, permissionMode: "default", maxTurns: 6, includePartialMessages: false,
    env: { ...process.env, CLAUDE_CONFIG_DIR: privateDir, ...variant.env() },
    canUseTool: async (toolName, toolInput) => (CLAUDE_ALLOWED.has(toolName) ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "experiment: read-only" }),
    ...variant.options,
  };
  log(`claude [${variant.name}] run 1 (cwd=${cwd}, CLAUDE_CONFIG_DIR=${privateDir})`);
  const first = await withTiming({}, "run1_ms", () => runClaude(READ_PROMPT, base));
  const sessionId = first.value.sessionIdFromInit ?? first.value.sessionIdFromResult;
  const privateAfterRun1 = listTree(privateDir);
  const transcriptsAfterRun1 = privateAfterRun1.filter((p) => p.startsWith("projects/") && p.endsWith(".jsonl"));
  const second = sessionId
    ? await withTiming(first.timings, "run2_ms", () => runClaude(RECALL_PROMPT, base, sessionId))
    : { value: null, timings: first.timings };
  const privateAfterRun2 = listTree(privateDir);
  const recalled = second.value ? second.value.text.includes(word) : false;
  const recalledPrefix = second.value ? second.value.text.includes(word.split("-")[0] ?? word) : false;   // model dropped the digits but clearly had the context
  const usedTools = second.value ? second.value.toolCalls.length > 0 : false;
  const userProjectsAfter = listTree(userProjects).filter((p) => !p.includes("/"));
  const userLeak = added(userBefore, listTree(userProjectDir));
  const userProjectsNewDirs = added(userProjectsBefore, userProjectsAfter);
  return {
    variant: variant.name, extraEnv: Object.keys(variant.env()), word, cwd, privateDir, cwdKey,
    run1: { ...first.value, sessionId, transcriptsInPrivate: transcriptsAfterRun1 },
    run2: second.value ? { ...second.value, recalledWord: recalled, recalledPrefixOnly: !recalled && recalledPrefix, usedTools } : null,
    privateTree: privateAfterRun2,
    transcriptsInPrivate: privateAfterRun2.filter((p) => p.startsWith("projects/") && p.endsWith(".jsonl")),
    userClaudeProjectDirNewFiles: userLeak, userClaudeProjectsNewTopLevelDirs: userProjectsNewDirs,
    pass: Boolean(sessionId) && transcriptsAfterRun1.length > 0 && recalled && !usedTools && userLeak.length === 0 && userProjectsNewDirs.length === 0,
    timings: second.timings,
  };
}

async function claudeExperiment(): Promise<Json> {
  const attempts: Json[] = [];
  for (const variant of CLAUDE_VARIANTS) {
    const result = await claudeExperimentVariant(variant);
    attempts.push(result);
    if (result.pass) break;
  }
  const working = attempts.find((a) => a.pass) ?? null;
  return { harness: "claude-code", model: CLAUDE_MODEL, pass: working !== null, workingVariant: working ? working.variant : null, attempts };
}

// ---------- experiment 2: Codex app-server ----------

type CodexTurn = { text: string; commands: string[]; completed: Json | null; errors: string[] };

function codexBinary(): string {
  const targets = parseYaml(readFileSync(join(HERE, "..", "config", "targets.yaml"), "utf8")) as { harnesses: { codex: { binary: string } } };
  return targets.harnesses.codex.binary;
}

function prepareCodexHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-codex-home-")));
  chmodSync(home, 0o700);
  const auth = join(homedir(), ".codex", "auth.json");
  if (!existsSync(auth)) throw new Error(`${auth} not found; run codex login`);
  copyFileSync(auth, join(home, "auth.json"));
  chmodSync(join(home, "auth.json"), 0o600);
  writeFileSync(join(home, "config.toml"), `approval_policy = "never"\nsandbox_mode = "read-only"\nmodel_reasoning_effort = ${JSON.stringify(CODEX_EFFORT)}\n`);
  return home;
}

type CodexSession = { child: ChildProcess; client: AppServerClient; stderr: () => string; turnDone: () => Promise<CodexTurn>; kill: () => void };

function startCodex(binary: string, home: string, cwd: string): CodexSession {
  const env = { ...stripProxy(process.env), CODEX_HOME: home };
  const child = spawn(binary, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  let turn: CodexTurn = { text: "", commands: [], completed: null, errors: [] };
  let resolveTurn: ((t: CodexTurn) => void) | null = null;
  const client = new AppServerClient(child.stdin!, child.stdout!, async (method) => {
    if (method === "mcpServer/elicitation/request") return { action: "accept", content: {} };
    return { decision: "decline" };
  }, (method, params) => {
    turn = foldCodex(turn, method, params);
    if (turn.completed && resolveTurn) { resolveTurn(turn); resolveTurn = null; }
  });
  child.on("exit", (code) => { client.fail(new Error(`app-server exited ${code}`)); if (resolveTurn) { resolveTurn({ ...turn, errors: [...turn.errors, `app-server exited ${code}`] }); resolveTurn = null; } });
  const turnDone = (): Promise<CodexTurn> => new Promise((resolve, reject) => {
    turn = { text: "", commands: [], completed: null, errors: [] };
    resolveTurn = resolve;
    setTimeout(() => { if (resolveTurn) { resolveTurn = null; reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS} ms`)); } }, TURN_TIMEOUT_MS);
  });
  return { child, client, stderr: () => stderr, turnDone, kill: () => child.kill("SIGTERM") };
}

function foldCodex(turn: CodexTurn, method: string, params: Json): CodexTurn {
  if (method === "item/completed") {
    const item = (params.item as Json) ?? {};
    if (item.type === "agentMessage") return { ...turn, text: [turn.text, String(item.text ?? "")].filter(Boolean).join("\n") };
    if (item.type === "commandExecution") return { ...turn, commands: [...turn.commands, Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "")] };
    return turn;
  }
  if (method === "turn/completed") return { ...turn, completed: params };
  if (method === "error" || method === "turn/error") return { ...turn, errors: [...turn.errors, JSON.stringify(params).slice(0, 500)] };
  return turn;
}

async function codexHandshake(s: CodexSession): Promise<void> {
  await s.client.request("initialize", { clientInfo: { name: "agentswitch-resume-experiment", version: "0.1.0" } });
  s.client.notify("initialized");
}

/** Process 1: start a thread (ephemeral as given), run one read turn, return the thread id. */
async function codexFirstProcess(binary: string, home: string, cwd: string, ephemeral: boolean): Promise<Json> {
  const s = startCodex(binary, home, cwd);
  try {
    await codexHandshake(s);
    const started = await s.client.request("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never", ephemeral, model: CODEX_MODEL });
    const threadId = String((started.thread as Json).id);
    const pending = s.turnDone();
    await s.client.request("turn/start", { threadId, input: [{ type: "text", text: READ_PROMPT }] });
    const turn = await pending;
    return { threadId, text: turn.text, commands: turn.commands, errors: turn.errors, stderr: s.stderr().slice(0, 500) };
  } finally {
    s.kill();
  }
}

const RESUME_VARIANTS = (threadId: string, cwd: string): readonly { name: string; params: Json }[] => [
  { name: "thread/resume {threadId}", params: { threadId } },
  { name: "thread/resume {threadId, cwd}", params: { threadId, cwd } },
  { name: "thread/resume {threadId, cwd, sandbox, approvalPolicy, model}", params: { threadId, cwd, sandbox: "read-only", approvalPolicy: "never", model: CODEX_MODEL } },
];

/** Process 2: fresh app-server on the same CODEX_HOME, resume the thread, ask for the word. */
async function codexSecondProcess(binary: string, home: string, cwd: string, threadId: string): Promise<Json> {
  const s = startCodex(binary, home, cwd);
  const tried: Json[] = [];
  try {
    await codexHandshake(s);
    let resumed: Json | null = null;
    let usedVariant: string | null = null;
    for (const v of RESUME_VARIANTS(threadId, cwd)) {
      try {
        resumed = await s.client.request("thread/resume", v.params);
        usedVariant = v.name;
        tried.push({ variant: v.name, ok: true });
        break;
      } catch (err) {
        tried.push({ variant: v.name, ok: false, error: errorText(err) });
      }
    }
    if (!resumed) return { resumed: false, tried, stderr: s.stderr().slice(0, 500) };
    const thread = (resumed.thread as Json) ?? {};
    const priorTurns = Array.isArray(thread.turns) ? thread.turns.length : null;
    const pending = s.turnDone();
    await s.client.request("turn/start", { threadId, input: [{ type: "text", text: RECALL_PROMPT }] });
    const turn = await pending;
    return { resumed: true, usedVariant, tried, resumedThreadId: thread.id ?? null, priorTurnsInResumeResponse: priorTurns, text: turn.text, commands: turn.commands, errors: turn.errors, stderr: s.stderr().slice(0, 500) };
  } finally {
    s.kill();
  }
}

async function codexExperiment(): Promise<Json> {
  const binary = codexBinary();
  const word = randomWord();
  const cwd = makeCwd("agentswitch-resume-codex-", word);
  const home = prepareCodexHome();
  const userSessions = join(homedir(), ".codex", "sessions");
  const userBefore = listTree(userSessions);
  const homeBefore = listTree(home);
  log(`codex process 1 (cwd=${cwd}, CODEX_HOME=${home}, ephemeral=false)`);
  const first = await withTiming({}, "process1_ms", () => codexFirstProcess(binary, home, cwd, false));
  const homeAfter1 = listTree(home);
  const threadId = String(first.value.threadId ?? "");
  log(`codex process 2 (resume ${threadId})`);
  const second: { value: Json; timings: StepTiming } = threadId
    ? await withTiming(first.timings, "process2_ms", () => codexSecondProcess(binary, home, cwd, threadId).catch((err): Json => ({ resumed: false, error: errorText(err) })))
    : { value: { resumed: false, error: "no thread id" }, timings: first.timings };
  const homeAfter2 = listTree(home);
  const recalled = typeof second.value.text === "string" && second.value.text.includes(word);
  const usedCommands = Array.isArray(second.value.commands) && second.value.commands.length > 0;

  log("codex ephemeral=true comparison (separate CODEX_HOME)");
  const ephHome = prepareCodexHome();
  const ephBefore = listTree(ephHome);
  const eph = await withTiming(second.timings, "ephemeral_compare_ms", () => codexFirstProcess(binary, ephHome, makeCwd("agentswitch-resume-codex-eph-", word), true).catch((err): Json => ({ error: errorText(err) })));
  const ephAdded = added(ephBefore, listTree(ephHome));
  const persistentAdded = added(homeBefore, homeAfter1);

  const rollouts = homeAfter2.filter((p) => p.startsWith("sessions/") && p.endsWith(".jsonl"));
  const userLeak = added(userBefore, listTree(userSessions));
  return {
    harness: "codex", model: CODEX_MODEL, effort: CODEX_EFFORT, binary, word, cwd, home,
    process1: first.value,
    process2: { ...second.value, recalledWord: recalled, usedCommands },
    homeAddedByProcess1: persistentAdded, homeAddedByProcess2: added(homeAfter1, homeAfter2), rolloutsInHome: rollouts,
    userCodexSessionsNewFiles: userLeak,
    ephemeralCompare: { home: ephHome, addedToHome: ephAdded, onlyInPersistent: persistentAdded.filter((p) => !ephAdded.includes(p)), onlyInEphemeral: ephAdded.filter((p) => !persistentAdded.includes(p)), result: eph.value },
    pass: Boolean(threadId) && second.value.resumed === true && recalled && !usedCommands && rollouts.length > 0 && userLeak.length === 0,
    timings: eph.timings,
  };
}

// ---------- main ----------

const which = process.argv[2] ?? "all";
if (!["claude", "codex", "all"].includes(which)) { console.error("usage: npx tsx scripts/resume_experiment.ts [claude|codex|all]"); process.exit(2); }
const results: Json = {};
if (which === "claude" || which === "all") results.claude = await claudeExperiment().catch((err) => ({ harness: "claude-code", pass: false, error: errorText(err) }));
if (which === "codex" || which === "all") results.codex = await codexExperiment().catch((err) => ({ harness: "codex", pass: false, error: errorText(err) }));
console.log(JSON.stringify(results, null, 2));
process.exit(0);
