/** `GET /live`: what the Mac's menu bar Live Activity shows (assistant-v0 §4, docs/design/implemented/mac-live.html) — the
 *  tasks in progress and the terminals at work or waiting for you, the waiting ones first, then the newest, each with what it waits
 *  for in a form the card can answer (allow / deny, one option), and the tasks that ended in the last minute. The phone's
 *  Live Activity follows the same rules (AgentSwitchKit LiveSummary): titles, steps and conclusions read the same on
 *  both. Built from the store and the terminal host on each call; nothing is kept. The Mac app asks every second while
 *  the service is up; local only (the remote allowlist does not list it). */

import type { Hono } from "hono";
import { homedir } from "node:os";
import { parseEvidence } from "../core/questions.js";
import type { Store } from "../engine/store.js";
import type { Approval, Task, TaskEvent, TaskStatus } from "../engine/types.js";
import { permissionTarget, type TerminalHost, type TerminalInfo } from "../terminals/host.js";
import { speakable } from "../threads/speakable.js";
import { modelName } from "../util/modelName.js";
import { withoutLegend } from "../assistant/register.js";
import type { ApiDeps } from "./shared.js";

/** A thing to answer on the card. A terminal's permission request and a task's approval: allow or deny. A task's
 *  question: one of its options when that is a whole answer (one question, one choice, nothing secret), else it is
 *  answered on the task's page. A terminal's question (AskUserQuestion, terminal-v0 §3 "选择题"): never answerable
 *  here — the card's options answer a task — so the card opens the terminal, whose question card answers it. */
export type LiveAsk =
  | { readonly kind: "permission" | "approval"; readonly id: string; readonly tool: string; readonly target: string; readonly where: string }
  | { readonly kind: "question"; readonly id: string; readonly questionId: string; readonly text: string; readonly options: readonly string[]; readonly answerable: boolean };

export type LiveRow = {
  readonly id: string;
  readonly kind: "task" | "terminal";
  /** The thread's title for its first task, else what was asked; a terminal's name. */
  readonly title: string;
  /** What it waits for, else what it is doing in plain words, else its state. */
  readonly step: string;
  /** The same in one word, for the menu bar's capsule (2026-10-03, user: 电脑上这个实时活动的设计还是老的计时器设计，改成
   *  和手机上一样; the phone's compact island since 2026-10-01): `Run`, `Edit`, `Reply`, `Allow?` — the phone's
   *  LiveSummary.doing and ToolDisplay.word, word for word. */
  readonly doing: string;
  /** The model at work (as people say it), once one has the task; a terminal's agent. */
  readonly model: string | null;
  /** A terminal's agent id (its pixel mark). */
  readonly agent: string | null;
  /** For the clock: when the task started, when the terminal asked. */
  readonly startedAt: number;
  readonly needsYou: boolean;
  readonly ask: LiveAsk | null;
};

/** A result: a task that ended, or a terminal's turn (assistant-v0 §4 "结果要提示"). `taskId` for a task, as before. */
export type LiveEnd = {
  readonly kind: "task" | "terminal"; readonly id: string; readonly taskId?: string;
  readonly title: string; readonly line: string; readonly ok: boolean; readonly at: number;
};

export type LiveSnapshot = {
  /** All of them, ordered; the card shows the first three. */
  readonly rows: readonly LiveRow[];
  /** Tasks in progress and not waiting (a terminal is a row only while it waits). */
  readonly running: number;
  /** Tasks and terminals waiting for you. */
  readonly waiting: number;
  /** Tasks and terminal turns that ended in the last ENDED_MS, the latest first (a cancelled task is not: you did it). */
  readonly ended: readonly LiveEnd[];
  /** Terminals not exited, idle or not: the Mac stays awake while one is open (app-v0 §4). */
  readonly open: number;
  readonly now: number;
};

export function mountLive(app: Hono, deps: ApiDeps): void {
  app.get("/live", (c) => c.json(liveSnapshot(deps.store, deps.terminals?.host, Date.now())));
}

export const ENDED_MS = 60_000;
const TITLE_CHARS = 28;
const STEP_CHARS = 60;
const TARGET_CHARS = 120;
const ENDED_CHARS = 90;
const TAIL = 40;
const ACTIVE: ReadonlySet<TaskStatus> = new Set(["queued", "routing", "running", "waiting_approval"]);
const ENDS = ["done", "partial", "blocked", "failed"] as const satisfies readonly TaskStatus[];
const TOKEN = /enc:(?:v1|ref):[A-Za-z0-9_=-]{8,}/g;
const HARNESS: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi", echo: "Echo" };

