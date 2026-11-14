import type { ProfileAgent, ProfileStore } from "./store.js";
import { ProfileError } from "./store.js";
import type { ApiKeys } from "./apiKeys.js";
import type { Window } from "../quota/windows.js";

export type ProfileHealth = { status: "healthy" | "warning" | "unhealthy" | "unknown"; checkedAt: number; message: string; windows: Window[] };
export class ProfileHealthChecks {
  private readonly results = new Map<string, ProfileHealth>();
  private readonly pending = new Map<string, Promise<ProfileHealth>>();
  constructor(private readonly store: ProfileStore, private readonly apiKeys: ApiKeys,
    private readonly subscription: (agent: ProfileAgent, id: string, signal: AbortSignal) => Promise<Omit<ProfileHealth, "checkedAt">>) {}

  current(): Record<string, ProfileHealth> {
    return Object.fromEntries([...this.results].filter(([key]) => {
      const at = key.lastIndexOf(".");
      return this.store.all()[key.slice(0, at) as ProfileAgent]?.profiles.some((p) => p.id === key.slice(at + 1));
    }));
  }

  check(agent: ProfileAgent, id: string): Promise<ProfileHealth> {
    if (!this.store.all()[agent].profiles.some((p) => p.id === id)) throw new ProfileError("not_found", "no such profile");
    const key = `${agent}.${id}`, pending = this.pending.get(key);
    if (pending) return pending;
    const run = this.read(agent, id).then((value) => { this.results.set(key, value); return value; }).finally(() => this.pending.delete(key));
    this.pending.set(key, run);
    return run;
  }

  private async read(agent: ProfileAgent, id: string): Promise<ProfileHealth> {
    const checkedAt = Date.now();
    try {
      const api = this.store.apiOf(agent, id);
      if (api) {
        const result = await this.apiKeys.models(agent, { profile: id, baseUrl: api.baseUrl });
        if ("models" in result) return { status: "healthy", checkedAt, message: `连接与鉴权成功，返回 ${result.models.length} 个模型。`, windows: [] };
        if ("refused" in result) return { status: "unhealthy", checkedAt, message: `鉴权被拒绝（HTTP ${result.refused}）。`, windows: [] };
        if ("unlisted" in result) return { status: "unknown", checkedAt, message: "供应商未提供可用的模型列表，尚不能确认 API 健康。", windows: [] };
        return { status: "unhealthy", checkedAt, message: "status" in result ? `接口返回 HTTP ${result.status}。` : "无法连接 API，请检查地址和代理。", windows: [] };
      }
      return { ...await this.subscription(agent, id, AbortSignal.timeout(30_000)), checkedAt };
    } catch {
      // Credential resolvers and provider errors may include sensitive response text.
      return { status: "unhealthy", checkedAt, message: "检查失败或超时，请检查登录、凭据网关和代理后重试。", windows: [] };
    }
  }
}
