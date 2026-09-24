/** Global guidance every executor receives: AgentSwitch's notes plus secret-gate's AGENTS.md. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transferNote, type TransferGrant } from "../core/transfer.js";
import { COMMUNICATION_GUIDANCE } from "../util/communication.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const EXECUTOR_MD = resolve(HERE, "..", "..", "config", "EXECUTOR.md");
export const GATE_AGENTS_MD = resolve(HERE, "..", "..", "..", "secret-gate", "AGENTS.md");

export const FEEDBACK_GUIDANCE = `反馈与纠错：区分用户明确陈述、带证据的现场观察、模型推断。路由简报、历史摘要，以及入口自动生成的凭据字段名和布局都可能含有错误推断；不要因它们写得肯定就当成用户确认。页面存在某字段、文件存在某路径、工具接受某参数，均不能单独证明未知输入的含义或用户意图。
发现影响正确性的冲突时，暂停依赖该判断的动作，通过现有提问工具用中文反馈：原假设及来源、实际观察和证据、已完成操作、需要核对的结论。问题会先由路由器结合现有材料回答，无法确定时再转给用户（manual 模式直接转用户）。问含义或选择即可，不要求重贴已有秘密；没有提问工具时，在结果中明确报告阻塞、证据和待确认项，交回循环规划，不能宣称完成或自行跳过要求。必要问题没有有效答复就停止，不把缺答当作同意。
收到答复后保留来源；同一问题经证据核对后的新答复用于纠正旧推断，路由器推断不能覆盖用户明确陈述。结合检查点从受影响步骤继续，不重做已完成操作；结果不明的写操作先只读核对现场。无冲突时正常执行，无需每步提问或重复探测。反馈不是新的授权，不能扩大凭据 host/use 权限、替代审批或绕过提供方拒绝；凭据用途修复仍走独立校验。`;

export const CREDENTIAL_REPAIR_GUIDANCE = `凭据用途修复：TOTP 验证码和 TOTP 种子录入是不同操作。登录/完成两步验证应使用验证码，不能把种子填入验证码字段。
仅当原用户任务明确授权向当前指定目标录入 TOTP 种子，且现有密文因用途不匹配而被 gate 拒绝时，才可通过可用的 secret_repair 工具提交该任务已有 token、原目标 exact host 和 purpose="totp_seed_import"，让路由器核对原授权。修复只能使用原密文预先授予的 seed_import_hosts，不能增加站点、通配符或用途；普通 provider safeguard 不是凭据用途错误。
若工具成功返回新 token，完整复制新 token，仅重试刚失败的那个种子字段录入，继续当前会话，不重跑已经完成的业务操作。不要猜测、改造、解码 token，不要用验证码冒充种子，不要自行改 gate 配置或直接重签；修复被拒绝、无授权或工具不可用时保留拒绝并向用户说明需要明确的新输入。`;

/** The prompt every harness receives: brief, then the handoff package, then the user's environment context.
 *  A token may reach the executor as its short enc:ref: reference (gate-next-v0 §1); both count as a credential. */
const TOKEN_IN_TEXT = /enc:v1:[A-Za-z0-9_=-]{16,}|enc:ref:[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/;

/** Brief, then the user's own message when it carries tokens (the router is told not to copy tokens into the brief,
 *  so sealed values and their legend reach the executor only this way), then handoff, then CONTEXT.md; last, the
 *  active field-transfer grant, if any (the executor passes only one that is really wired into the browser gate). */
export function composePrompt(input: { brief: string; task?: string; handoffNote: string | null; context: string | null; platformMemory?: string | null; feedback?: string | null; transfer?: TransferGrant | null }): string {
  const parts = [input.brief];
  if (input.task && input.task !== input.brief && TOKEN_IN_TEXT.test(input.task)) parts.push(`The user's own message (credentials are already secret-gate tokens; copy them from here, whole. Any appended AgentSwitch credential legend and record layout are model-inferred candidates, not the user's confirmed statements):\n${input.task}`);
  if (input.handoffNote) parts.push(`Handoff from a previous attempt:\n${input.handoffNote}`);
  if (input.context?.trim()) parts.push(`User environment context (maintained by the user; enc:v1: and enc:ref: values are secret-gate tokens that only work through the gate, use them as given and never try to decode or replace them):\n${input.context.trim()}`);
  if (input.platformMemory?.trim()) parts.push(input.platformMemory);
  if (input.feedback?.trim()) parts.push(input.feedback.trim());
  if (input.transfer) parts.push(transferNote(input.transfer));
  return parts.join("\n\n");
}

/** Separates guidance from the material in a single message, as the router's resident server does. */
export const GUIDANCE_SEPARATOR = "\n\n=====\n\n";

/** The guidance at the head of the prompt message, for a path that has no other way to deliver it: OpenCode's
 *  standalone `run` (2.0.8 ignores the config file's `instructions` key; the resident server uses an instruction entry). */
export function withGuidanceHead(prompt: string, guidance: string = executorInstructions()): string {
  return `${guidance}${GUIDANCE_SEPARATOR}${prompt}`;
}

export function executorInstructions(paths: { executor?: string; gate?: string } = {}): string {
  const parts: string[] = [COMMUNICATION_GUIDANCE, FEEDBACK_GUIDANCE, CREDENTIAL_REPAIR_GUIDANCE];
  for (const p of [paths.executor ?? EXECUTOR_MD, paths.gate ?? GATE_AGENTS_MD]) {
    if (existsSync(p)) parts.push(readFileSync(p, "utf8").trim());
  }
  return parts.join("\n\n");
}
