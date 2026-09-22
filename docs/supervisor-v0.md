# 监督者 v0：路由器盯着执行（2026-09-22）

补 `router-v0.md` §6 和 `background-v0.md`。一句话：**同一个路由模型在执行前后之外再多三个介入点：替用户批审批、执行中定期看一眼、结束时验收。代码定什么时候问它、它能做什么；它只回一个 JSON。**

## 1. 三个介入点

| 介入点 | 触发 | 路由器看到 | 路由器可回 | 代码底线 |
|---|---|---|---|---|
| 审批 | 执行器请求审批（Claude `canUseTool`、Codex requestApproval） | 简报、动作、证据、最近 20 条事件、副作用计数 | `allow` / `deny` / `ask_user` | 命中破坏性模式（`rm -rf`、`git push --force`、`DROP`、支付、发送、删除账号、改 daemon 配置）一律 `ask_user`，路由器无权批；路由器超时或出错 → 留给人 |
| 看门狗 | 执行中连续 `watchdog_ms`（默认 8 分钟）没有任何事件 | 简报、已用时间、最近事件摘要、活跃子 agent | `continue` / `cancel` / `ask_user` | `continue` 最多 3 次，之后强制 `ask_user`；`cancel` 走失败重派（kind `task_failed`，excerpt 是监督者的说明） |
| 验收 | 执行器报 done | 简报（含验收条件）、结果全文、`git status/diff --stat`、`out/` 文件列表 | `accept` / `reject`（缺什么） | 每个任务最多 reject 一次；reject 后按 `task_failed` 重派，交接说明带上缺失项；路由器失败 → 视为 accept |

审批卡片仍然发给用户：人和路由器谁先答算谁的。事件 `approval_resolved` 多一个 `by: user | router | timeout`。

## 1b. 审批策略与追问（2026-09-22）

用户决定谁批什么，三种模式，存在 `$AGENTSWITCH_HOME/approvals.json`，任务可单独覆盖（`POST /tasks {approval: …}`）：

| 模式 | 含义 |
|---|---|
| `manual` | 全部由用户批，路由器不介入 |
| `auto` | 全权交给路由器，没有底线（用户明示的授权）；路由器仍可回 `ask_user` |
| `scoped` | 用户勾选保留给自己的类别，其余路由器批 |

类别（`scoped` 的 `human` 列表，按关键词/动作形态匹配）：`delete`（删文件、rm、git clean、DROP/DELETE）、`outside_cwd`（工作目录外的写入）、`shell`（任何 shell 命令）、`git_push`（push/force）、`irreversible`（支付、发送、删账号）、`browser`（浏览器提交类）。默认 `scoped`，保留 `delete`、`git_push`、`irreversible`。daemon 自身文件永远硬拒绝，不属于审批。

**追问**：路由器在分诊时若发现只有用户能补的缺口（凭据、URL、二选一的歧义），回 `{"action":"clarify","question":"…"}`；daemon 发一张「问题」卡片（审批的一种，`kind: question`，带文本框），用户作答后把答复追加进任务文本重新分诊；每个任务最多问两次；10 分钟无人答则任务失败并说明在等什么。看门狗的 `ask_user` 仍是允许/拒绝二选一。

## 2. 提示词原则

- 审批：只看动作是否在简报范围内、是否可逆、是否碰了简报里的禁区。不确定就 `ask_user`。
- 看门狗：分不清「在认真干活」和「卡住」时选 `continue`；只有明显绕圈（同一命令反复失败）、等一个不会来的东西、或已远超预计规模才 `cancel`。
- 验收：对照简报里的验收条件逐条打勾，不发明新要求；结果写在回复里而不是要求的文件里算不通过。

## 3. 不做的

- 不让路由器往执行中的会话里插话（Claude 一次性运行做不到，Codex 能但三家不一致）。要改方向就 cancel 后重派带交接。
- 不做多轮讨论：每个介入点一次调用、一个 JSON。
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

纯函数：破坏性模式表、三种回复的解析与默认值。引擎：echo 路由器脚本化回复，覆盖 路由器批准/拒绝/交给人、人先答、看门狗 continue→cancel→重派、验收 reject→重派一次→第二次 accept、路由器出错时的兜底。
