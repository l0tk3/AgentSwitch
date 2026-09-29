# control-v0：权限模式、默认目录、会话监视与一批体验改进

2026-09-27 用户要求（参照 stablyai/orca 的调研，笔记见会话 scratchpad `orca-notes/`）：做完调研里的小改动（除“阻止 Mac 休眠”）和中等改动；加一个“默认跳过权限”的模式；监视本机 Claude Code、Codex、OpenCode 的所有会话；派发任务时执行器有默认目录，做项目就去项目目录；会话和它们的目录调度模型都要看得到。本文是 daemon、iPhone、Mac 三端共同的接口约定；界面按 `docs/ui-v0.md`。

## 1. 权限模式

现有三档（`engine/approvalPolicy.ts`）：`manual` 每项都问你；`scoped`（默认）调度模型代批，删除 / git push / 付款发消息留给你；`auto` 全部由调度模型代批。新增第四档：

- **`skip` 跳过权限**：执行器提的每个审批当场放行，不建卡片、不调调度模型，事件 `supervisor {kind:"approval", decision:"allow", reason:"skip-permissions mode", source:"policy", action}`。
- **仍然生效的**（这些不是“权限”，是边界）：禁区照拒——AgentSwitch 自己的数据和配置、secret-gate 密钥、本机令牌、浏览器会话目录、远程 TLS 私钥（执行器层直接拒，不走审批；AgentSwitch 自己的终端只拒网关密钥，terminal-v0 §3）；只读步骤（research / verify）照旧只放行只读命令；执行器或路由器**问你的问题**照旧来问（问题不是权限）；Codex 仍在它的沙箱里，只是它申请到沙箱外跑的命令过完禁区检查后直接放行。
- **只在 Mac 上改**：`PUT /approvals/policy` 只收本机请求（远程 403，同 `approval` 字段的规矩）；手机 `GET /approvals/policy` 只读，用来显示当前模式。
- 界面词：逐项确认（manual）· 自动（scoped，删除、推送、付款仍问你）· 全部自动（auto）· 跳过权限（skip）。选 skip 时 Mac 要二次确认，写清上面“仍然生效的”。

## 2. 默认工作目录

- 设置文件 `$AGENTSWITCH_HOME/workdir.json` `{ "path": "<绝对路径>" }`；缺省 `~/AgentSwitch`。`GET /settings/workdir` → `{path, default, problem}`（远程可读）；`PUT /settings/workdir {path}` 只收本机请求，按工作目录规则检查（不能是主目录、禁区或其上级），不存在就创建。
- 任务没给目录、也没从父任务继承时，建 `<path>/<yyyy-MM-dd>-<8 位随机>`（建目录时任务还没有 id），**不是临时目录**（`ephemeral=false`，结果留着）；任务结束时这个子目录若还是空的就删掉。给了目录（用户点名、之前用过的文件夹、会话的目录）就在那里做。
- 原来数据目录下的 `work/` 只剩显式 `ephemeral:true` 的任务和测试在用。

## 3. 会话监视

daemon 读三家本地记录（只读，不改；唯一例外是用户在会话列表里删除一段记录，见 terminal-v0 §5）：

| 执行器 | 位置 | 取什么 |
|---|---|---|
| Claude Code | `~/.claude/projects/<目录>/<id>.jsonl` | `cwd`、`gitBranch`、第一条用户消息、最后一条助手文字、时间 |
| Codex | `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` | `session_meta.cwd`、`originator`（桌面 / 命令行 / 编辑器）、首条用户消息、最后一条回复、时间 |
| OpenCode | `~/.local/share/opencode/opencode.db` 表 `session_v2` | `directory`、`title`、`time_updated`、模型 |

