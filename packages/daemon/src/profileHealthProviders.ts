import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ExitPool } from "./browser/exits.js";
import { probeRateLimits } from "./executors/claude.js";
import { codexQuota } from "./quota/codex.js";
import { RateLimitCache, type Window } from "./quota/windows.js";
import { proxyEnv } from "./terminals/launch.js";
import { CODEX_FILE_STORE } from "./terminals/signIn.js";
import type { ProfileAgent, ProfileStore } from "./profiles/store.js";
import type { ProfileHealth } from "./profiles/health.js";

export function subscriptionHealth(store: ProfileStore, exits: ExitPool, binaries: Partial<Record<string, string>>) {
  return async (agent: ProfileAgent, id: string, signal: AbortSignal): Promise<Omit<ProfileHealth, "checkedAt">> => {
    const binary = binaries[agent];
    if (!binary || !["claude-code", "codex"].includes(agent)) return { status: "unknown", message: "此 agent 尚不支持订阅检查，或 CLI 未安装。", windows: [] };
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC_|CODEX_|OPENAI_API_KEY)/.test(key)) env[key] = undefined;
    const home = store.homeOf(agent, id);
    if (agent === "claude-code") env.CLAUDE_CONFIG_DIR = home ?? undefined;
    else env.CODEX_HOME = home ?? undefined;
    const proxy = store.proxyOf(agent, id);
    if (proxy) Object.assign(env, proxyEnv(ExitPool.url(await exits.address(`${agent}.${id}`, proxy))));
    let windows: Window[];
    if (agent === "claude-code") {
      let stdout = "";
      try { stdout = (await promisify(execFile)(binary, ["auth", "status"], { env, signal, timeout: 6000, maxBuffer: 65536 })).stdout; }
      catch (err) { stdout = String((err as { stdout?: string }).stdout ?? ""); }
      const auth = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
      if (auth.loggedIn === false) return { status: "unhealthy", message: "尚未登录，请在这个 Profile 的终端中登录。", windows: [] };
      if (auth.loggedIn !== true) return { status: "unknown", message: "CLI 没有返回可识别的登录状态。", windows: [] };
      if (auth.authMethod && auth.authMethod !== "claude.ai") return { status: "unknown", message: "CLI 当前未使用 Claude 订阅登录，无法读取订阅用量。", windows: [] };
      const cache = new RateLimitCache();
      for (const info of await probeRateLimits(undefined, binary, signal, env)) cache.record(info);
      windows = cache.list();
    } else {
      const reading = await codexQuota({ binary, env, preserveProxy: true, timeoutMs: 20000, ...(home ? { args: CODEX_FILE_STORE } : {}) }).read(true, signal);
      if (reading.error) return { status: "unhealthy", message: "无法读取 Codex 订阅用量，请检查登录和代理。", windows: [] };
      windows = (reading.detail.windows as Window[] | undefined) ?? [];
    }
    if (!windows.length) return { status: "unknown", message: "未取得用量窗口，暂不能确认订阅健康。", windows: [] };
    const exhausted = windows.some((w) => w.usedPercent >= 100);
    return { status: exhausted ? "warning" : "healthy", message: exhausted ? "已连接，至少一个用量窗口已耗尽。" : "已连接，订阅用量读取成功。", windows };
  };
}
