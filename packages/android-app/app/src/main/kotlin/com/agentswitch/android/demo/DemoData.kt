package com.agentswitch.android.demo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.ApprovalPolicy
import com.agentswitch.kit.api.ApprovalPolicyInfo
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.AgentThread
import com.agentswitch.kit.api.EndpointKind
import com.agentswitch.kit.api.FileDiff
import com.agentswitch.kit.api.GitSummary
import com.agentswitch.kit.api.PermissionMode
import com.agentswitch.kit.api.PlanEntry
import com.agentswitch.kit.api.ProfileChoice
import com.agentswitch.kit.api.ProfileChoices
import com.agentswitch.kit.api.ProfileColor
import com.agentswitch.kit.api.ProxyExit
import com.agentswitch.kit.api.ProxySetting
import com.agentswitch.kit.api.QuotaReading
import com.agentswitch.kit.api.RecordFile
import com.agentswitch.kit.api.RecordItem
import com.agentswitch.kit.api.RecordStep
import com.agentswitch.kit.api.RecordStepDetail
import com.agentswitch.kit.api.RecordUsage
import com.agentswitch.kit.api.SentReply
import com.agentswitch.kit.api.SessionRecord
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.api.TerminalActivity
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalList
import com.agentswitch.kit.api.TerminalModelOption
import com.agentswitch.kit.api.TerminalPermission
import com.agentswitch.kit.api.TerminalProfile
import com.agentswitch.kit.api.TerminalQuestion
import com.agentswitch.kit.api.TerminalStatus
import com.agentswitch.kit.api.TerminalSubagent
import com.agentswitch.kit.api.TurnProgress
import com.agentswitch.kit.api.WorkdirSetting
import com.agentswitch.kit.assistant.AssistantMessage
import com.agentswitch.kit.connection.ProbeOutcome
import com.agentswitch.kit.connection.ProbeReport
import com.agentswitch.kit.feed.SlashCommand
import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import java.io.ByteArrayOutputStream

/** Where 设置 opens for a demo screen. The app's own route type is not written yet, so this stands for it. */
sealed class DemoSettingsRoute {
    data object Clash : DemoSettingsRoute()
    data object ProxyBrowser : DemoSettingsRoute()
    data class ProxyProfile(val agent: String, val profile: ProfileChoice) : DemoSettingsRoute()
    data object Mac : DemoSettingsRoute()
    data object Tasks : DemoSettingsRoute()
    data object Sessions : DemoSettingsRoute()
    data class Session(val summary: SessionSummary) : DemoSettingsRoute()
}

/**
 * Sample state for looking at the screens without a Mac (`uiDemo`, debug builds only): a conversation with a task
 * running, one waiting for an answer, one finished and not opened yet, one gone quiet for a quarter of an hour and one
 * stopped by a restart; their threads and the pending question; the Mac's coding sessions, its permission mode and
 * default folder (control-v0).
 *
 * Where the iPhone's builders read the `uiDemoScreen` flag, the screen's name is a parameter here.
 */
object DemoData {
    val now: Long = System.currentTimeMillis()
    fun ago(seconds: Long): Long = now - seconds * 1000
    fun ago(seconds: Int): Long = ago(seconds.toLong())

    /** Swift's `[String: Any]` / `NSNull` literals as JSON: null, strings, numbers, booleans, maps, lists. */
    private fun json(v: Any?): JsonElement = when (v) {
        null -> JsonNull
        is JsonElement -> v
        is String -> JsonPrimitive(v)
        is Boolean -> JsonPrimitive(v)
        is Number -> JsonPrimitive(v)
        is Map<*, *> -> JsonObject(v.entries.associate { (it.key as String) to json(it.value) })
        is List<*> -> JsonArray(v.map { json(it) })
        else -> error("not JSON: $v")
    }

    private inline fun <reified T> decode(obj: Any?): T = KitJson.decodeFromJsonElement(json(obj))

    val threads: List<AgentThread>
        get() = decode(
            listOf(
                mapOf("id" to "th1", "title" to "AgentSwitch 最近的改动", "cwd" to "/Users/me/Projects/AgentSwitch", "status" to "open", "createdAt" to ago(900), "updatedAt" to ago(60), "expiresAt" to null, "lastActivity" to ago(10), "taskCount" to 1),
                mapOf("id" to "th2", "title" to "财务平台登录", "cwd" to "/tmp/w2", "status" to "open", "createdAt" to ago(1800), "updatedAt" to ago(120), "expiresAt" to null, "lastActivity" to ago(120), "taskCount" to 1),
                mapOf("id" to "th3", "title" to "整理下载目录", "cwd" to "/tmp/w3", "status" to "open", "createdAt" to ago(4000), "updatedAt" to ago(3000), "expiresAt" to null, "lastActivity" to ago(3000), "taskCount" to 1),
                mapOf("id" to "th4", "title" to "博客构建报错", "cwd" to "/Users/me/Blog", "status" to "open", "createdAt" to ago(2500), "updatedAt" to ago(1080), "expiresAt" to null, "lastActivity" to ago(1080), "taskCount" to 1),
                mapOf("id" to "th5", "title" to "周报数据", "cwd" to "/Users/me/AgentSwitch/2026-09-27-t6", "status" to "open", "createdAt" to ago(9000), "updatedAt" to ago(7000), "expiresAt" to null, "lastActivity" to ago(7000), "taskCount" to 1),
                mapOf("id" to "th6", "title" to "明天的天气", "cwd" to null, "status" to "open", "createdAt" to ago(20000), "updatedAt" to ago(19000), "expiresAt" to null, "lastActivity" to ago(19000), "taskCount" to 1),
            ),
        )

