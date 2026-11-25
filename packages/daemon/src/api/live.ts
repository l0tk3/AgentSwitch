/** `GET /live`: what the Mac's menu bar Live Activity shows (docs/design/implemented/mac-live.html) — the terminals at
 *  work or waiting for you, the waiting ones first, then the newest, each with what it waits for in a form the card
 *  can answer (allow / deny), and the turns that ended in the last minute. The phone's Live Activity follows the same
 *  rules (AgentSwitchKit LiveSummary): titles, steps and conclusions read the same on both. Built from the terminal
 *  host on each call; nothing is kept. The Mac app asks every second while the service is up. A paired device may read
 *  it too (the remote list has it since the mesh: another node's screens count what waits here); this node's own
 *  screens get, beside it, what waits on the nodes it uses (`withNodes`).
 *
 *  The rows and results were the old Dispatch's tasks' too until it was removed (2026-11-25): the shape is as it was
 *  (`kind: "task"`, `approval`, an answerable `question`, `taskId`), since the apps decode it and a node of an older
 *  version still sends them; this node makes terminal rows only. */

import type { Hono } from "hono";
import { homedir } from "node:os";
import { permissionTarget, type TerminalHost, type TerminalInfo } from "../terminals/host.js";
import { speakable } from "../util/speakable.js";
import type { ApiDeps } from "./shared.js";
import { remoteCaller } from "../core/caller.js";

/** A thing to answer on the card. A terminal's permission request: allow or deny. A terminal's question
 *  (AskUserQuestion, terminal-v0 §3 "选择题"): never answerable here, so the card opens the terminal, whose question
 *  card answers it. (`approval` and an answerable question were a task's.) */
export type LiveAsk =
  | { readonly kind: "permission" | "approval"; readonly id: string; readonly tool: string; readonly target: string; readonly where: string }
  | { readonly kind: "question"; readonly id: string; readonly questionId: string; readonly text: string; readonly options: readonly string[]; readonly answerable: boolean };

/** Another node a row or a result is of (docs/mesh-v0.md §5.2 跨节点的提醒); absent: this node's own. */
export type LiveNode = { readonly id: string; readonly name: string };

export type LiveRow = {
  readonly node?: LiveNode;
  readonly id: string;
  readonly kind: "task" | "terminal";
  /** A terminal's name. */
  readonly title: string;
  /** What it waits for, else what it is doing in plain words, else its state. */
  readonly step: string;
  /** The same in one word, for the menu bar's capsule (2026-10-03, user: 电脑上这个实时活动的设计还是老的计时器设计，改成
   *  和手机上一样; the phone's compact island since 2026-10-01): `Run`, `Edit`, `Reply`, `Allow?` — the phone's
   *  LiveSummary.doing and ToolDisplay.word, word for word. */
  readonly doing: string;
  /** A terminal's agent, as people say it. */
  readonly model: string | null;
  /** A terminal's agent id (its pixel mark). */
  readonly agent: string | null;
  /** For the clock: when this turn began, when the terminal asked. */
  readonly startedAt: number;
  readonly needsYou: boolean;
  readonly ask: LiveAsk | null;
};

/** A result: a terminal's turn that ended. (`taskId` was a task's.) */
export type LiveEnd = {
  readonly node?: LiveNode;
  readonly kind: "task" | "terminal"; readonly id: string; readonly taskId?: string;
  readonly title: string; readonly line: string; readonly ok: boolean; readonly at: number;
};

export type LiveSnapshot = {
  /** All of them, ordered; the card shows the first three. */
  readonly rows: readonly LiveRow[];
  /** Terminals at work and not waiting. */
  readonly running: number;
  /** Terminals waiting for you. */
  readonly waiting: number;
  /** Terminal turns that ended in the last ENDED_MS, the latest first. */
  readonly ended: readonly LiveEnd[];
  /** Terminals not exited, idle or not: the Mac stays awake while one is open (app-v0 §4). */
  readonly open: number;
  readonly now: number;
};

