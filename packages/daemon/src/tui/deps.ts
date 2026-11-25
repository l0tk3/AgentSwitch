/** What `agentswitch config` (docs/tui-v0.md) is given: the service's calls it makes (client.ts, passed in by the CLI —
 *  the screen is one more face of the same HTTP API the Mac, the phone and the web console use), the gate that seals
 *  what is typed, and this node's own node.json. The screen reaches nothing else, so a test gives it fakes. */

import type { NodeSettings } from "../keeper/plan.js";
import type { ModelProbe } from "../profiles/apiKeys.js";
import type { AgentProfiles, Profile, ProfileAgent, ProfileKind } from "../profiles/store.js";

export type Agents = Record<ProfileAgent, AgentProfiles>;
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
  workdir(): Promise<{ path: string; default: string; problem: string | null }>;
  setWorkdir(path: string): Promise<unknown>;
  mesh(): Promise<{ keyboard: boolean }>;
  setMesh(mesh: { keyboard: boolean }): Promise<unknown>;
  node(): Promise<{ name: string; kind: string; version: string; home: string; has: string[] }>;
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
  /** `agentswitch doctor`'s lines. */
  readonly doctor: () => Promise<string[]>;
};
