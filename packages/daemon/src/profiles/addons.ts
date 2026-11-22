/** What each profile has installed, and changing it (docs/profiles-v0.md "Add-Ons", 2026-11-22; user: 每个agent的 mcp
 *  和skill 有什么管理方式吗 … 可以选中profile输入安装mcp的命令给指定profile安装mcp然后可以指定profile禁用 删除mcp).
 *
 *  Read from the profile's own folder, names only: an MCP server's command is shown with what looks like a credential
 *  struck out, its environment and headers as a count. A kind a profile shares with `Default` (its folder there is a
 *  link) is said to be shared, and is changed in `Default`.
 *
 *  MCP servers are added and removed by the agent's own command, run once under each profile (`claude mcp add … -s
 *  user`, `codex mcp add …`): the agents write their own files, which they also rewrite while they run. Switched off:
 *  Claude Code has no switch for a server of the user's, so its definition is taken out with `mcp remove` and kept
 *  here (a 0600 file beside the profile), to be put back whole with `mcp add-json`; Codex has one (`enabled`) but no
 *  command for it, so the names are kept here and a terminal is started with `-c mcp_servers.<name>.enabled=false`.
 *  Skills, agents, commands, prompts and rules are files: copied between profiles and removed as files. Plugins are
 *  listed only (the agent's own `/plugin` installs them; `Copies…` takes them from `Default`). */

import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProfileAgent } from "./store.js";

export type AddonKind = "mcp" | "skills" | "plugins" | "agents" | "commands" | "prompts" | "rules";
export const ADDON_KINDS: Readonly<Record<"claude-code" | "codex", readonly AddonKind[]>> = {
  "claude-code": ["mcp", "skills", "plugins", "agents", "commands"],
  codex: ["mcp", "skills", "plugins", "prompts", "rules"],
};
/** The kinds that are files of the profile's own: copied and removed as files. */
export const FILE_KINDS: ReadonlySet<AddonKind> = new Set(["skills", "agents", "commands", "prompts", "rules"]);

export type Addon = {
  readonly kind: AddonKind;
  readonly name: string;
  readonly about?: string;
  /** It is `Default`'s, linked: changed there. */
  readonly shared: boolean;
  /** MCP servers and plugins; false: switched off under this profile. */
  readonly enabled?: boolean;
  /** An MCP server's: `stdio`, `http`, `sse`. */
  readonly transport?: string;
  /** Its command, or its address without the query: what looks like a credential is struck out. */
  readonly command?: string;
  /** How many environment variables and headers it is given (never which, never their values). */
  readonly secrets?: number;
  /** A plugin's version. */
  readonly version?: string;
};

/** Where a profile keeps things. `json`: Claude Code's `.claude.json` (the Mac's own is beside `~/.claude`, a profile's
 *  inside its folder). `kept`: what is kept here of it (the servers switched off). */
export type AddonPlace = { readonly agent: "claude-code" | "codex"; readonly id: string; readonly config: string; readonly json?: string; readonly kept: string; readonly own: boolean };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RUN_MS = 30_000;

export class AddonError extends Error {}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
function readJson(path: string): Json { try { return obj(JSON.parse(readFileSync(path, "utf8"))); } catch { return {}; } }
const isLink = (path: string): boolean => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
function entries(dir: string): string[] { try { return readdirSync(dir).filter((n) => !n.startsWith(".")).sort(); } catch { return []; } }

/** A word of a command with what looks like a credential struck out: a long run of key-like characters, a known
 *  prefix, or the value of an option that names one. */
