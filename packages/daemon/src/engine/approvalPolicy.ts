/** Who answers an approval (docs/supervisor-v0.md §1b): the user for everything (manual), the router for
 *  everything (auto, the user's explicit grant), or the router except the categories the user keeps (scoped). Or
 *  nobody (skip, docs/control-v0.md §1): every approval an executor raises is allowed at once; the protected folders,
 *  the read-only steps and the questions to the user are not approvals and still apply. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

export const CATEGORIES = ["delete", "outside_cwd", "shell", "git_push", "irreversible", "browser"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_TITLES: Record<Category, string> = {
  delete: "删除文件或数据（rm、git clean、DROP/DELETE）",
  outside_cwd: "写入工作目录以外的文件",
  shell: "任何 shell 命令",
  git_push: "git push / 强制推送",
  irreversible: "支付、发送消息或邮件、删除账号",
  browser: "浏览器中的提交操作",
};

export const ApprovalPolicy = z.object({
  mode: z.enum(["manual", "auto", "scoped", "skip"]).default("scoped"),
  /** scoped only: categories the user answers personally. */
  human: z.array(z.enum(CATEGORIES)).default(["delete", "git_push", "irreversible"]),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;
export const DEFAULT_POLICY: ApprovalPolicy = ApprovalPolicy.parse({});

const MATCH: Record<Category, RegExp> = {
  delete: /(\brm\b|\bunlink\b|\brmdir\b|\bgit\s+(clean|branch\s+-D|reset\s+--hard)\b|\b(drop|truncate)\s+(table|database|schema)\b|\bDELETE\s+FROM\b|删除|移除|\bdel\b)/i,
  outside_cwd: /outside cwd/i,
  shell: /^(Bash:|item\/commandExecution|execCommandApproval|bash:)/i,
  git_push: /\bgit\s+push\b/i,
  irreversible: /(支付|付款|转账|下单|purchase|checkout|\bpay(ment)?\b|transfer\s+funds|发送|群发|send\s+(mail|email|message|sms)|发短信|post\s+to|删除账号|注销|delete\s+(my\s+)?account|deactivate|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b)/i,
  browser: /(browser_(click|type|submit|press)|secret_fill|playwright|submit\s+(the\s+)?form|点击提交|登录)/i,
};

/** Categories an action falls into; empty when none matches. */
export function categoriesOf(action: string, evidence = ""): Category[] {
  const text = `${action}\n${evidence}`;
  return CATEGORIES.filter((c) => MATCH[c].test(text));
}

/** "user": only the user answers. "router": the supervisor may answer (the user still can, first answer wins). */
export function whoAnswers(policy: ApprovalPolicy, action: string, evidence = ""): { who: "user" | "router"; because: string } {
  if (policy.mode === "manual") return { who: "user", because: "manual mode" };
  if (policy.mode === "auto" || policy.mode === "skip") return { who: "router", because: `${policy.mode} mode` };
  const kept = categoriesOf(action, evidence).filter((c) => policy.human.includes(c));
  return kept.length ? { who: "user", because: `reserved: ${kept.join(", ")}` } : { who: "router", because: "scoped mode, not reserved" };
}

export function loadPolicy(path: string | undefined): ApprovalPolicy {
  if (!path || !existsSync(path)) return DEFAULT_POLICY;
  try { return ApprovalPolicy.parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch (err) {
    // A broken policy file must not quietly widen what the router may approve: fall back to the user answering everything.
    console.error(`approval policy ${path} unreadable (${(err as Error).message}); using manual mode until it is fixed`);
    return { mode: "manual", human: [] };
  }
}

export function savePolicy(path: string, policy: ApprovalPolicy): void {
  writeFileSync(path, JSON.stringify(policy, null, 2), { mode: 0o600 });
}