export function liveSnapshot(store: Store, terminals: TerminalHost | undefined, now: number): LiveSnapshot {
  const pending = new Map<string, Approval>();
  for (const a of store.pendingApprovals()) if (!pending.has(a.taskId)) pending.set(a.taskId, a);
  const tasks = store.unfinishedTasks().filter((t) => ACTIVE.has(t.status)).map((t) => taskRow(store, t, pending.get(t.id)));
  // A terminal at work counts as a task in progress does (2026-09-30); an idle or ended one does not.
  const all = terminals?.list() ?? [];
  const busy = all.filter((t) => waitsForYou(t) || t.status === "working").map(terminalRow);
  const rows = [...tasks, ...busy].sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || b.startedAt - a.startedAt);
  const waiting = rows.filter((r) => r.needsYou).length;
  const ends = [...ended(store, now), ...terminalEnds(terminals, now)].sort((a, b) => b.at - a.at).slice(0, 10);
  const open = all.filter((t) => t.status !== "exited").length;
  return { rows, running: rows.length - waiting, waiting, ended: ends, open, now };
}

/** What a terminal's sub-agent is doing, as the Live Activity says a step (`运行 git diff`); its kind before its first
 *  tool call. */
export function subagentDoing(activity: { readonly tool: string; readonly target: string } | null, cwd: string): string {
  if (!activity) return "";
  // A file in the terminal's folder by its path from there: the row is short.
  const target = activity.target.startsWith(`${cwd}/`) ? activity.target.slice(cwd.length + 1) : activity.target;
  return clip(readable(toolPhrase(activity.tool, tilde(target))), STEP_CHARS);
}

export function waitsForYou(t: TerminalInfo): boolean {
  return t.status !== "exited" && (t.status === "waiting" || t.permissions.length > 0);
}

function taskRow(store: Store, task: Task, waitingOn: Approval | undefined): LiveRow {
  const tail = store.lastEvents(task.id, TAIL);
  const needsYou = waitingOn !== undefined || task.status === "waiting_approval";
  return {
    id: task.id, kind: "task", title: liveTitle(store, task), step: step(task, waitingOn, tail), doing: taskDoing(task, needsYou, waitingOn, tail),
    model: task.model ? modelName(task.model) : null, agent: null, startedAt: task.createdAt,
    needsYou, ask: waitingOn ? taskAsk(task, waitingOn) : null,
  };
}

/** What a task is doing now in one word: waiting on a question or an approval, else the latest event that says
 *  something — a tool by its word, the model writing, planning, choosing a model — else its state. */
export function taskDoing(task: Task, needsYou: boolean, waitingOn: Approval | undefined, tail: readonly TaskEvent[]): string {
  if (needsYou) return waitingOn?.kind === "question" && (parseEvidence(waitingOn.evidence)?.questions.length ?? 0) > 0 ? "Answer" : "Allow?";
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i]!, p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case "tool_call": if (p.denied === undefined) return toolWord(typeof p.tool === "string" ? p.tool : ""); break;
      case "text": return "Reply";
      case "routed": return typeof p.clarify === "string" && p.clarify ? "Answer" : "Start";
      case "dispatched": case "redispatch": return "Start";
      case "step":
        if (p.action === "plan") return "Plan";
        if (p.action === "ask_user") return "Answer";
        if (p.action === "finish") return "Check";
        if (p.action === "dispatch") return "Start";
        break;
      default: break;
    }
  }
  return task.status === "queued" ? "Queued" : task.status === "routing" ? "Route" : "Busy";
}