    val tasks: List<AgentTask>
        get() = decode(
            listOf(
                mapOf(
                    "id" to "t3", "createdAt" to ago(3600), "updatedAt" to ago(3000), "status" to "done", "task" to "整理一下下载目录，重复的文件放一起", "threadId" to "th3",
                    "harness" to "opencode", "model" to "deepseek/deepseek-flash", "result" to "## 整理结果\n- 共 42 个文件，已按类型分入 6 个文件夹\n- 7 个重复文件已移入“重复”\n- 未删除任何文件",
                    "speech" to "下载目录已整理完成，共四十二个文件，其中七个重复文件已移入“重复”文件夹。", "spoken" to "下载目录已整理完成。",
                ),
                mapOf(
                    "id" to "t2", "createdAt" to ago(1500), "updatedAt" to ago(120), "status" to "waiting_approval", "task" to "登录财务平台，汇总首页的待办", "threadId" to "th2",
                    "harness" to "claude-code", "model" to "claude-sonnet-4-6",
                ),
                mapOf(
                    "id" to "t1", "createdAt" to ago(95), "updatedAt" to ago(10), "status" to "running", "task" to "总结一下 AgentSwitch 最近的改动", "threadId" to "th1",
                    "harness" to "claude-code", "model" to "claude-opus-5-5", "spoken" to "正在读取提交记录",
                ),
                mapOf(
                    "id" to "t4", "createdAt" to ago(2500), "updatedAt" to ago(1080), "status" to "running", "task" to "博客换主题后构建报错了，看看怎么回事", "threadId" to "th4",
                    "harness" to "codex", "model" to "gpt-6-luna",
                ),
                mapOf(
                    "id" to "t6", "createdAt" to ago(9000), "updatedAt" to ago(7000), "status" to "blocked", "blockCause" to "interrupted", "task" to "把这周的周报数据汇总成表格",
                    "threadId" to "th5", "harness" to "claude-code", "model" to "claude-sonnet-4-6", "acknowledgedAt" to ago(6900),
                    "error" to "服务重启时任务仍在进行，执行进度无法确认。",
                ),
                mapOf(
                    "id" to "t5", "createdAt" to ago(20000), "updatedAt" to ago(19000), "status" to "done", "task" to "明天杭州的天气怎么样", "threadId" to "th6",
                    "harness" to "claude-code", "model" to "claude-sonnet-4-6", "result" to "明天多云转小雨，气温 18 至 24 度。", "acknowledgedAt" to ago(18000),
                ),
            ),
        )

    val approvals: List<Approval>
        get() {
            val evidence = """{"source":"executor","questions":[{"id":"code","header":"验证码","text":"短信验证码是多少？","secret":true}]}"""
            return decode(
                listOf(
                    mapOf(
                        "id" to "ap1", "taskId" to "t2", "createdAt" to ago(120), "kind" to "question", "action" to "短信验证码是多少？",
                        "evidence" to evidence, "status" to "pending", "resolvedAt" to null, "answer" to null,
                    ),
                ),
            )
        }

    /** Each task's process, as the detail page shows it. */
    val events: Map<String, List<TaskEvent>>
        get() {
            var seq = 0
            fun e(task: String, type: String, payload: Map<String, Any?>, ts: Long): Map<String, Any?> {
                seq += 1
                return mapOf("taskId" to task, "seq" to seq, "ts" to ts, "type" to type, "payload" to payload)
            }
            fun call(task: String, tool: String, input: Map<String, Any?>, ts: Long, id: String? = null): Map<String, Any?> {
                val useId = id ?: "tu${seq + 1}"
                return e(task, "tool_call", mapOf("tool" to tool, "id" to useId, "input" to input), ts)
            }
            val all: List<TaskEvent> = decode(
                listOf(
                    e("t1", "step", mapOf("action" to "intake", "sealingMs" to 820), ago(95)),
                    e("t1", "routed", mapOf("verdict" to mapOf("ok" to true, "harness" to "claude-code", "model" to "claude-opus-5-5"), "source" to "model"), ago(94)),
                    e("t1", "dispatched", mapOf("harness" to "claude-code", "model" to "claude-opus-5-5"), ago(93)),
                    call("t1", "Bash", mapOf("command" to "git log --oneline -n 30", "description" to "最近 30 个提交"), ago(80), id = "tu1"),
                    e("t1", "tool_result", mapOf("id" to "tu1", "ok" to true, "output" to "749fdca docs: Live Activity, local API token\naa761fa feat: local API token; tasks may use the Mac's folders\n0413725 feat(ios-app): Live Activity and Dynamic Island"), ago(79)),
                    call("t1", "Read", mapOf("file_path" to "/Users/me/Projects/AgentSwitch/docs/assistant-v0.md"), ago(70)),
                    e("t1", "text", mapOf("text" to "最近 30 个提交集中在三个方面：本机 API 的令牌鉴权、任务使用 Mac 上的目录、只读步骤运行只读命令。"), ago(40)),
                    call("t1", "Read", mapOf("file_path" to "/Users/me/Projects/AgentSwitch/packages/daemon/src/api/localAuth.ts"), ago(36)),
                    call("t1", "Read", mapOf("file_path" to "/Users/me/Projects/AgentSwitch/packages/daemon/src/api/cwdPolicy.ts"), ago(32)),
                    call("t1", "Grep", mapOf("pattern" to "readOnly", "path" to "packages/daemon/src"), ago(27)),
                    call("t1", "Read", mapOf("file_path" to "/Users/me/Projects/AgentSwitch/packages/daemon/src/executors/readOnly.ts"), ago(22)),
                    call("t1", "Bash", mapOf("command" to "git show --stat HEAD~1"), ago(16)),
                    call("t1", "Bash", mapOf("command" to "git show --stat HEAD~2"), ago(10)),
                    e("t2", "dispatched", mapOf("harness" to "claude-code", "model" to "claude-sonnet-4-6"), ago(1500)),
                    call("t2", "mcp__playwright__browser_navigate", mapOf("url" to "https://finance.example.com/login"), ago(1400), id = "tu2"),
                    e("t2", "tool_result", mapOf("id" to "tu2", "ok" to true, "output" to "Page URL: https://finance.example.com/login\nPage Title: 登录"), ago(1399)),
                    e("t2", "text", mapOf("text" to "登录页要求输入短信验证码。"), ago(125)),
                    e("t2", "approval_request", mapOf("kind" to "question", "source" to "executor", "questions" to listOf(mapOf("text" to "短信验证码是多少？"))), ago(120)),
                    e("t3", "dispatched", mapOf("harness" to "opencode", "model" to "deepseek/deepseek-flash"), ago(3600)),
                    call("t3", "bash", mapOf("command" to "ls -la ~/Downloads | wc -l"), ago(3590)),
                    call("t3", "bash", mapOf("command" to "shasum ~/Downloads/* | sort"), ago(3570)),
                    call("t3", "read", mapOf("filePath" to "/Users/me/Downloads/清单.txt"), ago(3560)),
                    e("t3", "text", mapOf("text" to "42 个文件中有 7 个重复，将按类型分入 6 个文件夹。"), ago(3540)),
                    call("t3", "bash", mapOf("command" to "mkdir -p ~/Downloads/{文档,图片,安装包,压缩包,表格,重复}"), ago(3520)),
                    call("t3", "bash", mapOf("command" to "mv ~/Downloads/*.pdf ~/Downloads/文档/"), ago(3500)),
                    e("t3", "done", mapOf("result" to "共 42 个文件，7 个重复文件已移入“重复”。"), ago(3467)),
                    e("t4", "dispatched", mapOf("harness" to "codex", "model" to "gpt-6-luna"), ago(2480)),
                    call("t4", "commandExecution", mapOf("command" to "/bin/zsh -lc 'npm run build'"), ago(2400)),
                    e("t4", "text", mapOf("text" to "构建在 hexo-renderer 步骤停止响应，无输出。"), ago(1100)),
                    call("t4", "commandExecution", mapOf("command" to "/bin/zsh -lc 'npm ls hexo-renderer-marked'"), ago(1080)),
                    e("t6", "dispatched", mapOf("harness" to "claude-code", "model" to "claude-sonnet-4-6"), ago(8900)),
                    call("t6", "Read", mapOf("file_path" to "/Users/me/Documents/周报/第39周.xlsx"), ago(8800)),
                    e("t6", "blocked", mapOf("cause" to "interrupted", "error" to "服务重启时任务仍在进行，执行进度无法确认。"), ago(7000)),
                ),
            )
            return all.groupBy { it.taskId }
        }

