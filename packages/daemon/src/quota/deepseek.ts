/** DeepSeek balance via GET https://api.deepseek.com/user/balance. Key: $DEEPSEEK_API_KEY, else OpenCode's store. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QuotaProvider } from "./types.js";

type Json = Record<string, unknown>;

export function findDeepSeekKey(env: NodeJS.ProcessEnv = process.env, opencodeDb = join(env.HOME ?? "", ".local", "share", "opencode", "opencode.db")): string | null {
  if (env.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY;
  if (!existsSync(opencodeDb)) return null;
  try {
    const db = new DatabaseSync(opencodeDb, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM credential WHERE label = 'DeepSeek' ORDER BY time_created DESC LIMIT 1").get() as { value?: string } | undefined;
      if (!row?.value) return null;
      const parsed = JSON.parse(row.value) as { key?: string };
      return parsed.key ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** `{is_available, balance_infos:[{currency,total_balance,granted_balance,topped_up_balance}]}`.
 *  Pay-as-you-go has no "full scale": the account is usable (1) or not (0); the balance itself is shown as detail. */
export function parseBalance(body: Json): { remaining: number | null; detail: Json } {
  const infos = (body.balance_infos as Json[] | undefined) ?? [];
  const total = infos.reduce((sum, i) => sum + Number(i.total_balance ?? 0), 0);
  const available = body.is_available !== false;
  return {
    remaining: infos.length === 0 ? null : available && total > 0 ? 1 : 0,
    detail: { is_available: available, balances: infos.map((i) => ({ currency: i.currency, total: i.total_balance, granted: i.granted_balance, topped_up: i.topped_up_balance })) },
  };
}

export function deepseekQuota(opts: { key: string | null; fetchImpl?: typeof fetch; baseUrl?: string }): QuotaProvider {
  return {
    harness: "opencode",
    async read() {
      if (!opts.key) return { remaining: null, detail: {}, source: "deepseek /user/balance", error: "no DeepSeek API key (set DEEPSEEK_API_KEY or `opencode auth login`)" };
      try {
        const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? "https://api.deepseek.com"}/user/balance`, { headers: { Authorization: `Bearer ${opts.key}` } });
        if (!res.ok) return { remaining: null, detail: {}, source: "deepseek /user/balance", error: `HTTP ${res.status}` };
        return { ...parseBalance((await res.json()) as Json), source: "deepseek /user/balance", error: null };
      } catch (err) {
        return { remaining: null, detail: {}, source: "deepseek /user/balance", error: (err as Error).message };
      }
    },
  };
}