function terminalRow(t: TerminalInfo): LiveRow {
  const agent = HARNESS[t.harness] ?? t.harness;
  if (!waitsForYou(t)) {
    // At work: the tool it reported last, said as people say it; the clock from when this turn began.
    const doing = t.activity ? clip(readable(toolPhrase(t.activity.tool, t.activity.target)), STEP_CHARS) : "进行中";
    return { id: t.id, kind: "terminal", title: clip(t.name || agent, TITLE_CHARS), step: doing, doing: t.activity ? toolWord(t.activity.tool) : "Think",
      model: agent, agent: t.harness, startedAt: t.statusSince || t.lastOutputAt, needsYou: false, ask: null };
  }
  const ask = t.permissions[0];
  const target = ask ? clip(readable(permissionTarget(ask.tool, ask.input)), TARGET_CHARS) : "";
  const asked = ask?.questions?.[0];
  return {
    id: t.id, kind: "terminal", title: clip(t.name || agent, TITLE_CHARS),
    step: ask ? clip(readable(ask.summary), STEP_CHARS) : "等你处理", doing: ask?.tool === "AskUserQuestion" ? "Answer" : "Allow?", model: agent, agent: t.harness,
    startedAt: ask && ask.at > 0 ? ask.at : t.statusSince || t.lastOutputAt, needsYou: true,
    ask: !ask ? null
      : asked ? { kind: "question", id: ask.id, questionId: "", text: clip(readable(asked.question), STEP_CHARS * 2), options: asked.options.map((o) => o.label), answerable: false }
      : { kind: "permission", id: ask.id, tool: ask.tool, target, where: tilde(t.cwd) },
  };
}

function taskAsk(task: Task, a: Approval): LiveAsk {
  const evidence = a.kind === "question" ? parseEvidence(a.evidence) : null;
  if (evidence) {
    const [q] = evidence.questions;
    const answerable = evidence.questions.length === 1 && !q!.multi && !q!.secret && q!.options.length > 0;
    return { kind: "question", id: a.id, questionId: q!.id, text: clip(readable(q!.text), STEP_CHARS * 2), options: q!.options.map((o) => o.label), answerable };
  }
  if (a.kind === "question") return { kind: "question", id: a.id, questionId: "", text: clip(readable(a.action), STEP_CHARS * 2), options: [], answerable: false };
  const { tool, target } = splitAction(readable(a.action));
  // An MCP tool is said as people say it (浏览器 · 点击); what it works on comes from its input when the action
  // names only the tool (Claude Code's approvals carry the input as evidence).
  const shown = /__|\.|^browser_/.test(tool) ? toolLabel(tool) : tool;
  return { kind: "approval", id: a.id, tool: shown, target: clip(target || evidenceTarget(tool, a.evidence), TARGET_CHARS), where: tilde(task.cwd) };
}

function evidenceTarget(tool: string, evidence: string): string {
  try {
    const input: unknown = JSON.parse(evidence);
    return input && typeof input === "object" ? readable(toolTarget({ tool, input }) ?? "") : "";
  } catch {
    return "";
  }
}

/** `Bash: npm test`, `item/commandExecution/requestApproval: npm test` (Codex), `Edit`: the tool and what it works on. */
export function splitAction(action: string): { tool: string; target: string } {
  const at = action.indexOf(": ");
  if (at < 0) return { tool: action.trim(), target: "" };
  const head = action.slice(0, at);
  const tool = /commandExecution|execCommand/.test(head) ? "Bash" : /fileChange|applyPatch/.test(head) ? "Edit" : head;
  return { tool, target: action.slice(at + 2).trim() };
}

/** The thread's title for the thread's first task, else the task's own request: a later task in a thread asks for
 *  something else ("pack it"), and under the thread's name every row would read the same. */
export function liveTitle(store: Store, task: Task): string {
  const own = clip(readable(task.task), TITLE_CHARS);
  const thread = task.threadId ? store.getThread(task.threadId) : undefined;
  if (!thread?.title) return own;
  const later = task.parentId !== null || store.tasksInThread(thread.id).some((t) => t.id !== task.id && t.createdAt < task.createdAt);
  return later ? own : clip(thread.title, TITLE_CHARS);
}

function step(task: Task, waitingOn: Approval | undefined, tail: readonly TaskEvent[]): string {
  if (waitingOn) {
    const question = waitingOn.kind === "question" ? parseEvidence(waitingOn.evidence)?.questions[0]?.text : undefined;
    return clip(readable(question ?? waitingOn.action), STEP_CHARS);
  }
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = plainLine(tail[i]!);
    if (line) return clip(line, STEP_CHARS);
  }
  return task.status === "routing" ? "选择模型" : task.status === "queued" ? "排队" : task.status === "waiting_approval" ? "等你处理" : "进行中";
}