    val messages: List<AssistantMessage>
        get() {
            fun m(seq: Int, role: String, text: String, kind: String, tasks: List<String> = emptyList(), ts: Long): Map<String, Any?> =
                mapOf("seq" to seq, "ts" to ts, "role" to role, "text" to text, "kind" to kind, "taskIds" to tasks, "clientId" to null, "replyTo" to null)
            return decode(
                listOf(
                    m(1, "user", "整理一下下载目录，重复的文件放一起", kind = "message", ts = ago(3610)),
                    m(2, "assistant", "已交给 DeepSeek Flash 整理下载目录。", kind = "task", tasks = listOf("t3"), ts = ago(3605)),
                    m(3, "assistant", "「整理下载目录」已完成：共四十二个文件，其中七个重复文件已移入“重复”文件夹。", kind = "notice", tasks = listOf("t3"), ts = ago(2990)),
                    m(9, "user", "注视感知功能的英文叫什么", kind = "message", ts = ago(50)),
                    m(10, "assistant", "Attention Aware Features，位于 设置 › 面容 ID 与密码。", kind = "reply", ts = ago(48)),
                    m(4, "user", "登录财务平台，汇总首页的待办", kind = "message", ts = ago(1510)),
                    m(5, "assistant", "已交给 Sonnet 4.6，通过浏览器登录财务平台。", kind = "task", tasks = listOf("t2"), ts = ago(1505)),
                    m(6, "assistant", "「财务平台登录」等你回答：短信验证码是多少？", kind = "waiting", tasks = listOf("t2"), ts = ago(115)),
                    m(11, "user", "明天杭州的天气怎么样", kind = "message", ts = ago(20010)),
                    m(12, "assistant", "已交给 Sonnet 4.6 查询天气。", kind = "task", tasks = listOf("t5"), ts = ago(20005)),
                    m(13, "user", "把这周的周报数据汇总成表格", kind = "message", ts = ago(9010)),
                    m(14, "assistant", "已交给 Sonnet 4.6 汇总周报数据。", kind = "task", tasks = listOf("t6"), ts = ago(9005)),
                    m(15, "user", "博客换主题后构建报错了，看看怎么回事", kind = "message", ts = ago(2510)),
                    m(16, "assistant", "已交给 GPT-6 Luna，在 ~/Blog 中检查构建。", kind = "task", tasks = listOf("t4"), ts = ago(2505)),
                    m(7, "user", "总结一下 AgentSwitch 最近的改动", kind = "message", ts = ago(100)),
                    m(8, "assistant", "已交给 Opus 5.5，在 AgentSwitch 仓库中查看提交记录。", kind = "task", tasks = listOf("t1"), ts = ago(96)),
                ),
            )
        }

    // MARK: - control-v0

    val policy = ApprovalPolicyInfo(policy = ApprovalPolicy(mode = PermissionMode.Skip))
    val workdir = WorkdirSetting(path = "/Users/me/AgentSwitch", defaultPath = "/Users/me/AgentSwitch")
    const val searchQuery = "目录"

