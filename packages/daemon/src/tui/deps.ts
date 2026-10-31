/** What `agentswitch config` (docs/tui-v0.md) is given: the service's calls it makes (client.ts, passed in by the CLI —
 *  the screen is one more face of the same HTTP API the Mac, the phone and the web console use), the gate that seals
 *  what is typed, and this node's own node.json. The screen reaches nothing else, so a test gives it fakes. */

import type { DiscoveredSkill, McpServer, Skill } from "../extensions/types.js";
import type { Keypair } from "../keeper/gateKeys.js";
import type { NodeSettings } from "../keeper/plan.js";
import type { ModelProbe } from "../profiles/apiKeys.js";
import type { AgentProfiles, Profile, ProfileAgent, ProfileKind } from "../profiles/store.js";

export type Agents = Record<ProfileAgent, AgentProfiles>;
export type ModelSettings = {
  readonly router: { readonly model: string; readonly options: readonly string[] };
  readonly default: { readonly harness: string; readonly model: string };
  readonly harnesses: Readonly<Record<string, { readonly models: readonly string[]; readonly default_model: string }>>;
  readonly restartRequired: boolean;
};
export type PolicyMode = "manual" | "auto" | "scoped" | "skip";
/** What dispatch learned of a platform (threads/platformMemory.ts), as listed. */
export type Experience = { readonly id: string; readonly origin: string; readonly text: string; readonly kind: string; readonly status: string };
export type McpServerInput = Pick<McpServer, "name" | "kind"> & Partial<Omit<McpServer, "name" | "kind">>;
export type Policy = { readonly mode: PolicyMode; readonly human: readonly string[] };

export type ConfigClient = {
  profiles(): Promise<{ agents: Agents }>;
  createProfile(agent: ProfileAgent, name: string, kind: ProfileKind, api?: { key: string; baseUrl?: string; model?: string; force?: boolean }): Promise<{ profile: Profile }>;
  setProfileApi(agent: ProfileAgent, id: string, api: { key: string | null; baseUrl: string | null; model: string | null; force?: boolean }): Promise<unknown>;
  profileModels(agent: ProfileAgent, ask: { baseUrl?: string; key?: string; profile?: string }): Promise<ModelProbe>;
  setProfileProxy(agent: ProfileAgent, id: string, proxy: { server: string | null; username?: string; password?: string; keepPassword?: boolean }): Promise<{ agents: Agents; problem?: string }>;
  checkProfile(agent: ProfileAgent, id: string): Promise<{ agents: Agents; problem?: string }>;
  setProfileSessionKey(agent: ProfileAgent, id: string, key: string | null): Promise<unknown>;
  setProfileTelemetry(agent: ProfileAgent, id: string, on: boolean): Promise<unknown>;
  setProfileColor(agent: ProfileAgent, id: string, color: string): Promise<unknown>;
  removeProfile(agent: ProfileAgent, id: string): Promise<unknown>;
  modelSettings(): Promise<ModelSettings>;
  saveModelSettings(update: { router?: { model: string }; default?: { harness: string; model: string } }): Promise<{ restartRequired: boolean }>;
  policy(): Promise<{ policy: { mode: string; human: string[] }; categories: { id: string; title: string }[] }>;
  setPolicy(policy: { mode: PolicyMode; human?: string[] }): Promise<unknown>;
  workdir(): Promise<{ path: string; default: string; problem: string | null }>;
  setWorkdir(path: string): Promise<unknown>;
  mesh(): Promise<{ keyboard: boolean; files?: boolean; changes?: boolean; tools?: boolean }>;
  setMesh(mesh: { keyboard?: boolean; tools?: boolean }): Promise<unknown>;
  node(): Promise<{ name: string; kind: string; version: string; home: string; has: string[] }>;
  context(): Promise<{ path: string; text: string; warnings: string[] }>;
  putContext(text: string): Promise<{ warnings: string[]; sealed: { label: string }[] }>;
  memory(): Promise<{ path: string; text: string; warnings: string[] }>;
  putMemory(text: string): Promise<{ warnings: string[] }>;
  platformMemory(): Promise<{ records: readonly Experience[] }>;
  forgetPlatformMemory(id: string): Promise<unknown>;
  mcp(): Promise<McpServer[]>;
  putMcp(server: McpServerInput): Promise<unknown>;
  removeMcp(name: string): Promise<unknown>;
  skills(): Promise<Skill[]>;
  skill(name: string): Promise<Skill & { content: string }>;
  putSkill(name: string, body: { content?: string; enabled?: boolean; harnesses?: string[] }): Promise<unknown>;
  removeSkill(name: string): Promise<unknown>;
  discoverSkills(): Promise<DiscoveredSkill[]>;
  importSkill(path: string): Promise<unknown>;
};

/** What a value is sealed as: the gate's label for it (mac-app `GateSealRequest`). */
export type SealLabel = "profile/api-key" | "profile/proxy" | "profile/session-key";

export type ConfigDeps = {
  readonly client: ConfigClient;
  /** The other node it shows (`--on`), read only; null: this node, where everything can be changed. */
  readonly remote: string | null;
  /** `value` sealed by this node's gate for `host` (host[:port]): the ciphertext. */
  readonly seal: (label: SealLabel, host: string, value: string) => Promise<string>;
  /** This node's node.json, and the keeper told to restart the daemon with it (false: no keeper runs). */
  readonly node: { read(): NodeSettings; write(next: NodeSettings): void; restart(): boolean };
  /** `text` edited in the user's editor (`$VISUAL`, `$EDITOR`, else vi), on the terminal the screen gives up meanwhile;
   *  `name` is the file's name (its suffix picks the editor's mode). What it was saved as. */
  readonly edit: (text: string, name: string) => Promise<string>;
  /** This node's gate's key pairs (keeper/gateKeys.ts). */
  readonly keys: { list(): Promise<Keypair[]>; create(name: string, use: boolean): Promise<Keypair[]>; use(name: string): Promise<Keypair[]>; retire(name: string): Promise<Keypair[]> };
  /** `agentswitch doctor`'s lines. */
  readonly doctor: () => Promise<string[]>;
};
