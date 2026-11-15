import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ClaudeCopies = {
  readonly skills?: readonly string[] | undefined;
  readonly mcpServers?: readonly string[] | undefined;
  readonly commands?: readonly string[] | undefined;
  readonly agents?: readonly string[] | undefined;
  readonly instructions?: boolean | undefined;
  readonly preferences?: boolean | undefined;
};
const FOLDERS = ["skills", "commands", "agents"] as const;
const PREFERENCES = ["model", "effortLevel", "language", "outputStyle", "theme", "respectGitignore", "alwaysThinkingEnabled"] as const;
type Json = Record<string, unknown>;
function object(path: string): Json {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function servers(userHome: string): Json {
  const value = object(join(userHome, ".claude.json")).mcpServers;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function preferences(userHome: string): Json {
  const source = object(join(userHome, ".claude", "settings.json"));
  return Object.fromEntries(PREFERENCES.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
}
function check(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("所选内容不能包含符号链接或特殊文件。");
  if (stat.isDirectory()) for (const name of readdirSync(path)) check(join(path, name));
}
function available(path: string): boolean {
  try { check(path); return true; } catch { return false; }
}
function names(userHome: string, folder: string): string[] {
  const root = join(userHome, ".claude", folder);
  try {
    if (lstatSync(root).isSymbolicLink()) return [];
    return readdirSync(root).filter((name) => !name.startsWith(".") && available(join(root, name))).sort();
  } catch { return []; }
}

/** Names and availability only: no MCP URLs, headers, environment values or file contents reach the client. */
export function claudeCopyOptions(userHome: string) {
  return {
    skills: names(userHome, "skills"), commands: names(userHome, "commands"), agents: names(userHome, "agents"),
    mcpServers: Object.keys(servers(userHome)).sort(),
    instructions: available(join(userHome, ".claude", "CLAUDE.md")),
    preferences: Object.keys(preferences(userHome)).length > 0,
  };
}

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

/** Validate everything before creating a profile. Apply the selection into its new, private home. */
export function prepareClaudeCopies(userHome: string, selection: ClaudeCopies): (home: string) => void {
  const choices = claudeCopyOptions(userHome);
  for (const folder of FOLDERS) {
    for (const name of selection[folder] ?? []) {
      if (!choices[folder].includes(name)) throw new Error(`找不到可复制的 ${folder}：${name}`);
    }
  }
  for (const name of selection.mcpServers ?? []) if (!choices.mcpServers.includes(name)) throw new Error(`找不到 MCP：${name}`);
  if (selection.instructions && !choices.instructions) throw new Error("Default 没有可复制的 CLAUDE.md。");
  if (selection.preferences && !choices.preferences) throw new Error("Default 没有可复制的模型或界面偏好。");
  const sourceServers = servers(userHome);
  const mcpServers = Object.fromEntries((selection.mcpServers ?? []).map((name) => [name, sourceServers[name]]));
  const settings = selection.preferences ? preferences(userHome) : {};
  return (home) => {
    for (const folder of FOLDERS) {
      for (const name of new Set(selection[folder] ?? [])) {
        const root = join(userHome, ".claude", folder);
        if (lstatSync(root).isSymbolicLink()) throw new Error("复制源已变为符号链接，请重新选择。");
        copyReadonly(join(root, name), join(home, folder, name));
      }
    }
    if (selection.instructions) copyReadonly(join(userHome, ".claude", "CLAUDE.md"), join(home, "CLAUDE.md"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify(Object.keys(mcpServers).length ? { mcpServers } : {}, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(join(home, "settings.json"), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  };
}