    val sessions: List<SessionSummary>
        get() {
            val repo = "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch"
            return listOf(
                SessionSummary(
                    harness = "claude-code", sessionId = "c1", cwd = repo, title = "iPhone 端：编码会话列表和未读标记",
                    lastText = "列表按目录分组，进行中的会话 10 秒刷新一次。", updatedAt = ago(20), active = true, branch = "main", model = "claude-opus-5-5",
                ),
                SessionSummary(
                    harness = "codex", sessionId = "x1", cwd = repo, title = "daemon：读取 Codex 的 rollout 文件",
                    lastText = "已读取 session_meta 中的 cwd 和 originator。", updatedAt = ago(1500), origin = "desktop", branch = "main", model = "gpt-6-luna",
                ),
                SessionSummary(
                    harness = "opencode", sessionId = "o1", cwd = "/Users/me/Blog", title = "换主题后的构建报错",
                    lastText = "hexo-renderer-marked 升级到 7.0 后构建成功。", updatedAt = ago(3 * 3600), model = "deepseek/deepseek-flash",
                ),
                SessionSummary(
                    harness = "claude-code", sessionId = "c2", cwd = "/Users/me/Work/api", title = "给健康检查加缓存",
                    lastText = "缓存 30 秒，命中率 92%。", updatedAt = ago(26 * 3600),
                ),
                // Folders inside folders the list shows (docs/terminal-v0.md §1 目录树的层级, 2026-10-03): one in the
                // project, and Worktop with a session of its own over the folders in it.
                SessionSummary(
                    harness = "claude-code", sessionId = "c3", cwd = "$repo/packages/secret-gate", title = "fill-value 的探针模板",
                    lastText = "探针模板固定在包里。", updatedAt = ago(5 * 3600),
                ),
                SessionSummary(
                    harness = "claude-code", sessionId = "c4", cwd = "/Users/me/Desktop/WorkSpace/Worktop", title = "整理工作目录",
                    lastText = "做完的项目搬到 Archived。", updatedAt = ago(30 * 3600),
                ),
                SessionSummary(
                    harness = "codex", sessionId = "x2", cwd = "/Users/me/Desktop/WorkSpace/Worktop/Codex", title = "给脚本加上重试",
                    lastText = "下载失败时指数退避重试三次。", updatedAt = ago(40 * 3600),
                ),
                SessionSummary(
                    harness = "codex", sessionId = "x3", cwd = "/Users/me/Desktop/WorkSpace/Worktop/培训/靶场", title = "靶场环境搭建",
                    lastText = "docker compose 起三台靶机。", updatedAt = ago(50 * 3600),
                ),
            )
        }

    // MARK: - terminal-v0

    /** What `/` offers in the demo terminal. */
    val slashCommands: List<SlashCommand> = listOf(
        SlashCommand(name = "compact", description = "Clear conversation history but keep a summary in context"),
        SlashCommand(name = "config", description = "Open the settings panel"),
        SlashCommand(name = "context", description = "Show how the context window is used"),
        SlashCommand(name = "cost", description = "Show the cost and duration of this session"),
        SlashCommand(name = "clear", description = "Clear conversation history and free up context"),
        SlashCommand(name = "commit", description = "Stage and commit the current changes", source = "user"),
    )

    /** The folders' git, after their names in the tree. */
    val git: Map<String, GitSummary> = mapOf(
        "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch" to GitSummary(branch = "main", changed = 5, ahead = 2),
        "/Users/me/Work/api" to GitSummary(branch = "feat/health", changed = 3, behind = 4),
    )