/** One event as a short plain line, or null when it says nothing worth showing (raw tool output, internal states). */
export function plainLine(e: TaskEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  switch (e.type) {
    case "text": {
      const text = readable(str(p.text) ?? "").trim();
      return text ? text.split("\n")[0]! : null;
    }
    case "tool_call": return p.denied === undefined ? readable(toolLine(p)) : null;
    case "dispatched": return str(p.model) ? `已交给 ${modelName(p.model as string)}` : "开始执行";
    case "routed": {
      if (str(p.clarify)) return `等你回答：${p.clarify as string}`;
      const model = str((p.verdict as Record<string, unknown> | undefined)?.model);
      return model ? `已选定 ${modelName(model)}` : "已选定模型";
    }
    case "step":
      switch (p.action) {
        case "intake": return "已接收";
        case "plan": return "多步任务，规划中";
        case "dispatch": {
          const model = str((p.target as Record<string, unknown> | undefined)?.model);
          return `第 ${typeof p.n === "number" ? p.n : 1} 步${model ? `：交由 ${modelName(model)} 执行` : ""}`;
        }
        case "ask_user": return str(p.question) ? `等你回答：${p.question as string}` : null;
        case "finish": return "收尾检查";
        default: return null;
      }
    case "redispatch": return "重试";
    case "attempt_failed": return "一次尝试失败";
    case "queued": return "排队";
    default: return null;
  }
}

// ---- a tool call said as people say it (the phone's ToolDisplay) ----

const VERBS: Readonly<Record<string, string>> = {
  Bash: "运行", bash: "运行", shell: "运行", commandExecution: "运行",
  Read: "读取", read: "读取", Write: "写入", write: "写入",
  Edit: "修改", MultiEdit: "修改", edit: "修改", fileChange: "修改", apply_patch: "修改", patch: "修改",
  NotebookEdit: "修改笔记本", Grep: "搜索", grep: "搜索", Glob: "查找文件", glob: "查找文件", list: "列出目录",
  WebFetch: "打开网页", webfetch: "打开网页", WebSearch: "网页搜索", webSearch: "网页搜索", websearch: "网页搜索",
  Task: "子任务", Agent: "子任务", task: "子任务", subagent: "子任务",
  TodoWrite: "更新计划", todowrite: "更新计划", update_plan: "更新计划", Skill: "使用技能", skill: "使用技能",
};
const BROWSER: Readonly<Record<string, string>> = {
  navigate: "打开", navigate_back: "后退", click: "点击", type: "输入", fill_form: "填写表单", press_key: "按键",
  select_option: "选择", hover: "悬停", snapshot: "读取页面", take_screenshot: "截图", wait_for: "等待",
  evaluate: "执行脚本", tabs: "标签页", close: "关闭", file_upload: "上传文件", handle_dialog: "处理弹窗",
};
const SECRET: Readonly<Record<string, string>> = { secret_fill: "填入密文", secret_type: "填入密文", secret_repair: "修复密文", credential_repair: "修复密文" };
const TARGET_KEYS = ["url", "file_path", "filePath", "notebook_path", "path", "pattern", "query", "element", "description", "skill", "prompt"];

const WORDS: Readonly<Record<string, string>> = {
  bash: "Run", shell: "Run", commandexecution: "Run", exec_command: "Run", local_shell: "Run",
  read: "Read", view: "Read", notebookread: "Read",
  write: "Edit", edit: "Edit", multiedit: "Edit", filechange: "Edit", apply_patch: "Edit", patch: "Edit", notebookedit: "Edit",
  grep: "Search", glob: "Search", list: "Search", ls: "Search",
  webfetch: "Web", websearch: "Web", web_search: "Web",
  task: "Agents", agent: "Agents", subagent: "Agents",
  todowrite: "Plan", update_plan: "Plan", skill: "Skill", askuserquestion: "Answer",
};

/** The tool in one short word (the phone's ToolDisplay.word): title case as ui-v0 §7.2.7. */
export function toolWord(tool: string): string {
  const word = WORDS[tool] ?? WORDS[tool.toLowerCase()];
  if (word) return word;
  const [server, name] = splitTool(tool);
  if (server === "playwright" || name.startsWith("browser_")) return "Web";
  if (server?.includes("secret")) return "Sealed";
  return "Tool";
}

/** A tool and what it works on, as people say it: `运行 npm test`, `修改 /w/a.ts`, `浏览器 · 点击 发布`. */
export function toolPhrase(tool: string, target: string): string {
  const label = toolLabel(tool);
  const what = tool === "Bash" || /^(zsh|bash|sh) /.test(target) ? unwrapShell(target) : target;
  return what ? `${label} ${firstLine(what)}` : label;
}

