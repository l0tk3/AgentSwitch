/** What a Claude Code profile of its own takes from `Default` (docs/profiles-v0.md §3.8): skills, commands, agents,
 *  MCP servers, plugins, the global instructions, the model and interface preferences, the status line. Each is a
 *  copy made when it is ticked — at creation, or later from the profile's `Copied Items…` — and never follows
 *  `Default` afterwards. Only names reach a client: no MCP address, header, environment value or file content. */

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

export type ClaudeCopies = {
  readonly skills?: readonly string[] | undefined;
  readonly mcpServers?: readonly string[] | undefined;
  readonly commands?: readonly string[] | undefined;
  readonly agents?: readonly string[] | undefined;
  /** Installed plugins, by their key (`name@marketplace`). */
  readonly plugins?: readonly string[] | undefined;
  readonly instructions?: boolean | undefined;
  readonly preferences?: boolean | undefined;
  /** `statusLine` of `settings.json` (what a plugin like claude-hud draws through). */
  readonly statusLine?: boolean | undefined;
};
/** What can be taken from `Default`, or what a profile holds: the same shape, every field said. */
export type ClaudeCopyList = {
  readonly skills: string[]; readonly mcpServers: string[]; readonly commands: string[]; readonly agents: string[]; readonly plugins: string[];
  readonly instructions: boolean; readonly preferences: boolean; readonly statusLine: boolean;
};

const FOLDERS = ["skills", "commands", "agents"] as const;
const LISTS = [...FOLDERS, "mcpServers", "plugins"] as const;
const PREFERENCES = ["model", "effortLevel", "language", "outputStyle", "theme", "respectGitignore", "alwaysThinkingEnabled"] as const;
type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function object(path: string): Json {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(value) ? value : {};
  } catch { return {}; }
}
const sub = (value: unknown): Json => (isObject(value) ? value : {});
/** A settings file written whole, never half: beside it first, then in its place. */
function writeObject(path: string, value: Json): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}
const within = (path: string, root: string): boolean => resolve(path).startsWith(resolve(root) + sep);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Links and special files are never copied: a link could lead to another account's files. */
function check(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("所选内容不能包含符号链接或特殊文件。");
  if (stat.isDirectory()) for (const name of readdirSync(path)) check(join(path, name));
}
function available(path: string): boolean {
  try { check(path); return true; } catch { return false; }
}
function names(root: string): string[] {
  try {
    if (lstatSync(root).isSymbolicLink()) return [];
    return readdirSync(root).filter((name) => !name.startsWith(".")).sort();
  } catch { return []; }
}

/** A copy nothing writes to afterwards (skills, commands, agents, the instructions). */
function copyReadonly(source: string, target: string): void {
  check(source);
  if (lstatSync(source).isDirectory()) {
    mkdirSync(target, { mode: 0o700 });
    for (const name of readdirSync(source)) copyReadonly(join(source, name), join(target, name));
    chmodSync(target, 0o555);
  } else {
    copyFileSync(source, target);
    chmodSync(target, (lstatSync(source).mode & 0o111) ? 0o555 : 0o444);
  }
}
/** A copy the profile owns (a plugin, its marketplace): Claude Code updates these in place. */
function copyOwned(source: string, target: string): void {
  if (lstatSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(source)) copyOwned(join(source, name), join(target, name));
  } else {
    copyFileSync(source, target);
    chmodSync(target, (lstatSync(source).mode & 0o777) | 0o600);
  }
}
/** A folder or file gone, read-only or not. */
function remove(path: string): void {
  const loosen = (p: string) => {
    const stat = lstatSync(p);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    chmodSync(p, 0o700);
    for (const name of readdirSync(p)) loosen(join(p, name));
  };
  try { loosen(path); } catch { /* not there */ }
  rmSync(path, { recursive: true, force: true });
}

// MARK: plugins

/** Claude Code's record of the plugins in a configuration folder (`plugins/installed_plugins.json`, measured on
 *  2.1.325): `plugins["name@marketplace"]` is a list of installs, each with the folder it is in (`installPath`, under
 *  `plugins/cache/`). A plugin loads only while its marketplace is known too (`plugins/known_marketplaces.json`, its
 *  folder under `plugins/marketplaces/`) — without it: `failed to load — Marketplace … not found`. */