    /** [screen] is the demo screen's name (`uiDemoScreen`), null for none. */
    fun terminalList(screen: String?): TerminalList {
        val repo = "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch"
        // `simplebusy`, `simpleprompt`: the simple view while it works, and while it waits on a screen of its own.
        // `simplecompact`: while it compacts its context (docs/simple-view-v0.md §5.7).
        val compact = screen == "simplecompact"
        // `simpledaybreak`: a Codex terminal with its Daybreak switch on (§5.8); `simpledaybreakclash`: on a model that
        // Codex lists without a Daybreak program.
        val clash = screen == "simpledaybreakclash"
        val daybreak = screen == "simpledaybreak" || clash
        val busy = screen == "simplebusy" || compact
        val prompt = screen == "simpleprompt"
        val idle = daybreak || screen == "simpleidle" || screen == "simpleeffort" || screen == "simplepaste" || screen == "simplestep" || screen == "simplesuggest"
        val five = listOf("low", "medium", "high", "xhigh", "max")
        val first = TerminalInfo(
            id = "a1b2c3d4", harness = if (daybreak) "codex" else "claude-code", cwd = repo,
            model = if (clash) "gpt-6.1-sol" else if (daybreak) "gpt-6-sol" else "claude-opus-5-5", mode = if (daybreak) "manual" else "auto", name = "iPhone 终端标签页",
            status = if (busy) TerminalStatus.Working else if (idle) TerminalStatus.Idle else TerminalStatus.Waiting, cols = 52, rows = 30,
            createdAt = ago(1800), lastOutputAt = ago(20), agentSessionId = "c9",
            permissions = if (screen == "terminallink" || busy || prompt || idle) emptyList()
            else listOf(
                if (screen == "terminalquestion" || screen == "simplequestion") question
                else TerminalPermission(id = "p1", tool = "Bash", summary = "Bash: swift test --filter TerminalTests"),
            ),
            activity = if (compact) TerminalActivity(tool = "Compact", target = "")
            else if (busy) TerminalActivity(tool = "Bash", target = "swift build -c release", note = "Build the release app") else null,
            statusSince = if (busy) ago(if (compact) 65 else 41) else null,
            subagents = if (prompt || idle || compact) emptyList()
            else listOf(
                TerminalSubagent(id = "s1", type = "code-reviewer", name = "审查改动", doing = "运行 git diff"),
                TerminalSubagent(id = "s2", type = "Explore", name = "查终端路由", doing = "读取 src/api/terminals.ts"),
            ),
            suggestion = if (screen == "simplesuggest") "跑一遍测试确认" else null,
            daybreak = if (daybreak) true else null, sets = if (daybreak) true else null,
            // `simplebusy`: the tokens its own screen counts, and a message sent a moment ago that it has not taken yet.
            progress = if (screen == "simplebusy") TurnProgress(tokens = 3300) else null,
            sent = if (screen == "simplebusy") listOf(SentReply(id = "s1", text = "顺便把测试也跑一遍", at = ago(3))) else emptyList(),
            // `terminalprofiles`: under a profile other than the Mac's own (docs/profiles-v0.md §3.2) — its lit dot.
            profile = if (screen == "terminalprofiles") TerminalProfile(name = "cwork1", color = ProfileColor.Violet) else null,
        )
        val second = TerminalInfo(
            id = "e5f6a7b8", harness = "codex", cwd = repo, model = "gpt-6-luna", name = "daemon 审计修复", status = TerminalStatus.Working,
            createdAt = ago(900), lastOutputAt = ago(2),
        )
        val profiled = if (screen == "terminalprofiles") listOf(
            TerminalInfo(
                id = "d4e5f6a7", harness = "claude-code", cwd = repo, model = "claude-opus-5-5", name = "看一遍改动", status = TerminalStatus.Idle,
                createdAt = ago(600), lastOutputAt = ago(90), profile = TerminalProfile(name = "side", color = ProfileColor.Sand),
            ),
        ) else emptyList()
        val blog = TerminalInfo(
            id = "c3d4e5f6", harness = "opencode", cwd = "/Users/me/Blog", name = "Blog", status = TerminalStatus.Idle,
            createdAt = ago(7200), lastOutputAt = ago(3000),
        )
        return TerminalList(
            terminals = listOf(first, second) + profiled + listOf(blog),
            agents = listOf("claude-code", "codex", "opencode"),
            models = mapOf(
                "claude-code" to listOf(
                    TerminalModelOption(id = "opus", name = "Opus 5.5", efforts = five), TerminalModelOption(id = "claude-fable-5-1", name = "Fable 5.1", efforts = five),
                    TerminalModelOption(id = "sonnet", name = "Sonnet 5.5", efforts = five), TerminalModelOption(id = "haiku", name = "Haiku 4.5", efforts = emptyList()),
                    TerminalModelOption(id = "claude-opus-4-6", name = "Opus 4.6", older = true, efforts = listOf("low", "medium", "high", "max")),
                ),
                "codex" to listOf(
                    TerminalModelOption(id = "gpt-6.1-sol", name = "GPT-6.1-Sol", efforts = five, daybreak = "never"),
                    TerminalModelOption(id = "gpt-6-sol", name = "GPT-6-Sol", efforts = five, daybreak = "also"),
                    TerminalModelOption(id = "gpt-6-luna", name = "GPT-6 Luna", efforts = five, defaultEffort = "medium", daybreak = "also"),
                    TerminalModelOption(id = "gpt-daybreak-blue-latest", name = "Daybreak Blue", efforts = five, daybreak = "only"),
                ),
                "opencode" to listOf(TerminalModelOption(id = "deepseek/deepseek-flash", name = "DeepSeek Flash", efforts = listOf("none", "low", "high", "max"))),
            ),
            defaults = mapOf("claude-code" to "Opus 5.5"),
            efforts = mapOf("claude-code" to five, "codex" to five + listOf("ultra"), "pi" to listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")),
            effortDefaults = mapOf("claude-code" to "medium", "codex" to "low"),
        )
    }

    /** The agent asking (AskUserQuestion, terminal-v0 §3 "选择题"): `terminalquestion`. */
    val question = TerminalPermission(
        id = "p2", tool = "AskUserQuestion", summary = "会话存在哪里？ · 慢日志记哪些字段？",
        questions = listOf(
            TerminalQuestion(
                question = "会话存在哪里？", header = "Store",
                options = listOf(
                    TerminalQuestion.Option(label = "Redis", description = "多台实例共享，重启不丢"),
                    TerminalQuestion.Option(label = "内存", description = "最快，但重启后全部失效"),
                ),
            ),
            TerminalQuestion(
                question = "慢日志记哪些字段？", header = "Logs", multiSelect = true,
                options = listOf(
                    TerminalQuestion.Option(label = "用户 id"), TerminalQuestion.Option(label = "耗时"),
                    TerminalQuestion.Option(label = "请求路径", description = "带查询参数时去掉参数"),
                ),
            ),
        ),
    )

    /** A Claude Code screen as a snapshot draws it (escape sequences, CR LF). [screen]: `uiDemoScreen`. */
    fun terminalScreen(screen: String?): String {
        val dim = "\u001B[2m"
        val off = "\u001B[0m"
        val orange = "\u001B[38;5;209m"
        val green = "\u001B[32m"
        val bold = "\u001B[1m"
        val cyan = "\u001B[36m"
        val lines = listOf(
            "${orange}✻${off} ${bold}Claude Code${off} ${dim}· Opus 5.5${off}",
            "${dim}  ~/Desktop/WorkSpace/Projects/AgentSwitch${off}",
            "",
            "${dim}>${off} 给 iPhone 加终端标签页，列表按目录树排",
            "",
            "${green}⏺${off} 先看服务端的终端接口和手机能用的路由。",
            "",
            "${green}⏺${off} ${bold}Read${off}(packages/daemon/src/api/terminals.ts)",
            "  ${dim}⎿  Read 301 lines${off}",
            "",
            "${green}⏺${off} ${bold}Write${off}(Sources/AgentSwitchKit/API/TerminalRoutes.swift)",
            "  ${dim}⎿  Wrote 132 lines${off}",
            "",
            "${green}⏺${off} 接口和事件流写好了，跑一下测试。",
            "",
            "${cyan}⏺${off} ${bold}Bash${off}(swift test --filter TerminalTests)",
            "  ${dim}⎿  Waiting for permission…${off}",
        )
        // `terminallink`: an address the agent cut at its width and a path of the Mac's, to tap and hold
        // (terminal-v0 §1 iPhone 链接).
        val links = listOf(
            "",
            "${green}⏺${off} 分屏的说明见这一页，也可以直接打开预览：",
            "  https://code.claude.com/docs/en/agent-teams.md#choo",
            "  se-a-display-mode",
            "  ~/Desktop/WorkSpace/Projects/AgentSwitch/docs/desi",
            "  gn/concepts/split.html",
        )
        val withLinks = screen == "terminallink" || screen == "terminalpath"
        return (if (withLinks) lines.dropLast(3) + links else lines).joinToString("\r\n")
    }

    /** A command opened whole: as it was written, and all it printed. */
    val stepDetail = RecordStepDetail(
        text = "cd packages/mac-app && swift test --filter AgentsTests 2>&1 \\\n  | grep -E \"error:|Executed [0-9]+ tests\" | tail -2   # the totals\ngit status --short",
        note = "Run the Agents tests and keep the last lines",
        out = "\t Executed 41 tests, with 0 failures (0 unexpected) in 0.412 (0.418) seconds\n M packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift",
    )

    /**
     * The one made-up picture the reply box's Paste is tried against (the iPhone puts it on a clipboard of the check's
     * own; the clipboard itself is the app's, so only the picture is here), as PNG bytes.
     */
    val pasteBoardImage: ByteArray? by lazy { picture(0) }

    /** A made-up screenshot sent with a message: a window with a few lines, wide or tall. PNG bytes, 1 px to the point. */
    fun picture(n: Int): ByteArray? {
        val wide = n % 2 == 0
        val width = if (wide) 480 else 220
        val height = if (wide) 300 else 440
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint()
        fun fill(color: Int, x: Float, y: Float, w: Float, h: Float) {
            paint.color = color
            canvas.drawRect(x, y, x + w, y + h, paint)
        }
        fun rgb(r: Double, g: Double, b: Double) = Color.rgb((r * 255).toInt(), (g * 255).toInt(), (b * 255).toInt())
        fill(rgb(0.93, 0.92, 0.89), 0f, 0f, width.toFloat(), height.toFloat())
        fill(rgb(0.84, 0.82, 0.78), 0f, 0f, if (wide) 130f else width.toFloat(), if (wide) height.toFloat() else 54f)
        val ink = rgb(0.12, 0.11, 0.10)
        for (row in 0 until (if (wide) 7 else 11)) {
            fill(
                ink, if (wide) 150f else 18f, (if (wide) 30 else 80) + row * 32f,
                (if (wide) 260f else 150f) - ((row * 37) % 90), 9f,
            )
        }
        fill(rgb(0.85, 0.33, 0.16), if (wide) 150f else 18f, if (wide) 250f else 396f, 86f, 22f)
        val out = ByteArrayOutputStream()
        val ok = bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        return if (ok) out.toByteArray() else null
    }

    /**
     * A session's record for the simple view (docs/simple-view-v0.md §2): what was said, two runs of work, a message
     * typed while it worked; its task list and how full its context is. [screen]: `uiDemoScreen`.
     */
    fun sessionRecord(harness: String, id: String, screen: String?): SessionRecord {
        val summary: SessionSummary = decode(
            mapOf(
                "harness" to harness, "id" to id, "cwd" to "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch", "title" to "iPhone 终端标签页",
                "lastText" to "", "updatedAt" to ago(20), "startedAt" to ago(1800), "active" to true, "model" to "claude-opus-5-5", "branch" to "main",
            ),
        )
        val compact = screen == "simplecompact"
        val daybreak = screen == "simpledaybreak" || screen == "simpledaybreakclash"
        val codexModel = if (screen == "simpledaybreakclash") "gpt-6.1-sol" else "gpt-6-sol"
        val busy = screen == "simplebusy"
        val items = mutableListOf(
            RecordItem(id = "100", kind = RecordItem.Kind.User, at = ago(900), text = "我选了这个 codex 的版本，怎么好像没生效", images = 2),
            // What it thought on the way, where it wrote that down.
            RecordItem(id = "150", kind = RecordItem.Kind.Answer, at = ago(895), text = "选的版本存下来了，但服务只在启动时读它。先看页面上哪里提示了要重启。", thinking = true),
            RecordItem(
                id = "200", kind = RecordItem.Kind.Work, at = ago(890), seconds = 72,
                steps = listOf(
                    RecordStep(kind = RecordStep.Kind.Read, text = "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift"),
                    RecordStep(kind = RecordStep.Kind.Read, text = "docs/design/agents-page.png", images = 1),
                    RecordStep(kind = RecordStep.Kind.Search, text = "pendingRestart"),
                    RecordStep(
                        kind = RecordStep.Kind.Run, text = "cd packages/mac-app && swift test --filter AgentsTests 2>&1 ⏎ | grep -E \"error:|Executed [0-9]+ tests\" | tail -2 ⏎ git status --short",
                        note = "Run the Agents tests and keep the last lines", out = "Executed 41 tests, with 0 failures (0 unexpected) in 0.412 seconds",
                    ),
                    RecordStep(kind = RecordStep.Kind.Edit, text = "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift", added = 12, removed = 1),
                    RecordStep(kind = RecordStep.Kind.Edit, text = "docs/agents-v0.md", added = 2, removed = 1),
                ),
            ),
            RecordItem(
                id = "300", kind = RecordItem.Kind.Answer, at = ago(815),
                text = """
                    生效了，只是还没有用上：

                    - 测试版已装好，`codex-beta` 在命令行里可用。
                    - 页面顶部有 `Restart Service…`，但你是在下面那一组里选的，看不到它。

                    已在 Codex 自己那一组的末尾加上同一条提示，写明服务现在用哪个、重启后改用哪个，见 [docs/agents-v0.md](docs/agents-v0.md) §8。
                """.trimIndent(),
                files = listOf(RecordFile(path = "/Users/you/code/site/out/agents-versions.xlsx", kind = "workbook"), RecordFile(path = "/Users/you/code/site/docs/agents-v0.md")),
            ),
            RecordItem(id = "400", kind = RecordItem.Kind.User, at = ago(300), text = "delete 应该标红才对"),
            RecordItem(
                id = "500", kind = RecordItem.Kind.Work, at = ago(290), seconds = if (busy) 0 else 38,
                steps = listOf(
                    RecordStep(kind = RecordStep.Kind.Search, text = "SettingsDeleteButton"),
                    RecordStep(kind = RecordStep.Kind.Edit, text = "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift", added = 3, removed = 3),
                ),
            ),
        )
        if (busy) {
            items.add(5, RecordItem(id = "450", kind = RecordItem.Kind.Answer, at = ago(250), text = "改好了：换成应用里已有的红字删除按钮，禁用时变淡。正在重新构建。"))
            items.add(RecordItem(id = "600", kind = RecordItem.Kind.User, at = ago(5), text = "顺便把确认框的文案也看一下", queued = true))
        } else {
            items.add(RecordItem(id = "550", kind = RecordItem.Kind.Answer, at = ago(250), text = "改好了：换成应用里已有的红字删除按钮，禁用时变淡。接下来跑一遍测试确认。"))
        }
        // An earlier compaction, a line in the record.
        if (compact) items.add(RecordItem(id = "560", kind = RecordItem.Kind.Note, at = ago(200), text = "Compacted · 899k → 15k"))
        // The first run of work alone, so a step opened on its picture is in view.
        val shown = if (screen == "simplestep") items.take(3) else items.toList()
        return SessionRecord(
            session = summary, items = shown, more = true, cursor = 100, rev = "demo",
            plan = listOf(
                PlanEntry(text = "找出所有用到删除按钮的地方", state = PlanEntry.State.Done), PlanEntry(text = "删除按钮标红", state = PlanEntry.State.Done),
                PlanEntry(text = "重新构建", state = PlanEntry.State.Doing), PlanEntry(text = "跑测试", state = PlanEntry.State.Todo),
            ),
            usage = RecordUsage(model = if (daybreak) codexModel else "claude-opus-5-5", used = 124_000, window = 200_000, effort = "medium"),
            mode = if (daybreak) null else "acceptEdits",
        )
    }

    /** What a run of work changed (the simple view's Changes). */
    val changes: List<FileDiff> = listOf(
        FileDiff(
            path = "packages/mac-app/Sources/AgentSwitchMac/Agents/AgentsView.swift", added = 3, removed = 3,
            hunks = listOf(
                FileDiff.Hunk(
                    header = "@@ -212,7 +212,7 @@",
                    lines = listOf(
                        "             Spacer()", "-            Button(\"Delete\", role: .destructive) { confirm = row }", "+            SettingsDeleteButton(\"Delete\") { confirm = row }",
                        "+                .disabled(row.locked || busy)", "-                .disabled(row.locked)", "-                .controlSize(.small)", "+                .help(row.locked ? AgentText.locked : \"\")", "         }",
                    ),
                ),
            ),
        ),
        FileDiff(
            path = "docs/agents-v0.md", added = 2, removed = 1,
            hunks = listOf(
                FileDiff.Hunk(header = "@@ -88,3 +88,4 @@", lines = listOf(" ## 8. 界面", "-删除用系统的破坏性按钮。", "+删除用设置页自己的红字按钮（`SettingsDeleteButton`），", "+禁用时变淡。")),
            ),
        ),
    )

    /**
     * 设置 › 用量, mirroring a real reading (2026-09-27): Claude Code 20 % of 5 h and 82 % of 7 d, Codex Pro 8 % of 7 d
     * (no 5 h window), the DeepSeek balance for OpenCode; read a minute and a half ago, resets still ahead.
     */
    val quota: List<QuotaReading>
        get() {
            val s = now / 1000
            return decode(
                listOf(
                    mapOf(
                        "harness" to "codex", "fetchedAt" to ago(90), "remaining" to 0.92, "source" to "codex app-server account/rateLimits/read", "error" to null,
                        "detail" to mapOf("planType" to "pro", "windows" to listOf(mapOf("label" to "7d", "usedPercent" to 8, "resetsAt" to s + 571_921))),
                    ),
                    mapOf(
                        "harness" to "opencode", "fetchedAt" to ago(92), "remaining" to 1, "source" to "deepseek /user/balance", "error" to null,
                        "detail" to mapOf("is_available" to true, "balances" to listOf(mapOf("currency" to "CNY", "total" to "96.23", "granted" to "0.00", "topped_up" to "96.23"))),
                    ),
                    mapOf(
                        "harness" to "claude-code", "fetchedAt" to ago(92), "remaining" to 0.18, "source" to "claude rate_limit_event (subscription windows)", "error" to null,
                        "detail" to mapOf(
                            "windows" to listOf(mapOf("label" to "5h", "usedPercent" to 20, "resetsAt" to s + 14_551), mapOf("label" to "7d", "usedPercent" to 82, "resetsAt" to s + 3_151)),
                            "windowsAgeMs" to 155_743,
                        ),
                    ),
                ),
            )
        }

    /** The last route choice as the Mac details page shows it: the LAN answered, Tailscale timed out. */
    val routeReport: List<ProbeReport>
        get() = listOf(
            ProbeReport(endpoint = APIEndpoint("192.168.1.5", 4713, EndpointKind.Bonjour), outcome = ProbeOutcome.Ok, seconds = 0.3),
            ProbeReport(endpoint = APIEndpoint("192.168.31.20", 4713, EndpointKind.Lan), outcome = null, seconds = 0.0),
            ProbeReport(endpoint = APIEndpoint("100.101.102.103", 4713, EndpointKind.Tailnet), outcome = ProbeOutcome.Unreachable("请求超时。"), seconds = 4.0),
        )

    // MARK: proxies (docs/clash-v0.md §9, docs/profiles-v0.md §4.2, docs/browser-v0.md §7.6)

    /**
     * The Clash page's state as the Mac sends it, as JSON: the kit has no `ClashView` yet, so the screen's author
     * decodes it with the type once it is ported.
     */
    val clashObject: JsonObject
        get() = json(
            mapOf(
                "found" to true, "running" to true, "version" to "v1.19.31", "mode" to "rule", "tun" to true,
                "source" to mapOf(
                    "kind" to "link", "name" to "Mine", "host" to "sub.example.net", "updatedAt" to ago(5400), "nodes" to 42,
                    "providers" to emptyList<Any?>(), "traffic" to mapOf("used" to 13_207_024_435.0, "total" to 107_374_182_400.0, "expire" to 1_793_456_000_000.0),
                ),
                "nodes" to listOf("🇯🇵 日本家宽-01", "🇯🇵 日本家宽-02", "🇯🇵 日本-03", "🇺🇸 美国家宽-01", "🇺🇸 美国-02", "🇸🇬 新加坡-01", "🇸🇬 新加坡-02", "🇬🇧 英国-01", "🇩🇪 德国-01", "🇰🇷 韩国-01"),
                "profiles" to listOf(mapOf("uid" to "Lbw7BJYzpand", "name" to "mine.yaml", "type" to "local"), mapOf("uid" to "Ro3yUVdr9kT1", "name" to "Other", "type" to "remote")),
                "settings" to mapOf(
                    "claude" to mapOf("nodes" to listOf("🇯🇵 日本家宽-01", "🇯🇵 日本家宽-02", "🇺🇸 美国家宽-01")),
                    "openai" to mapOf("nodes" to listOf("🇺🇸 美国家宽-01", "🇸🇬 新加坡-01")),
                    "direct" to listOf("5.102.107.254"), "autoUpdateHours" to 24,
                    "templates" to mapOf("domestic" to mapOf("on" to true, "rules" to null), "block" to mapOf("on" to false, "rules" to null)),
                    "renameDefault" to false, "dns" to mapOf("on" to false, "text" to null),
                ),
                "services" to mapOf(
                    "claude" to mapOf("group" to "Claude", "auto" to "Claude自动选择", "live" to true, "now" to "Claude自动选择", "autoNow" to "🇯🇵 日本家宽-01", "missing" to emptyList<Any?>()),
                    "openai" to mapOf("group" to "OpenAI", "auto" to "OpenAI自动选择", "live" to true, "now" to "🇸🇬 新加坡-01", "autoNow" to "🇺🇸 美国家宽-01", "missing" to emptyList<Any?>()),
                ),
                "templates" to mapOf("domestic" to mapOf("on" to true, "custom" to false, "count" to 169), "block" to mapOf("on" to false, "custom" to false, "count" to 27)),
                "defaultGroup" to "节点选择", "dns" to mapOf("on" to false, "custom" to false, "overridden" to false), "active" to true, "upToDate" to true, "install" to "", "fetchedAt" to ago(1800),
            ),
        ) as JsonObject

    /** Same as [clashObject] (the iPhone's `clash` decodes it to a `ClashView`; see there). */
    val clash: JsonObject get() = clashObject

    /** The same page after a setting was changed here (no Mac to keep it): [settings] is the encoded `ClashSettings`. */
    fun clash(settings: JsonElement): JsonObject = JsonObject(clashObject + ("settings" to settings))

    /** Per service (`claude`, `openai`: the `ClashService` raw values), a node's delay in ms; null: it timed out. */
    val clashDelays: Map<String, Map<String, Int?>> = mapOf(
        "claude" to mapOf("🇯🇵 日本家宽-01" to 96, "🇯🇵 日本家宽-02" to 142, "🇺🇸 美国家宽-01" to 428, "🇯🇵 日本-03" to 118, "🇺🇸 美国-02" to null, "🇸🇬 新加坡-01" to 187),
        "openai" to mapOf("🇺🇸 美国家宽-01" to 402, "🇸🇬 新加坡-01" to 187),
    )

    /** The rows of the Clash check, as JSON (the kit has no `ClashCheckRow` yet). */
    val clashChecked: JsonArray
        get() = json(
            listOf(
                mapOf(
                    "id" to "claude", "title" to "Claude", "host" to "claude.ai", "expect" to mapOf("kind" to "group", "group" to "Claude"),
                    "observed" to mapOf("outcome" to "proxied", "rule" to "RuleSet as-claude", "path" to listOf("Claude", "Claude自动选择", "🇯🇵 日本家宽-01"), "exit" to mapOf("ip" to "126.36.1.2", "loc" to "JP"), "ms" to 362), "ok" to true,
                ),
                mapOf(
                    "id" to "openai", "title" to "OpenAI", "host" to "chatgpt.com", "expect" to mapOf("kind" to "group", "group" to "OpenAI"),
                    "observed" to mapOf("outcome" to "proxied", "rule" to "RuleSet as-openai", "path" to listOf("OpenAI", "🇸🇬 新加坡-01"), "exit" to mapOf("ip" to "8.219.4.7", "loc" to "SG"), "ms" to 418), "ok" to true,
                ),
                mapOf(
                    "id" to "domestic", "title" to "Domestic", "host" to "www.baidu.com", "expect" to mapOf("kind" to "direct"),
                    "observed" to mapOf("outcome" to "direct", "rule" to "RuleSet as-domestic", "path" to listOf("DIRECT"), "ms" to 41), "ok" to true,
                ),
            ),
        ) as JsonArray

    const val clashRules = "DOMAIN-SUFFIX,cn\nDOMAIN-SUFFIX,baidu.com\nDOMAIN-SUFFIX,qq.com\nDOMAIN-KEYWORD,alipay\nPROCESS-NAME,WeChat\nGEOIP,CN\nIP-CIDR,192.168.0.0/16"

    val proxyProfiles: Map<String, ProfileChoices>
        get() = mapOf(
            "claude-code" to ProfileChoices(
                current = "abc123def0",
                profiles = listOf(
                    ProfileChoice(id = "default", name = "Default", account = "me@example.com"),
                    ProfileChoice(
                        id = "abc123def0", name = "cwork1", account = "work@example.com", color = ProfileColor.Violet,
                        proxy = ProxySetting(server = "http://proxy.example.net:8080", username = "cwork", sealed = true), exit = ProxyExit(ip = "203.0.113.9", place = "Tokyo"),
                    ),
                    ProfileChoice(id = "abc123def1", name = "side", color = ProfileColor.Mint),
                ),
            ),
        )

    /** What `proxies.browser` holds in the iPhone's `ProxiesOverview` (`BrowserProxyState(fingerprint:)`). */
    const val browserFingerprint = "macOS · Firefox 156"

    /** Every profile that is not the Mac's own, agents in a fixed order: the iPhone's `ProxiesOverview.owned`, as (agent, profile). */
    val ownedProxyProfiles: List<Pair<String, ProfileChoice>>
        get() = proxyProfiles.keys.sorted().flatMap { agent -> proxyProfiles.getValue(agent).profiles.filter { !it.isDefault }.map { agent to it } }

    /** Where 设置 opens for a demo screen. */
    fun settingsPath(screen: String?): List<DemoSettingsRoute> = when (screen) {
        "clash", "clashservice", "clashrules", "clashcheck", "clashnodes", "clashtext", "clashsource" -> listOf(DemoSettingsRoute.Clash)
        "proxybrowser" -> listOf(DemoSettingsRoute.ProxyBrowser)
        "proxyprofile" -> ownedProxyProfiles.firstOrNull()?.let { listOf(DemoSettingsRoute.ProxyProfile(it.first, it.second)) } ?: emptyList()
        "mac", "offlinemac" -> listOf(DemoSettingsRoute.Mac)
        "tasks", "search" -> listOf(DemoSettingsRoute.Tasks)
        "sessions" -> listOf(DemoSettingsRoute.Sessions)
        "transcript", "transcriptfiles" -> sessions.firstOrNull()?.let { listOf(DemoSettingsRoute.Sessions, DemoSettingsRoute.Session(it)) } ?: listOf(DemoSettingsRoute.Sessions)
        else -> emptyList()
    }
}