export function mountLive(app: Hono, deps: ApiDeps): void {
  app.get("/live", (c) => {
    const own = liveSnapshot(deps.terminals?.host, Date.now());
    // For this node's own screens: what waits on the nodes it uses, and what ended there, beside its own (user,
    // 2026-10-11: 我用其他mac的时候没有实时通知). A paired device gets this node's own alone: no node passes another's on.
    const snapshot = remoteCaller(c.env) ? own : withNodes(own, deps.liveElsewhere?.() ?? []);
    // For the Mac's own app: the page a terminal last had opened in its own browser for a person to act on, so the
    // app can bring that window forward (docs/profiles-v0.md §5.3). Not a phone's to know.
    const shown = remoteCaller(c.env) ? null : deps.profileBrowsers?.shown ?? null;
    return c.json(shown ? { ...snapshot, shown } : snapshot);
  });
}

/** From one node: this many rows that wait, this many results. */
const NODE_ROWS = 20;
const NODE_ENDS = 10;

const text = (v: unknown, max: number): string => (typeof v === "string" ? (v.length > max ? v.slice(0, max) : v) : "");

/** `own` with what the nodes this one uses said of themselves (`others`: each node's answer to its own `GET /live`):
 *  their rows that wait for the user and their results, each marked with its node, the waiting count with them. What
 *  merely runs there is not listed (the card is for what needs you and what came of it). Their clocks are their own:
 *  each time is moved by how far that node's clock stands from this one's (`ahead`, measured when the answer was
 *  heard and held steady — not by this read's `now`: one answer is read many times, and a result whose time moved
 *  with each read was a new result to the Mac every second; user, 2026-10-12: 远程的mac任务完成之后会在我这里无限提示).
 *  Without `ahead` (a caller that kept none) the answer is taken as just heard. Another machine's JSON: read field by field,
 *  nothing taken on trust, a row a node passed on from a third never taken. */
export function withNodes(own: LiveSnapshot, others: readonly { readonly id: string; readonly name: string; readonly body: Record<string, unknown>; readonly ahead?: number }[]): LiveSnapshot {
  if (!others.length) return own;
  const rows: LiveRow[] = [];
  const ends: LiveEnd[] = [];
  for (const other of others) {
    const node: LiveNode = { id: other.id, name: other.name };
    const shift = other.ahead ?? (typeof other.body.now === "number" && Number.isFinite(other.body.now) ? own.now - other.body.now : 0);
    const time = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v + shift : own.now);
    const kind = (v: unknown): "task" | "terminal" => (v === "terminal" ? "terminal" : "task");
    for (const raw of (Array.isArray(other.body.rows) ? other.body.rows : []) as Record<string, unknown>[]) {
      if (!raw || typeof raw !== "object" || raw.node !== undefined || raw.needsYou !== true || typeof raw.id !== "string" || !raw.id) continue;
      if (rows.filter((r) => r.node?.id === node.id).length >= NODE_ROWS) break;
      rows.push({ node, id: raw.id, kind: kind(raw.kind), title: text(raw.title, TITLE_CHARS * 4), step: text(raw.step, STEP_CHARS * 4), doing: text(raw.doing, 24),
        model: typeof raw.model === "string" ? text(raw.model, 80) : null, agent: typeof raw.agent === "string" ? text(raw.agent, 40) : null,
        startedAt: time(raw.startedAt), needsYou: true, ask: askFrom(raw.ask) });
    }
    for (const raw of (Array.isArray(other.body.ended) ? other.body.ended : []) as Record<string, unknown>[]) {
      if (!raw || typeof raw !== "object" || raw.node !== undefined || typeof raw.ok !== "boolean") continue;
      const id = typeof raw.id === "string" && raw.id ? raw.id : typeof raw.taskId === "string" ? raw.taskId : "";
      if (!id) continue;
      if (ends.filter((e) => e.node?.id === node.id).length >= NODE_ENDS) break;
      ends.push({ node, kind: kind(raw.kind), id, title: text(raw.title, TITLE_CHARS * 4), line: text(raw.line, ENDED_CHARS * 4), ok: raw.ok, at: time(raw.at) });
    }
  }
  if (!rows.length && !ends.length) return own;
  const all = [...own.rows, ...rows].sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || b.startedAt - a.startedAt);
  return { ...own, rows: all, waiting: own.waiting + rows.length, ended: [...own.ended, ...ends].sort((a, b) => b.at - a.at).slice(0, 10) };
}