type PluginInstall = Json & { installPath: string };
function pluginRecord(config: string) {
  const root = join(config, "plugins");
  const file = object(join(root, "installed_plugins.json"));
  return { root, file, plugins: sub(file.plugins), markets: object(join(root, "known_marketplaces.json")) };
}
const marketOf = (key: string): string => key.slice(key.lastIndexOf("@") + 1);
/** The installs of `key` that are the user's own (not one project's), each in a folder of the cache. */
function userInstalls(record: ReturnType<typeof pluginRecord>, key: string): PluginInstall[] {
  const list = record.plugins[key];
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is PluginInstall => isObject(e) && (e.scope ?? "user") === "user" && typeof e.installPath === "string" && within(e.installPath, join(record.root, "cache")));
}
function marketFolder(record: ReturnType<typeof pluginRecord>, market: string): string | null {
  const at = sub(record.markets[market]).installLocation;
  return typeof at === "string" && within(at, join(record.root, "marketplaces")) ? at : null;
}
function copyablePlugins(config: string): string[] {
  const record = pluginRecord(config);
  return Object.keys(record.plugins).filter((key) => {
    if (!key.includes("@")) return false;
    const installs = userInstalls(record, key), market = marketFolder(record, marketOf(key));
    return installs.length > 0 && installs.every((e) => available(e.installPath)) && market !== null && available(market);
  }).sort();
}
function addPlugin(source: string, home: string, key: string): void {
  const from = pluginRecord(source), to = pluginRecord(home), market = marketOf(key);
  const installs = userInstalls(from, key).map((entry) => {
    check(entry.installPath);
    const target = join(to.root, relative(from.root, entry.installPath));
    if (!existsSync(target)) copyOwned(entry.installPath, target);
    return { ...entry, installPath: target };
  });
  const folder = marketFolder(from, market);
  if (!installs.length || !folder) throw new Error(`找不到可复制的插件：${key}`);
  if (!marketFolder(to, market)) {
    check(folder);
    const target = join(to.root, "marketplaces", relative(join(from.root, "marketplaces"), folder));
    if (!existsSync(target)) copyOwned(folder, target);
    writeObject(join(to.root, "known_marketplaces.json"), { ...to.markets, [market]: { ...sub(from.markets[market]), installLocation: target } });
  }
  mkdirSync(to.root, { recursive: true, mode: 0o700 });
  writeObject(join(to.root, "installed_plugins.json"), { ...to.file, version: to.file.version ?? from.file.version ?? 2, plugins: { ...to.plugins, [key]: installs } });
  // On, and where its marketplace comes from as `Default` declares it (so it updates as it does there).
  const settings = object(join(home, "settings.json")), declared = sub(object(join(source, "settings.json")).extraKnownMarketplaces)[market];
  writeObject(join(home, "settings.json"), { ...settings, enabledPlugins: { ...sub(settings.enabledPlugins), [key]: true },
    ...(declared === undefined ? {} : { extraKnownMarketplaces: { ...sub(settings.extraKnownMarketplaces), [market]: declared } }) });
}
/** The plugin gone from the profile; its marketplace stays (another of its plugins may be there, and it holds nothing
 *  that runs). */
function removePlugin(home: string, key: string): void {
  const record = pluginRecord(home);
  for (const entry of userInstalls(record, key)) remove(entry.installPath);
  const { [key]: _gone, ...plugins } = record.plugins;
  writeObject(join(record.root, "installed_plugins.json"), { ...record.file, plugins });
  const settings = object(join(home, "settings.json")), { [key]: _off, ...enabled } = sub(settings.enabledPlugins);
  writeObject(join(home, "settings.json"), { ...settings, enabledPlugins: enabled });
}

// MARK: what there is

