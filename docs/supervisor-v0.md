# 监督者 v0：路由器盯着执行（2026-09-22）

补 `router-v0.md` §6 和 `background-v0.md`；现行反馈流程见 `loop-v0.md` §9。**路由模型参与审批、无进展检查、执行中问答和结果验收。代码决定介入点及边界，模型根据已有材料判断并返回 JSON。**

## 1. 四个介入点

| 介入点 | 触发 | 路由器看到 | 路由器可回 | 代码底线 |
|---|---|---|---|---|
| 审批 | 执行器请求审批（Claude `canUseTool`、Codex requestApproval） | 简报、动作、证据、最近 20 条事件、副作用计数 | `allow` / `deny` / `ask_user` | 按 §1b 用户策略处理；受保护的 daemon / gate 状态始终拒绝；路由器超时或出错 → 留给人 |
| 看门狗 | 执行中连续 `watchdog_ms`（默认 8 分钟）没有任何事件 | 简报、已用时间、最近事件摘要、活跃子 agent | `continue` / `cancel` / `ask_user` | `continue` 最多 3 次，之后强制 `ask_user`；`cancel` 按失败及副作用规则收尾，不能自动重放结果不明的操作 |
| 问答 | 执行器通过现有工具提出缺口或冲突 | 用户原话、环境上下文、简报、步骤证据、已有反馈 | 完整回答 / 转用户 | 不确定则转中文问题卡片；答复来源和状态持久化；必要问题缺答则阻塞 |
| 验收 | 执行器或循环报告完整完成 | 原始目标及验收条件、结果证据、反馈、`git status/diff --stat`、`out/` 文件列表 | `accept` / `reject`（缺什么） | 对照原始完整目标；验收错误、超时、重复拒绝都不能变成成功；继续修复仍受预算、取消及副作用限制 |

审批卡片仍然发给用户：人和路由器谁先答算谁的。事件 `approval_resolved` 多一个 `by: user | router | timeout`。

## 1b. 审批策略与追问（2026-09-22）

用户决定谁批什么，三种模式，存在 `$AGENTSWITCH_HOME/approvals.json`，任务可单独覆盖（`POST /tasks {approval: …}`）：

| 模式 | 含义 |
|---|---|
| `manual` | 全部由用户批，路由器不介入 |
| `auto` | 全权交给路由器（用户明示的授权），破坏性动作也由它批；路由器仍可回 `ask_user`。唯一例外：碰 daemon 自身状态或 gate 家目录的动作在任何模式下都直接 `deny`（`isSelfHarm`），不是审批问题 |
| `scoped` | 用户勾选保留给自己的类别，其余路由器批 |

类别（`scoped` 的 `human` 列表，按关键词/动作形态匹配）：`delete`（删文件、rm、git clean、DROP/DELETE）、`outside_cwd`（工作目录外的写入）、`shell`（任何 shell 命令）、`git_push`（push/force）、`irreversible`（支付、发送、删账号）、`browser`（浏览器提交类）。默认 `scoped`，保留 `delete`、`git_push`、`irreversible`。daemon 自身文件永远硬拒绝，不属于审批。

**追问**：路由器在分诊时若发现只有用户能补的缺口（凭据、URL、二选一的歧义），回 `{"action":"clarify","question":"…"}`；daemon 发一张「问题」卡片（审批的一种，`kind: question`，带文本框），用户作答后将带来源的问答提供给后续调度。分诊追问有次数限制，循环追问受总预算限制；10 分钟无人答或用户选择不答则停止并保留阻塞事项，不继续派发。看门狗的 `ask_user` 仍是允许/拒绝二选一。

## 1c. 执行器提问与反馈（2026-09-23）

执行者的问题先给监督者，只能根据用户原话、CONTEXT.md、步骤证据、已有反馈和简报回答；简报、自动生成的凭据字段说明及历史摘要属于可能出错的推断，不能覆盖用户明确陈述或作为新授权。执行者可以用同一个工具报告假设与现场冲突，监督者核对证据后纠正推断，不能仅因为表单出现了某字段就猜未知输入的含义。材料不足、代答不完整、出错、超时或含未知密文时转中文问题卡片；`manual` 策略直接到用户。