/** A request as another node sent it, in the card's form; null for anything else. */
function askFrom(v: unknown): LiveAsk | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== "string" || !a.id) return null;
  if (a.kind === "permission" || a.kind === "approval") return { kind: a.kind, id: a.id, tool: text(a.tool, 80), target: text(a.target, TARGET_CHARS * 4), where: text(a.where, 400) };
  if (a.kind !== "question") return null;
  const options = (Array.isArray(a.options) ? a.options : []).filter((o): o is string => typeof o === "string").slice(0, 8).map((o) => text(o, 200));
  return { kind: "question", id: a.id, questionId: text(a.questionId, 80), text: text(a.text, 600), options, answerable: a.answerable === true };
}

export const ENDED_MS = 60_000;
const TITLE_CHARS = 28;
const STEP_CHARS = 60;
const TARGET_CHARS = 120;
const ENDED_CHARS = 90;
const TOKEN = /enc:(?:v1|ref):[A-Za-z0-9_=-]{8,}/g;
const HARNESS: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi", echo: "Echo" };

export function liveSnapshot(terminals: TerminalHost | undefined, now: number): LiveSnapshot {
  // A terminal at work is a row; an idle or ended one is not.
  const all = terminals?.list() ?? [];
  const rows = all.filter((t) => waitsForYou(t) || t.status === "working").map(terminalRow).sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || b.startedAt - a.startedAt);
  const waiting = rows.filter((r) => r.needsYou).length;
  const ends = terminalEnds(terminals, now).sort((a, b) => b.at - a.at).slice(0, 10);
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

// ---- a tool call said as people say it (the phone's ToolDisplay) ----

const VERBS: Readonly<Record<string, string>> = {
  Bash: "运行", bash: "运行", shell: "运行", commandExecution: "运行",
  Read: "读取", read: "读取", Write: "写入", write: "写入",
  Edit: "修改", MultiEdit: "修改", edit: "修改", fileChange: "修改", apply_patch: "修改", patch: "修改",
  NotebookEdit: "修改笔记本", Grep: "搜索", grep: "搜索", Glob: "查找文件", glob: "查找文件", list: "列出目录",
  WebFetch: "打开网页", webfetch: "打开网页", WebSearch: "网页搜索", webSearch: "网页搜索", websearch: "网页搜索",
  Task: "子任务", Agent: "子任务", task: "子任务", subagent: "子任务",
  TodoWrite: "更新计划", todowrite: "更新计划", update_plan: "更新计划", Skill: "使用技能", skill: "使用技能",
  // Not a tool: what a terminal is doing while its agent compacts its context (terminals/host.ts, COMPACT_TOOL).
  Compact: "压缩上下文", compact: "压缩上下文",
};
const BROWSER: Readonly<Record<string, string>> = {
  navigate: "打开", navigate_back: "后退", click: "点击", type: "输入", fill_form: "填写表单", press_key: "按键",
  select_option: "选择", hover: "悬停", snapshot: "读取页面", take_screenshot: "截图", wait_for: "等待",
  evaluate: "执行脚本", tabs: "标签页", close: "关闭", file_upload: "上传文件", drop: "拖入", handle_dialog: "处理弹窗",
};
const SECRET: Readonly<Record<string, string>> = { secret_fill: "填入密文", secret_type: "填入密文", secret_repair: "修复密文", credential_repair: "修复密文" };

const WORDS: Readonly<Record<string, string>> = {
  bash: "Run", shell: "Run", commandexecution: "Run", exec_command: "Run", local_shell: "Run",
  read: "Read", view: "Read", notebookread: "Read",
  write: "Edit", edit: "Edit", multiedit: "Edit", filechange: "Edit", apply_patch: "Edit", patch: "Edit", notebookedit: "Edit",
  grep: "Search", glob: "Search", list: "Search", ls: "Search",
  webfetch: "Web", websearch: "Web", web_search: "Web",
  task: "Agents", agent: "Agents", subagent: "Agents",
  todowrite: "Plan", update_plan: "Plan", skill: "Skill", askuserquestion: "Answer", compact: "Compact",
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

/** Text as a person reads it: each ciphertext a lock. */
function readable(text: string): string {
  return text.replace(TOKEN, "🔒");
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
