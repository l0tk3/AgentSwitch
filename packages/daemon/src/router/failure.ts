/** Classify how an execution ended. Pattern table, no model involved (router-v0 §6.2). The outcome vocabulary itself
 *  (ExecutionOutcome, FailureKind, side effects, refusal detection) lives in core/outcome.ts. */

import { detectRefusal, type ExecutionOutcome, type FailureKind } from "../core/outcome.js";
import { ATTEMPT_EXCERPT_CHARS } from "../core/limits.js";

const QUOTA = /(rate.?limit|insufficient (?:balance|credits|quota|funds)|quota (?:exceeded|exhausted)|usage limit|out of credits|balance is (?:zero|0)|too many requests|余额不足|额度(用完|不足|已满)|配额)/i;
const TRANSPORT = /(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|proxy (?:error|connect|refused|failure)|tunnel (?:failed|error)|CERTIFICATE_VERIFY_FAILED|self.signed certificate|TLS|SSL|socket hang up|network (?:error|unreachable)|connection (?:refused|reset|closed)|代理(错误|连接失败|不可用)|网络(错误|不可达))/i;

export function classifyFailure(outcome: ExecutionOutcome): FailureKind | null {
  if (outcome.gateDenied) return "gate_denied";
  if (outcome.gateUnavailable) return "gate_unavailable";
  if (detectRefusal(outcome)) return "refusal";
  if (outcome.ok) return null;
  const status = outcome.httpStatus;
  const text = `${outcome.stderr ?? ""}\n${outcome.lastText ?? ""}`;
  if (status === 429 || status === 402) return "quota";
  if (QUOTA.test(text)) return "quota";
  if (outcome.timedOut && !text.trim()) return "transport";
  if (TRANSPORT.test(text) || (status !== undefined && status >= 500)) return "transport";
  if (outcome.exitCode !== undefined && outcome.exitCode !== null && outcome.exitCode !== 0 && !text.trim()) return "transport";
  if (outcome.timedOut) return "transport";
  if (outcome.exitCode === 0 || outcome.lastText) return "task_failed";
  return "unknown";
}

/** Short, single-line excerpt for logs and the router; the caller redacts before use. */
export function excerpt(outcome: ExecutionOutcome, max = ATTEMPT_EXCERPT_CHARS): string {
  const text = (outcome.lastText?.trim() || outcome.stderr?.trim() || "").replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