答复回到原工具调用，问答在 `feedback` 事件中保留来源、状态和版本，后续提问、规划、验收和派发均能看到。用户等待期间任务状态为 `waiting_approval`，答后恢复，等待期间看门狗暂停。不是每一步都要提问，也不新增固定模型调用。

| harness | 入口 | 回去的形状 |
|---|---|---|
| Claude Code | `canUseTool("AskUserQuestion", {questions})` | `updatedInput.answers = {问题原文: 选项标签}`，多选逗号连接 |
| Codex | app-server 请求 `item/tool/requestUserInput` | `{answers: {问题id: {answers: [..]}}}` |
| OpenCode | 2.0.8 没有提问工具 | 只能在最终回复里把问题说清楚（EXECUTOR.md 已写） |

三家问题统一成 `UserQuestion {id, header, text, options[], multi, secret}`（`src/engine/questions.ts`），答复 `UserAnswers = {id: string[]}`。卡片存在 `approvals` 表 `kind: question`，`evidence` 是 `{source: router|executor, questions}` 的 JSON，路由器的追问也走同一形状（`source: router`，单题 id `clarify`），答复存 `answer` 列（JSON）。API `POST /tasks/:id/answer` 接 `text`（答第一题）或 `answers`（多题按 id），少答、多答、空答都 400。

没人答（10 分钟超时，或用户点「不答」）：执行器拿到 null / `NO_ANSWER_MESSAGE`，本次执行中止，任务保存为 blocked，不继续猜测或跳过要求。取消后的迟到回答不生效，不能覆盖终态。Codex 标了 `isSecret` 的题卡片上提示填 `enc:v1:` 密文；只是核对已有字段含义时不要求重贴秘密。

## 2. 提示词原则

- 审批：只看动作是否在简报范围内、是否可逆、是否碰了简报里的禁区。不确定就 `ask_user`。
- 看门狗：分不清「在认真干活」和「卡住」时选 `continue`；只有明显绕圈（同一命令反复失败）、等一个不会来的东西、或已远超预计规模才 `cancel`。
- 问答：区分用户陈述、现场证据、模型推断；允许质疑旧简报。同一问题使用有依据的新反馈纠正旧推断，保持答复来源，不把路由器推断伪装成用户确认。
- 验收：对照原始任务目标与验收条件逐条检查，不发明新要求；结果写在回复里而不是要求的文件里算不通过。执行了一步不等于完成整个目标，验收服务失效不等于验收通过。

## 3. 不做的

- 不让路由器猜只有用户知道的信息或扩大授权；可以代答已有证据足以确定的问题（§1c）。
- 不向执行中的会话主动插话；执行者发起的现有问答可以在同一会话完成纠错，没有该工具时通过步骤结果交回循环规划。
- 不新增通用反馈 MCP 或逐场景修复状态机；每次监督调用仍返回一个 JSON，后续问答沿现有通路继续并读取之前反馈。
- 不给路由器 shell 或文件写权限；它仍只读。

## 4. 配置（targets.yaml `router.supervisor`）

```yaml
router:
  supervisor:
    approvals: true        # 替用户批（底线之外）
    watchdog_ms: 480000    # 无事件多久后看一眼；0 关闭
    acceptance: true       # done 后验收
```

## 5. 测试

纯函数：破坏性模式表、回复解析与答复完整性、未知密文拒绝。引擎使用脚本化路由器，不调用真模型；覆盖路由器批准/拒绝/转用户、人先答、看门狗及副作用限制、验收失败不算成功、连续问答与纠正跨步骤保留、无效代答转用户、必要问题缺答阻塞、取消及超时。凭据用途修复继续单独验证原目标和授权，通用反馈不放宽其条件。
