/** What this node lets the nodes and phones paired with it do beyond the remote list's own rules (docs/mesh-v0.md §10):
 *  keystrokes as they are into a terminal; reading this node's files, and how much of them each device may read
 *  (docs/files-v0.md §7.5); tool terminals (docs/yazi-v0.md §3). Set on the node itself, like everything a node decides about itself; kept in
 *  `$AGENTSWITCH_HOME/mesh.json`. */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { DEFAULT_SCOPE, MAX_SCOPE_FOLDERS, type FileScope, type ScopeMode } from "../files/browse.js";

export type MeshSettings = {
  /** A paired node may send keystrokes as they are (`POST /terminals/:id/write`): what a real terminal screen types
   *  with. Off, a paired node has the reply box and the named keys, as a phone does. */
  readonly keyboard: boolean;
  /** Paired devices may read this node's files (`/files…`, a reply's `{path}`). Off, none may; this node's own screens
   *  always may. */
  readonly files: boolean;
  /** Paired devices may change this node's files where they may read them (docs/files-v0.md §12.5): new folders and
   *  files, renames, the Trash, files sent from a phone. Off, none may; this node's own screens always may. */
  readonly changes: boolean;
  /** Each device's reach, by its id; a device not here has `DEFAULT_SCOPE`. */
  readonly scopes: Readonly<Record<string, FileScope>>;
  /** A paired node (not a phone) may open a tool terminal (yazi) beside a terminal here, and see and use the ones open
   *  (docs/yazi-v0.md §3). Off by default: yazi runs shell commands, and nothing asks first. */
  readonly tools: boolean;
};

export const DEFAULT_MESH: MeshSettings = { keyboard: true, files: true, changes: true, scopes: {}, tools: false };
const FILE = "mesh.json";
const MODES: readonly ScopeMode[] = ["home", "all", "folders", "none"];

/** Read once per home and kept: only this process writes the file, and every keystroke of a paired node asks. */
const known = new Map<string, MeshSettings>();

/** A scope as stored, or null when it is not one (a hand-edited file). */
export function scopeFrom(raw: unknown): FileScope | null {
  if (!raw || typeof raw !== "object") return null;
  const { mode, folders } = raw as { mode?: unknown; folders?: unknown };
  if (typeof mode !== "string" || !MODES.includes(mode as ScopeMode)) return null;
  if (mode !== "folders") return { mode: mode as ScopeMode };
  const list = Array.isArray(folders) ? folders.filter((f): f is string => typeof f === "string" && isAbsolute(f) && normalize(f) === f).slice(0, MAX_SCOPE_FOLDERS) : [];
  return { mode: "folders", folders: list };
}

export function loadMesh(home: string): MeshSettings {
  const have = known.get(home);
  if (have) return have;
  const path = join(home, FILE);
  let settings = DEFAULT_MESH;
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { keyboard?: unknown; files?: unknown; changes?: unknown; scopes?: unknown; tools?: unknown };
      const scopes: Record<string, FileScope> = {};
      if (parsed.scopes && typeof parsed.scopes === "object") {
        for (const [id, raw] of Object.entries(parsed.scopes as Record<string, unknown>)) { const s = scopeFrom(raw); if (s) scopes[id] = s; }
      }
      settings = {
        keyboard: typeof parsed.keyboard === "boolean" ? parsed.keyboard : DEFAULT_MESH.keyboard,
        files: typeof parsed.files === "boolean" ? parsed.files : DEFAULT_MESH.files,
        changes: typeof parsed.changes === "boolean" ? parsed.changes : DEFAULT_MESH.changes,
        scopes,
        tools: typeof parsed.tools === "boolean" ? parsed.tools : DEFAULT_MESH.tools,
      };
    } catch { /* an unreadable file is the default */ }
  }
  known.set(home, settings);
  return settings;
}

export function saveMesh(home: string, settings: MeshSettings): void {
  const path = join(home, FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  known.set(home, settings);
}

/** What one device may read here. */
export function scopeOf(home: string, deviceId: string): FileScope {
  return loadMesh(home).scopes[deviceId] ?? DEFAULT_SCOPE;
}

/** Set one device's scope; null forgets it (the device is gone, or back to the default). */
export function setScope(home: string, deviceId: string, scope: FileScope | null): void {
  const now = loadMesh(home);
  const scopes = { ...now.scopes };
  if (scope) scopes[deviceId] = scope;
  else delete scopes[deviceId];
  saveMesh(home, { ...now, scopes });
}