- 只列用户自己的会话：目录在临时目录（`/tmp`、`/private/tmp`、`/private/var/folders`）或 AgentSwitch 数据目录下的不列（那是探测、测试和 AgentSwitch 自己的执行器）。
- 进行中 = 最近 90 秒内有更新。
- `GET /sessions?limit=60` → `{sessions: SessionSummary[]}`，新到旧；`SessionSummary = {harness: "claude-code"|"codex"|"opencode", id, cwd, title, lastText, updatedAt, active, origin?, branch?, model?}`。
- `GET /sessions/:harness/:id?limit=80` → `{session: SessionSummary, messages: [{role: "user"|"assistant"|"tool", text, ts, tool?}]}`，最近的 N 条，每条截 2000 字。
- 两条都远程可读（只读）。会话内容是用户自己的，只经钉证书的通道给自己的手机，不入库、不进日志。
- **调度模型看得到**（2026-09-27 审查后改为按目录）：
  - 助理（每条消息先到这里，决定建不建任务、放在哪个目录）的输入里有一节“Mac 上的编码会话，按目录”：每个目录一行——多久前 / 是否进行中、用过哪些执行器各几个会话、每个执行器最近一个会话的标题（截 50 字、打码），最多 20 个目录。用户说“在我正在写的那个仓库里……”“接着 Codex 那个项目”时，它从这里填 `cwd`。
  - 调度模型（选执行器和模型）的任务消息里附“这个目录及其上下级里用户自己的编码会话”（同样一行一个目录），作为项目背景，不是指令。
  - 只给元数据，不给会话全文。打码（`maskSecrets`）：密文、各家密钥前缀、邮箱与 `user@host`、32 字符以上像随机串的片段（由普通名字组成的绝对路径除外）。主目录和 `/` 不列为候选目录，也不算项目的上级目录。
- **扫描**：每个执行器取最近 90 天里最新的 400 个会话；临时目录和 AgentSwitch 数据目录（Claude 按项目目录名直接跳过）在截取之前就排除，免得探测和 AgentSwitch 自己的执行器把用户的会话挤掉；以 AgentSwitch 额度探测那句话（`core/probes.ts`）开头的会话不算用户的。OpenCode 的执行器和调度模型调用与用户共用同一个数据库：AgentSwitch 自己的 agent（`OWN_OPENCODE_AGENTS`：dispatcher、oracle、summarizer、sealer 等）建的会话、AgentSwitch 记下的执行器会话 id（`thread_events` 的 `session`）、默认工作目录下的会话都不列。本机实测：Claude Code 73、Codex 153、OpenCode 37 个会话，20 个目录；首次扫描约 0.6 秒，之后约 10 毫秒。

## 4. 任务：已读、无法确认、撤回、搜索

- **已读**：任务加 `acknowledgedAt`（毫秒或 null）。`POST /tasks/:id/ack`（远程可用）记为现在。未读 = 已结束且 `acknowledgedAt < updatedAt`（或为空）。手机打开任务详情即算读过。
- **服务重启后无法确认**：daemon 启动时把没结束的任务改成 `blocked`，`blockCause: "interrupted"`，`error: "服务重启时任务仍在进行，执行进度无法确认。"`，事件 `blocked {cause:"interrupted", error}`。不自动重跑；手机上照旧可以“交给其他模型”接着做。
- **审批撤回**：执行器自己取消了一个审批请求（Claude 的 `canUseTool` 信号中止等）时，审批改为 `withdrawn`，事件 `approval_resolved {approvalId, decision:"withdrawn", status:"withdrawn", by:"executor"}`；手机上卡片消失（只显示 `pending` 的），过程里写“已撤回”。
- **搜索**：`GET /search?q=<词>&limit=30`（远程可用）→ `{results: [{taskId, title, snippet, status, updatedAt}]}`，查任务原文、结果、错误、摘要、会话标题和执行器的文字。3 个字及以上用 SQLite FTS5（trigram）；更短用子串匹配。`snippet` 里命中处用 `⟦`、`⟧` 包起来。

## 5. 只在 iPhone 上的

- 按“谁需要你”排：等你处理 → 已完成未读 → 进行中 → 其余；未读用主色小点（不加新状态色）。
- 进行中但 10 分钟以上没有新事件：状态词不变，副文案“N 分钟无更新”。
- 连接：回到前台立即探活（有地址也要确认它还通）；事件流 30 秒没收到任何字节（daemon 每 10 秒发 `: ping`）就当半开连接重连；重连不设永久上限。连接状态分级：连接中 → 重连中 → 连不上（第 N 次）→ 找不到 Mac（约 6 分钟）→ 配对已失效；设置 › Mac 加“排障”：常见原因与检查项，和“上次选择线路”放在一起。
- 过程里连续的工具调用折叠成一句（“读了 3 个文件，运行 5 条命令，搜索 2 次”），点开是逐条；任务结束后末尾一行“用时 2 分 13 秒”。
- 调研里的“通知权限先预告再申请”不适用：应用现在不申请通知权限（没有推送）。

## 6. 只在 Mac 上的