function preferences(config: string): Json {
  const source = object(join(config, "settings.json"));
  return Object.fromEntries(PREFERENCES.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
}
const mcp = (file: string): Json => sub(object(file).mcpServers);

/** What `Default` has that can be copied. */
export function claudeCopyOptions(userHome: string): ClaudeCopyList {
  const config = join(userHome, ".claude");
  const folder = (name: string) => names(join(config, name)).filter((n) => available(join(config, name, n)));
  return {
    skills: folder("skills"), commands: folder("commands"), agents: folder("agents"),
    mcpServers: Object.keys(mcp(join(userHome, ".claude.json"))).sort(),
    plugins: copyablePlugins(config),
    instructions: available(join(config, "CLAUDE.md")),
    preferences: Object.keys(preferences(config)).length > 0,
    statusLine: isObject(object(join(config, "settings.json")).statusLine),
  };
}

/** What a profile's own folder holds of these kinds — copied from `Default` or put there since. */
export function claudeCopyState(userHome: string, home: string): ClaudeCopyList {
  const wanted = preferences(join(userHome, ".claude")), settings = object(join(home, "settings.json"));
  return {
    skills: names(join(home, "skills")), commands: names(join(home, "commands")), agents: names(join(home, "agents")),
    mcpServers: Object.keys(mcp(join(home, ".claude.json"))).sort(),
    plugins: Object.keys(pluginRecord(home).plugins).sort(),
    instructions: existsSync(join(home, "CLAUDE.md")),
    preferences: Object.keys(wanted).length > 0 && Object.entries(wanted).every(([key, value]) => same(settings[key], value)),
    statusLine: isObject(settings.statusLine),
  };
}

// MARK: changing it

/** `add` is in `Default`, every name of it: said before anything is written. */
function checkAdded(choices: ClaudeCopyList, add: ClaudeCopies): void {
  for (const kind of LISTS) for (const name of add[kind] ?? []) {
    if (!choices[kind].includes(name)) throw new Error(kind === "mcpServers" ? `找不到 MCP：${name}` : kind === "plugins" ? `找不到可复制的插件：${name}` : `找不到可复制的 ${kind}：${name}`);
  }
  if (add.instructions && !choices.instructions) throw new Error("Default 没有可复制的 CLAUDE.md。");
  if (add.preferences && !choices.preferences) throw new Error("Default 没有可复制的模型或界面偏好。");
  if (add.statusLine && !choices.statusLine) throw new Error("Default 没有设置状态栏。");
}

function applyAdded(userHome: string, home: string, add: ClaudeCopies): void {
  const config = join(userHome, ".claude");
  for (const folder of FOLDERS) for (const name of new Set(add[folder] ?? [])) {
    if (lstatSync(join(config, folder)).isSymbolicLink()) throw new Error("复制源已变为符号链接，请重新选择。");
    mkdirSync(join(home, folder), { recursive: true, mode: 0o700 });
    remove(join(home, folder, name));
    copyReadonly(join(config, folder, name), join(home, folder, name));
  }
  if (add.instructions) { remove(join(home, "CLAUDE.md")); copyReadonly(join(config, "CLAUDE.md"), join(home, "CLAUDE.md")); }
  const servers = [...new Set(add.mcpServers ?? [])];
  if (servers.length) {
    const from = mcp(join(userHome, ".claude.json")), file = object(join(home, ".claude.json"));
    writeObject(join(home, ".claude.json"), { ...file, mcpServers: { ...sub(file.mcpServers), ...Object.fromEntries(servers.map((name) => [name, from[name]])) } });
  }
  if (add.preferences || add.statusLine) {
    const settings = object(join(home, "settings.json"));
    writeObject(join(home, "settings.json"), { ...settings, ...(add.preferences ? preferences(config) : {}), ...(add.statusLine ? { statusLine: object(join(config, "settings.json")).statusLine } : {}) });
  }
  for (const key of new Set(add.plugins ?? [])) addPlugin(config, home, key);
}

function applyRemoved(userHome: string, home: string, gone: ClaudeCopies): void {
  for (const folder of FOLDERS) for (const name of new Set(gone[folder] ?? [])) remove(join(home, folder, name));
  if (gone.instructions) remove(join(home, "CLAUDE.md"));
  const servers = new Set(gone.mcpServers ?? []);
  if (servers.size) {
    const file = object(join(home, ".claude.json"));
    writeObject(join(home, ".claude.json"), { ...file, mcpServers: Object.fromEntries(Object.entries(sub(file.mcpServers)).filter(([name]) => !servers.has(name))) });
  }
  if (gone.preferences || gone.statusLine) {
    const drop = new Set<string>([...(gone.preferences ? Object.keys(preferences(join(userHome, ".claude"))) : []), ...(gone.statusLine ? ["statusLine"] : [])]);
    writeObject(join(home, "settings.json"), Object.fromEntries(Object.entries(object(join(home, "settings.json"))).filter(([key]) => !drop.has(key))));
  }
  for (const key of new Set(gone.plugins ?? [])) removePlugin(home, key);
}

/** Validate everything before creating a profile. Apply the selection into its new, private home. */
export function prepareClaudeCopies(userHome: string, selection: ClaudeCopies): (home: string) => void {
  checkAdded(claudeCopyOptions(userHome), selection);
  return (home) => applyAdded(userHome, home, selection);
}

/** A profile that exists takes more from `Default` (`add`) and gives up what it holds (`remove`, by name: only what
 *  is named goes, so nothing the profile got some other way is touched unasked). Everything is checked first; what is
 *  held afterwards is the answer. */
export function changeClaudeCopies(userHome: string, home: string, change: { add?: ClaudeCopies | undefined; remove?: ClaudeCopies | undefined }): ClaudeCopyList {
  const add = change.add ?? {}, gone = change.remove ?? {};
  checkAdded(claudeCopyOptions(userHome), add);
  const held = claudeCopyState(userHome, home);
  for (const kind of LISTS) for (const name of gone[kind] ?? []) {
    if (!held[kind].includes(name)) throw new Error(`这个配置里没有：${name}`);
  }
  applyRemoved(userHome, home, gone);
  applyAdded(userHome, home, add);
  return claudeCopyState(userHome, home);
}
