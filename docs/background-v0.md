# 后台任务 v0：并发、等待与 harness 内部的后台 agent（2026-09-21）

替换 `design-v0.md` §3.2 的「第一版单任务串行」和附录 B.6。一句话：**任务默认就是后台的，daemon 同时跑多条，靠三把锁保证不打架；harness 自己派出的后台 agent 由执行器盯到结束，进度以 `agent` 事件回流，任务不会在子 agent 还在跑时就报完成。**

## 1. 引擎并发模型

不再是一条 promise 链。每个任务提交即开始，经过三道闸：

| 闸 | 粒度 | 规则 |
|---|---|---|
| 全局 | daemon | 同时最多 `AGENTSWITCH_MAX_TASKS`（默认 4）个任务在路由或执行；超出的按提交顺序排队 |
| 线程 / 父任务 | thread、parent | 同一线程同时只跑一个任务；带 `parent_id` 的任务等父任务结束后才路由（它要看父任务的结果） |
| 目录 | cwd | 同一 cwd 同时只跑一个任务（B.6）。临时目录各不相同，天然并行；worktree 隔离（B.4）仍未做 |
| harness | `max_concurrent`（targets.yaml） | 派发前取该 harness 的槽位；满了就**等**，不换目标（router-v0 §4 第 4 条） |

路由可以并发（各自起一个 opencode run）。等待期间任务状态仍是 `queued`/`routing`，多一条 `waiting` 事件说明在等什么（`parent` / `thread` / `cwd` / `harness:<name>`），页面上显示。取消一个在等的任务立即生效。

线程在路由时才分配（threads-v0 §6），所以线程锁在分配之后、派发之前取；取锁顺序固定为 线程 → 目录 → harness 槽位，不会死锁。

## 2. harness 内部的后台 agent

三家都会自己派子 agent；执行器的责任是**不提前返回**，并把进度变成统一的 `agent` 事件：

```
agent {harness, agentId, status: started | progress | completed | failed | stopped, description, summary?, tokens?}
```

| harness | 信号 | 等待 |
|---|---|---|
| Claude Code | SDK `system` 消息：`task_started`（含 `is_backgrounded`、`subagent_type`）、`task_progress`（usage、summary）、`task_notification`（completed/failed/stopped + summary）、`background_tasks_changed`（当前存活集合，replace 语义） | 一次性运行的 `result` 被 CLI 扣住直到后台工作结束（held result）；释放时还没完的会被杀。执行器只需把 `result` 当结束 |
| Codex | item `collabAgentToolCall`（tool: spawnAgent/wait/closeAgent…，status inProgress→completed，`receiverThreadIds` 是子线程 id）、`subAgentActivity`（kind started/interacted/interrupted/completed，`agentThreadId`） | `turn/completed` 在所有子 agent 结束后才到 |
| OpenCode | `task` 工具的 `tool_use` 事件（同步） | 进程退出 |

`ExecutionOutcome` 多一项 `agents: {spawned, completed, failed}`，进 `done` 事件和战绩。取消任务 = 杀 harness 进程，子 agent 随之结束（Claude 对一次性运行在中断时也是杀后台任务，fail-closed）。

## 3. 不做的

- 不给用户单独「把某个子 agent 放后台 / 停掉」的按钮：那是 harness 内部的事，我们只看整条任务。
- 不做跨任务的子 agent 共享或复用。
- 不做 worktree 自动隔离（仍是 B.4 的待办），所以同 cwd 串行。

## 4. 测试

| 层 | 内容 | 调云模型？ |
|---|---|---|
| 纯 | `Semaphore` / `KeyedLock`：FIFO、AbortSignal 取消、释放后唤醒 | 否 |
| 引擎 | 两个临时目录任务并行（总耗时 < 两者之和）；同 cwd 串行；`max_concurrent` 1 的 harness 串行、2 的并行；`waiting` 事件；父任务未完时追问等待；等待中取消 | 否 |
| 执行器折叠 | Claude `task_*` 消息 → agent 事件与计数；Codex `collabAgentToolCall` / `subAgentActivity` → 同上；OpenCode `task` 工具 | 否 |
| 真跑 | 让 Claude 用 Task 工具起一个后台子 agent 并只在它完成后回答，断言 done 事件晚于 agent completed | 是，`scripts/` |