- 首次运行向导（设置窗口上的覆盖层，4 步，可跳过）：执行器装好并登录 → 配对手机（嵌现有二维码）→ 权限模式与登录时启动 → 完成。状态 `{flowVersion, lastCompletedStep, closedAt, outcome}` 存 UserDefaults；已有配对设备的老用户直接记为完成。
- 设置清单（环境页顶部，按真实状态算）：claude / codex / opencode 装好并登录、手机已配对、Tailscale 可用、「文件和文件夹」已授权、默认工作目录可用；菜单栏面板显示未完成数。
- 每个“未登录”的执行器有“登录”按钮：在“终端”里打开 `claude auth login` / `codex login` / `opencode auth login`，回来后自动重新检测。
- 权限模式与默认工作目录的设置界面（见 §1、§2）。

## 7. 落地（2026-09-27，daemon）

- 权限：`approvalPolicy.ts` 加 `skip`；`taskLoop` 的执行器审批入口在只读判断之后直接放行并记 `supervisor {source:"policy"}`；审批台 `request(..., {signal})` 在信号中止时以 `withdrawn`（`by:"executor"`）结束，Claude 的 `canUseTool` 把自己的 `options.signal` 传进来。
- 默认目录：`files/workdir.ts`；`DaemonConfig.taskFolders`（生产默认开，`AGENTSWITCH_TASK_FOLDERS=0` 关，测试不开，免得往真实主目录里建文件夹）；`GET|PUT /settings/workdir`（`api/settings.ts`）。
- 会话：`src/sessions/`（`claude.ts`、`codex.ts`、`opencode.ts`、`monitor.ts`，文件按修改时间和大小缓存，只读文件头尾；首次扫描约 0.4 秒，之后约 10 毫秒）；`DaemonConfig.watchSessions`（`AGENTSWITCH_SESSIONS=0` 关）；`api/sessions.ts`；助理输入里的“编码会话”一节最多 12 个，标题截 60 字并打码（`maskSecrets`）。
- 任务：`tasks.acknowledged_at` 列、`POST /tasks/:id/ack`；`engine/search.ts`（FTS5 trigram，搜索前增量补索引，删任务同时删索引）、`GET /search`；启动时 `engine.interruptLeftovers()`。
- 测试：`tests/loop.test.ts`（skip 与撤回）、`workdir.test.ts`、`sessions.test.ts`、`taskState.test.ts`；分层表加了 `sessions`（与 `files` 同层）。
- 补（审完两端后）：库加一次性数据迁移（`PRAGMA user_version` 计数），把已读标记上线前的任务记为已读（`acknowledged_at = updated_at`），不然老任务全是未读；因为“空的就删”被删掉的任务子目录，追问或交接到那里时开跑前补建（`restoreTaskFolder`，只认当前根目录下 `<日期>-<8 位>` 的文件夹）。

## 8. 落地（2026-09-27，两端）

- iPhone：Kit `API/ControlRoutes.swift`（`approvalPolicy`、`workdir`、`sessions`、`session`、`acknowledge`、`search`）、`Feed/Attention.swift`（未读、无法确认、排序、N 分钟无更新）、`Feed/ProcessFolding.swift`（折叠句与用时）、`Feed/SearchSnippet.swift`、`Connection/ConnectionProgress.swift` + `Troubleshooting.swift`（分级与排障），`ConnectionManager.verify()` 回前台探活，连不上时自动重试（2 秒起翻倍到 30 秒，不停），事件流 30 秒无字节重连。界面：设置 › 编码会话（按目录分组，会话详情只读；“会话”一词已给线程用了）、权限行（只读）、Mac › 默认工作目录 与 排障；任务记录按“谁需要你”排、可搜索（老 daemon 没有 `/search` 时只搜手机上已有的）；任务页打开即已读，无法确认的任务有“接着做”（交接，调度模型重选），连续两条以上工具调用折叠，结束后“用时”；连接状态条移到对话上方。
- Mac：侧栏新增「权限」（四档单选，自动档下勾类别，选跳过权限先确认并列出仍然生效的）；通用 › 默认工作目录（选择… / 恢复默认，daemon 拒绝时显示原因）；环境页顶部设置清单（未完成逐条带一个按钮：登录 / 复制命令 / 配对 / 打开或下载 Tailscale / 选择文件夹），菜单栏面板“设置还差 N 项”；登录按钮经 `osascript` 在终端里跑 `claude auth login` 等（命令作 argv 传入，不拼进脚本），回到前台自动重测；首次运行向导（4 步，可跳过，`setupWizard` 存 UserDefaults，已有配对设备的直接记完成，通用里可重新运行）。`project.yml` 加 `NSAppleEventsUsageDescription`。
- 清单没放「文件和文件夹」：macOS 不弹窗就查不到这项授权。