export function toolLine(p: Record<string, unknown>): string {
  const label = toolLabel(typeof p.tool === "string" ? p.tool : "?");
  const target = toolTarget(p);
  return target ? `${label} ${target}` : label;
}

function toolLabel(tool: string): string {
  const verb = VERBS[tool] ?? VERBS[tool.toLowerCase()];
  if (verb) return verb;
  const [server, name] = splitTool(tool);
  if (!server) return tool;
  if (server === "playwright" || name.startsWith("browser_")) {
    const action = name.startsWith("browser_") ? name.slice(8) : name;
    return `浏览器 · ${BROWSER[action] ?? action}`;
  }
  if (server.includes("secret")) return SECRET[name] ?? `密文 · ${name}`;
  return `${server} · ${name}`;
}

function toolTarget(p: Record<string, unknown>): string | null {
  const input = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : undefined;
  const command = typeof p.command === "string" ? p.command : typeof input?.command === "string" ? input.command : null;
  if (command) return firstLine(unwrapShell(command));
  for (const key of TARGET_KEYS) {
    const v = input?.[key];
    if (typeof v === "string" && v) return firstLine(v);
  }
  const files = Array.isArray(input?.files) ? input.files.filter((f): f is string => typeof f === "string") : [];
  return files.length ? firstLine(files.join(", ")) : null;
}

/** `mcp__server__name`, `server.name`, `server_name` (a known server only: `apply_patch` is not one). */
function splitTool(tool: string): [string | null, string] {
  if (tool.startsWith("mcp__")) {
    const parts = tool.slice(5).split("__");
    if (parts.length >= 2) return [parts[0]!, parts.slice(1).join("__")];
  }
  const dot = tool.indexOf(".");
  if (dot >= 0) return [tool.slice(0, dot), tool.slice(dot + 1)];
  for (const server of ["playwright", "secret-gate", "secret_gate"]) if (tool.startsWith(`${server}_`)) return [server, tool.slice(server.length + 1)];
  if (tool.startsWith("browser_")) return ["playwright", tool];
  return [null, tool];
}

/** Codex's `zsh -lc '…'` wrapper off a command. */
export function unwrapShell(command: string): string {
  const m = /^(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh) -l?c (['"])([\s\S]*)\1$/.exec(command);
  return m?.[2] ? m[2] : command;
}

// ---- tasks that ended ----

function ended(store: Store, now: number): LiveEnd[] {
  const out: LiveEnd[] = [];
  for (const task of store.tasksUpdatedSince(now - ENDED_MS, ENDS, 10)) {
    // updated_at also moves when the summary arrives or the task is opened: the end is when its last state event came.
    const end = store.lastEvents(task.id, 20).reverse().find((e) => (ENDS as readonly string[]).includes(e.type));
    if (!end || end.ts < now - ENDED_MS) continue;
    const said = [task.spoken, task.speech, task.status === "done" ? task.result : task.error ?? task.result]
      .map((t) => (t ? speakable(readable(t)) : "")).find((t) => t);
    out.push({ kind: "task", id: task.id, taskId: task.id, title: liveTitle(store, task), line: clip(said ?? (task.status === "done" ? "已完成" : "未完成"), ENDED_CHARS), ok: task.status === "done", at: end.ts });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Terminals whose turn ended in the last ENDED_MS: the agent's last answer, or what went wrong. */
function terminalEnds(terminals: TerminalHost | undefined, now: number): LiveEnd[] {
  const out: LiveEnd[] = [];
  for (const t of terminals?.list() ?? []) {
    const turn = terminals?.lastTurn(t.id);
    if (!turn || turn.at < now - ENDED_MS) continue;
    const said = turn.line ? (turn.ok ? speakable(readable(turn.line)) : readable(turn.line)) : "";
    const title = clip(t.name || (HARNESS[t.harness] ?? t.harness), TITLE_CHARS);
    out.push({ kind: "terminal", id: t.id, title, line: clip(said || (turn.ok ? "这一轮已完成" : "这一轮出错结束"), ENDED_CHARS), ok: turn.ok, at: turn.at });
  }
  return out;
}

// ---- text ----

/** Stored text as a person reads it: the sealer's legend cut off, each ciphertext a lock. */
function readable(text: string): string {
  return withoutLegend(text).replace(TOKEN, "🔒");
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? text;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function tilde(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