export function shownCommand(words: readonly string[]): string {
  const out: string[] = [];
  let hide = false;
  for (const word of words) {
    const [flag, value] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, null];
    const names = /key|token|secret|passw|auth|bearer|credential/i.test(flag) && flag.startsWith("-");
    const looks = (v: string) => /^(sk-|ghp_|gho_|github_pat_|xox[abp]-|eyJ|AKIA)/.test(v) || (v.length >= 32 && /^[A-Za-z0-9_+\/=-]+$/.test(v));
    if (value !== null) out.push(names || looks(value) ? `${flag}=•••` : word);
    else if (hide || looks(word)) out.push("•••");
    else out.push(word);
    hide = value === null && names;
  }
  return out.join(" ").slice(0, 200);
}

function shownUrl(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`.slice(0, 200); } catch { return ""; }
}

function mcpOf(name: string, def: Json, enabled: boolean): Addon {
  const url = typeof def.url === "string" ? def.url : null;
  const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === "string") : [];
  const transport = typeof def.type === "string" ? def.type : url ? "http" : "stdio";
  const secrets = Object.keys(obj(def.env)).length + Object.keys(obj(def.headers)).length + Object.keys(obj(def.http_headers)).length;
  return { kind: "mcp", name, shared: false, enabled, transport, command: url ? shownUrl(url) : shownCommand([typeof def.command === "string" ? def.command : "", ...args]), ...(secrets ? { secrets } : {}) };
}

/** A skill's own line about itself: `description:` of its `SKILL.md`'s head. */
function skillAbout(dir: string): string | undefined {
  try {
    const head = readFileSync(join(dir, "SKILL.md"), "utf8").slice(0, 4000);
    const said = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim().replace(/^["']|["']$/g, "");
    return said ? said.slice(0, 140) : undefined;
  } catch { return undefined; }
}

function fileItems(place: AddonPlace, kind: AddonKind): Addon[] {
  const dir = join(place.config, kind), shared = isLink(dir);
  return entries(dir).flatMap((n): Addon[] => {
    const path = join(dir, n);
    let folder = false;
    try { folder = lstatSync(path).isDirectory(); } catch { return []; }
    if (kind === "skills") return folder ? [{ kind, name: n, shared, ...(skillAbout(path) ? { about: skillAbout(path)! } : {}) }] : [];
    if (kind === "agents" || kind === "commands" || kind === "prompts") return !folder && n.endsWith(".md") ? [{ kind, name: n.slice(0, -3), shared }] : [];
    return [{ kind, name: n, shared }];
  });
}

/** What was switched off under a profile, as kept here: Claude Code's whole definitions, Codex's names. */
type Kept = { off?: Record<string, Json> };
const kept = (place: AddonPlace): Record<string, Json> => obj(readJson(place.kept).off) as Record<string, Json>;
function keep(place: AddonPlace, off: Record<string, Json>): void {
  mkdirSync(dirname(place.kept), { recursive: true, mode: 0o700 });
  const part = `${place.kept}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify({ off } satisfies Kept, null, 2), { mode: 0o600 });
  renameSync(part, place.kept);
}
/** The names Codex is to start with switched off under a profile (launch.ts: `-c mcp_servers.<name>.enabled=false`).
 *  Only those its `config.toml` still defines: the flag for one that is gone would make a server of `enabled` alone,
 *  which Codex refuses to start with ("invalid transport"). */
export function codexMcpOff(keptFile: string, configToml: string): string[] {
  let text = "";
  try { text = readFileSync(configToml, "utf8"); } catch { return []; }
  return Object.keys(obj(readJson(keptFile).off)).filter((n) => MCP_NAME.test(n) && new RegExp(`^\\s*\\[mcp_servers\\.("?)${n}\\1[.\\]]`, "m").test(text));
}

