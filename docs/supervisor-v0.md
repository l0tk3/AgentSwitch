# 监督者 v0：路由器盯着执行（2026-09-22）

补 `router-v0.md` §6 和 `background-v0.md`。一句话：**同一个路由模型在执行前后之外再多三个介入点：替用户批审批、执行中定期看一眼、结束时验收。代码定什么时候问它、它能做什么；它只回一个 JSON。**

## 1. 三个介入点

| 介入点 | 触发 | 路由器看到 | 路由器可回 | 代码底线 |
|---|---|---|---|---|
| 审批 | 执行器请求审批（Claude `canUseTool`、Codex requestApproval） | 简报、动作、证据、最近 20 条事件、副作用计数 | `allow` / `deny` / `ask_user` | 命中破坏性模式（`rm -rf`、`git push --force`、`DROP`、支付、发送、删除账号、改 daemon 配置）一律 `ask_user`，路由器无权批；路由器超时或出错 → 留给人 |
| 看门狗 | 执行中连续 `watchdog_ms`（默认 8 分钟）没有任何事件 | 简报、已用时间、最近事件摘要、活跃子 agent | `continue` / `cancel` / `ask_user` | `continue` 最多 3 次，之后强制 `ask_user`；`cancel` 走失败重派（kind `task_failed`，excerpt 是监督者的说明） |
| 验收 | 执行器报 done | 简报（含验收条件）、结果全文、`git status/diff --stat`、`out/` 文件列表 | `accept` / `reject`（缺什么） | 每个任务最多 reject 一次；reject 后按 `task_failed` 重派，交接说明带上缺失项；路由器失败 → 视为 accept |

审批卡片仍然发给用户：人和路由器谁先答算谁的。事件 `approval_resolved` 多一个 `by: user | router | timeout`。

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
