/** Where a key-paying profile (docs/profiles-v0.md §3.6) is commonly sent: the choices `agentswitch config` offers
 *  before an address is typed (docs/tui-v0.md §3). Only a filling-in of the address: what is kept is the address, so a
 *  vendor that moves is typed over. Claude Code speaks Anthropic's Messages API (`ANTHROPIC_BASE_URL`, the models at
 *  `<base>/v1/models`); Codex speaks OpenAI's Responses API (its provider's `base_url`, `wire_api = "responses"`), so an
 *  address that serves only Chat Completions is no choice for it. The addresses are as each vendor's own documentation
 *  gives them for that agent. */

import type { ProfileAgent } from "./store.js";

export type Vendor = { readonly id: string; readonly name: string; readonly baseUrl: string };

export const VENDORS: Partial<Record<ProfileAgent, readonly Vendor[]>> = {
  "claude-code": [
    { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com" },
    { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api" },
    { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic" },
    { id: "moonshot", name: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.cn/anthropic" },
    { id: "zhipu", name: "Zhipu (GLM)", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
  ],
  codex: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
    { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  ],
};

/** The vendor an address is, when it is one of them. */
export function vendorOf(agent: ProfileAgent, baseUrl: string | undefined): Vendor | null {
  const list = VENDORS[agent] ?? [];
  const at = (baseUrl ?? list[0]?.baseUrl ?? "").replace(/\/+$/, "");
  return list.find((v) => v.baseUrl === at) ?? null;
}