export type Runner = (file: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv; cwd: string; input?: string }) => Promise<{ ok: boolean; out: string }>;
const run: Runner = (file, args, opts) => new Promise((resolve) => {
  const child = execFile(file, [...args], { env: opts.env, cwd: opts.cwd, timeout: RUN_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` }));
  if (opts.input !== undefined) child.stdin?.end(opts.input); else child.stdin?.end();
});

export type AddonsOptions = { readonly binaries: Partial<Record<ProfileAgent, string>>; readonly env?: NodeJS.ProcessEnv; readonly userHome?: string; readonly run?: Runner };

export class Addons {
  private readonly run: Runner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  constructor(private readonly o: AddonsOptions) { this.run = o.run ?? run; this.env = o.env ?? process.env; this.home = o.userHome ?? homedir(); }

  private binary(agent: "claude-code" | "codex"): string {
    const file = this.o.binaries[agent];
    if (!file) throw new AddonError(`${agent === "codex" ? "Codex" : "Claude Code"} is not installed on this Mac`);
    return file;
  }

  /** The agent's own command, run under the profile: its folder named, the service's own sign-ins left out. */
  private agentRun(place: AddonPlace, args: readonly string[], input?: string) {
    const env: NodeJS.ProcessEnv = { PATH: this.env.PATH, HOME: this.home, LANG: this.env.LANG, TERM: "dumb", NO_COLOR: "1" };
    if (place.agent === "claude-code" && place.own) env.CLAUDE_CONFIG_DIR = place.config;
    if (place.agent === "codex") env.CODEX_HOME = place.config;
    return this.run(this.binary(place.agent), args, { env, cwd: this.home, ...(input !== undefined ? { input } : {}) });
  }

  /** Everything a profile has. */
  async list(place: AddonPlace): Promise<Addon[]> {
    const items: Addon[] = [];
    const off = kept(place);
    if (place.agent === "claude-code") {
      const servers = obj(readJson(place.json!).mcpServers);
      for (const name of Object.keys(servers).sort()) items.push(mcpOf(name, obj(servers[name]), true));
      for (const name of Object.keys(off).sort()) if (!(name in servers)) items.push(mcpOf(name, off[name]!, false));
      for (const kind of ["skills", "agents", "commands"] as const) items.push(...fileItems(place, kind));
      const dir = join(place.config, "plugins"), shared = isLink(dir);
      const installed = obj(readJson(join(dir, "installed_plugins.json")).plugins), on = obj(readJson(join(place.config, "settings.json")).enabledPlugins);
      for (const key of Object.keys(installed).sort()) {
        const first = obj((Array.isArray(installed[key]) ? installed[key] : [])[0]);
        items.push({ kind: "plugins", name: key, shared, enabled: on[key] !== false, ...(typeof first.version === "string" ? { version: first.version } : {}) });
      }
    } else {
      const shared = isLink(join(place.config, "config.toml"));
      const listed = await this.agentRun(place, ["mcp", "list", "--json"]).catch(() => ({ ok: false, out: "" }));
      let servers: Json[] = [];
      try { const parsed: unknown = JSON.parse(listed.out.slice(listed.out.indexOf("["))); if (Array.isArray(parsed)) servers = parsed.map(obj); } catch { /* none it could list */ }
      for (const s of servers) {
        const name = typeof s.name === "string" ? s.name : "";
        if (!name || name === "browser") continue;   // AgentSwitch's own, attached to every terminal
        const t = obj(s.transport);
        items.push({ ...mcpOf(name, { type: t.type === "streamable_http" ? "http" : t.type, command: t.command, args: t.args, url: t.url, env: t.env, http_headers: t.http_headers }, s.enabled !== false && !(name in off)), shared });
      }
      for (const kind of ["skills", "prompts", "rules"] as const) items.push(...fileItems(place, kind));
      const dir = join(place.config, "plugins");
      for (const n of entries(dir)) { try { if (lstatSync(join(dir, n)).isDirectory()) items.push({ kind: "plugins", name: n, shared: isLink(dir) }); } catch { /* gone meanwhile */ } }
    }
    return items;
  }

  /** `text`: the agent's own command as the user typed it (`claude mcp add …`, `codex mcp add …`). Run under each
   *  profile; nothing is run through a shell. */
  async install(text: string, places: readonly AddonPlace[]): Promise<{ profile: string; ok: boolean; said: string }[]> {
    if (!places.length) throw new AddonError("no profile to install it in");
    const agent = places[0]!.agent;
    const read = readInstall(text, agent);
    if ("err" in read) throw new AddonError(read.err);
    const results: { profile: string; ok: boolean; said: string }[] = [];
    for (const place of places) {
      const r = await this.agentRun(place, read.args);
      // Switched off here before, and added again: it is the new one that counts.
      if (r.ok) { const off = kept(place); if (read.name in off) { delete off[read.name]; keep(place, off); } }
      results.push({ profile: place.id, ok: r.ok, said: r.ok ? "" : firstLine(r.out) });
    }
    return results;
  }

  async removeMcp(name: string, places: readonly AddonPlace[]): Promise<{ profile: string; ok: boolean; said: string }[]> {
    if (!MCP_NAME.test(name)) throw new AddonError("not an MCP server's name");
    const results: { profile: string; ok: boolean; said: string }[] = [];
    for (const place of places) {
      const off = kept(place), wasOff = name in off;
      if (wasOff) { delete off[name]; keep(place, off); }
      // Claude Code's switched-off server is here alone; Codex's is still in its config.
      if (wasOff && place.agent === "claude-code") { results.push({ profile: place.id, ok: true, said: "" }); continue; }
      const r = await this.agentRun(place, place.agent === "claude-code" ? ["mcp", "remove", name, "-s", "user"] : ["mcp", "remove", name]);
      results.push({ profile: place.id, ok: r.ok, said: r.ok ? "" : firstLine(r.out) });
    }
    return results;
  }

  async switchMcp(name: string, on: boolean, places: readonly AddonPlace[]): Promise<{ profile: string; ok: boolean; said: string }[]> {
    if (!MCP_NAME.test(name)) throw new AddonError("not an MCP server's name");
    const results: { profile: string; ok: boolean; said: string }[] = [];
    for (const place of places) {
      const off = kept(place);
      if (place.agent === "codex") {
        if (on) delete off[name]; else off[name] = {};
        keep(place, off);
        results.push({ profile: place.id, ok: true, said: "" });
        continue;
      }
      if (on) {
        const def = off[name];
        if (!def) { results.push({ profile: place.id, ok: true, said: "" }); continue; }
        // The definition goes in on stdin: its environment is not to be seen in a process list.
        const r = await this.agentRun(place, ["mcp", "add-json", name, "-", "-s", "user"], JSON.stringify(def));
        if (r.ok) { delete off[name]; keep(place, off); }
        results.push({ profile: place.id, ok: r.ok, said: r.ok ? "" : firstLine(r.out) });
      } else {
        const def = obj(obj(readJson(place.json!).mcpServers)[name]);
        if (!Object.keys(def).length) { results.push({ profile: place.id, ok: name in off, said: name in off ? "" : "it is not there" }); continue; }
        // Kept first: a server taken out and not written down would be gone.
        keep(place, { ...off, [name]: def });
        const r = await this.agentRun(place, ["mcp", "remove", name, "-s", "user"]);
        if (!r.ok) { const back = kept(place); delete back[name]; keep(place, back); }
        results.push({ profile: place.id, ok: r.ok, said: r.ok ? "" : firstLine(r.out) });
      }
    }
    return results;
  }

  /** A skill, agent, command, prompt or rule copied from one profile into others: as it is, never over one that is
   *  there, never a link. */
  copyFile(kind: AddonKind, name: string, from: AddonPlace, to: readonly AddonPlace[]): { profile: string; ok: boolean; said: string }[] {
    const source = filePath(from, kind, name);
    if (!existsSync(source)) throw new AddonError("it is not there to copy");
    return to.map((place) => {
      const target = filePath(place, kind, name);
      if (isLink(join(place.config, kind))) return { profile: place.id, ok: false, said: "shares Default's" };
      if (existsSync(target)) return { profile: place.id, ok: true, said: "has it" };
      try {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        cpSync(source, target, { recursive: true, errorOnExist: true, force: false, filter: (p) => { const s = lstatSync(p); return s.isFile() || s.isDirectory(); } });
        return { profile: place.id, ok: true, said: "" };
      } catch (err) { rmSync(target, { recursive: true, force: true }); return { profile: place.id, ok: false, said: (err as Error).message.split("\n")[0] ?? "" }; }
    });
  }

  removeFile(kind: AddonKind, name: string, places: readonly AddonPlace[]): { profile: string; ok: boolean; said: string }[] {
    return places.map((place) => {
      if (isLink(join(place.config, kind))) return { profile: place.id, ok: false, said: "shares Default's" };
      try { rmSync(filePath(place, kind, name), { recursive: true, force: true }); return { profile: place.id, ok: true, said: "" }; }
      catch (err) { return { profile: place.id, ok: false, said: (err as Error).message.split("\n")[0] ?? "" }; }
    });
  }
}

function filePath(place: AddonPlace, kind: AddonKind, name: string): string {
  if (!FILE_KINDS.has(kind)) throw new AddonError("not something kept as a file");
  if (!NAME.test(name) || name.includes("..")) throw new AddonError("not a name");
  return join(place.config, kind, kind === "agents" || kind === "commands" || kind === "prompts" ? `${name}.md` : name);
}

const firstLine = (out: string): string => (out.split("\n").map((l) => l.trim()).find(Boolean) ?? "it did not say why").slice(0, 200);

/** The words of a command line as a shell would split them — quotes and backslashes, no expansion of any kind. */
export function words(text: string): string[] | null {
  const out: string[] = [];
  let cur = "", quote: string | null = null, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { quote = c; any = true; }
    else if (c === "\\" && i + 1 < text.length) { cur += text[++i]; any = true; }
    else if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ""; any = false; }
    else cur += c;
  }
  if (quote) return null;
  if (cur || any) out.push(cur);
  return out;
}

/** The agent's own `mcp add` command read: the server's name and the arguments to run the agent with. Claude Code's
 *  is always for the user (`-s user`): the default there is the folder it is run in, which no terminal would be in. */
export function readInstall(text: string, agent: "claude-code" | "codex"): { name: string; args: string[] } | { err: string } {
  if (/[\r\n\0]/.test(text.trim())) return { err: "一条命令，写在一行里。" };
  const w = words(text.trim());
  if (!w) return { err: "引号没有配对。" };
  const cli = agent === "codex" ? "codex" : "claude";
  if (w[0] !== cli || w[1] !== "mcp" || (w[2] !== "add" && !(agent === "claude-code" && w[2] === "add-json"))) return { err: `要以 ${cli} mcp add 开头。` };
  const rest = w.slice(3);
  const valued = /^(--transport|-t|--scope|-s|--env|-e|--header|-H|--url|--bearer-token-env-var|--callback-port|--client-id)$/;
  let name: string | null = null;
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") { args.push(...rest.slice(i)); break; }
    if (agent === "claude-code" && (a === "-s" || a === "--scope")) { i++; continue; }
    if (agent === "claude-code" && a.startsWith("--scope=")) continue;
    args.push(a);
    if (a.startsWith("-")) { if (valued.test(a) && i + 1 < rest.length) args.push(rest[++i]!); continue; }
    if (name === null) name = a;
  }
  if (!name) return { err: "缺少服务名。" };
  if (!MCP_NAME.test(name)) return { err: "服务名只能用字母、数字、- 和 _。" };
  if (name === "browser") return { err: "browser 是 AgentSwitch 自己挂给每个终端的，换一个名字。" };
  if (args.filter((a) => a !== "--").length < 2 && !args.some((a) => a.startsWith("--url"))) return { err: "缺少启动命令或地址。" };
  return { name, args: ["mcp", w[2]!, ...(agent === "claude-code" ? ["-s", "user"] : []), ...args] };
}
