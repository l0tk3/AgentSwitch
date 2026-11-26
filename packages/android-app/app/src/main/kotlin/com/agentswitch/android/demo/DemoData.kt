package com.agentswitch.android.demo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.EndpointKind
import com.agentswitch.kit.api.FileDiff
import com.agentswitch.kit.api.GitSummary
import com.agentswitch.kit.api.PlanEntry
import com.agentswitch.kit.api.ProfileChoice
import com.agentswitch.kit.api.ProfileChoices
import com.agentswitch.kit.api.ProfileColor
import com.agentswitch.kit.api.ProxyExit
import com.agentswitch.kit.api.ProxySetting
import com.agentswitch.kit.api.RecordFile
import com.agentswitch.kit.api.RecordItem
import com.agentswitch.kit.api.RecordStep
import com.agentswitch.kit.api.RecordStepDetail
import com.agentswitch.kit.api.RecordUsage
import com.agentswitch.kit.api.SentReply
import com.agentswitch.kit.api.SessionRecord
import com.agentswitch.kit.api.SessionSummary
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
    data object Sessions : DemoSettingsRoute()
    data class Session(val summary: SessionSummary) : DemoSettingsRoute()
}

/**
 * Sample state for looking at the screens without a Mac (`uiDemo`, debug builds only): the terminals and what they
 * show, the Mac's coding sessions and its default folder (control-v0), the proxies.
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

    // MARK: - control-v0

    val workdir = WorkdirSetting(path = "/Users/me/AgentSwitch", defaultPath = "/Users/me/AgentSwitch")

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
                    "grok" to mapOf("nodes" to listOf("🇺🇸 美国-02")), "agy" to mapOf("nodes" to listOf("🇯🇵 日本-03")),
                    "direct" to listOf("5.102.107.254"), "autoUpdateHours" to 24,
                    "templates" to mapOf("domestic" to mapOf("on" to true, "rules" to null), "block" to mapOf("on" to false, "rules" to null)),
                    "renameDefault" to false, "dns" to mapOf("on" to false, "text" to null),
                ),
                "services" to mapOf(
                    "claude" to mapOf("group" to "Claude", "auto" to "Claude自动选择", "live" to true, "now" to "Claude自动选择", "autoNow" to "🇯🇵 日本家宽-01", "missing" to emptyList<Any?>()),
                    "openai" to mapOf("group" to "OpenAI", "auto" to "OpenAI自动选择", "live" to true, "now" to "🇸🇬 新加坡-01", "autoNow" to "🇺🇸 美国家宽-01", "missing" to emptyList<Any?>()),
                    "grok" to mapOf("group" to "Grok", "auto" to "Grok自动选择", "live" to true, "now" to "Grok自动选择", "autoNow" to "🇺🇸 美国-02", "missing" to emptyList<Any?>()),
                    "agy" to mapOf("group" to "Antigravity", "auto" to "Antigravity自动选择", "live" to true, "now" to "Antigravity自动选择", "autoNow" to "🇯🇵 日本-03", "missing" to emptyList<Any?>()),
                ),
                "templates" to mapOf("domestic" to mapOf("on" to true, "custom" to false, "count" to 169), "block" to mapOf("on" to false, "custom" to false, "count" to 27)),
                "defaultGroup" to "节点选择", "dns" to mapOf("on" to false, "custom" to false, "overridden" to false), "active" to true, "upToDate" to true, "install" to "", "fetchedAt" to ago(1800),
            ),
        ) as JsonObject

    /** Same as [clashObject] (the iPhone's `clash` decodes it to a `ClashView`; see there). */
    val clash: JsonObject get() = clashObject

    /** The same page after a setting was changed here (no Mac to keep it): [settings] is the encoded `ClashSettings`. */
    fun clash(settings: JsonElement): JsonObject = JsonObject(clashObject + ("settings" to settings))

    /** Per service (the `ClashService` raw values), a node's delay in ms; null: it timed out. */
    val clashDelays: Map<String, Map<String, Int?>> = mapOf(
        "claude" to mapOf("🇯🇵 日本家宽-01" to 96, "🇯🇵 日本家宽-02" to 142, "🇺🇸 美国家宽-01" to 428, "🇯🇵 日本-03" to 118, "🇺🇸 美国-02" to null, "🇸🇬 新加坡-01" to 187),
        "openai" to mapOf("🇺🇸 美国家宽-01" to 402, "🇸🇬 新加坡-01" to 187),
        "grok" to mapOf("🇺🇸 美国-02" to 398),
        "agy" to mapOf("🇯🇵 日本-03" to 118),
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
                    "id" to "grok", "title" to "Grok", "host" to "grok.com", "expect" to mapOf("kind" to "group", "group" to "Grok"),
                    "observed" to mapOf("outcome" to "proxied", "rule" to "RuleSet as-grok", "path" to listOf("Grok", "Grok自动选择", "🇺🇸 美国-02"), "exit" to mapOf("ip" to "64.7.198.20", "loc" to "US"), "ms" to 398), "ok" to true,
                ),
                mapOf(
                    "id" to "agy", "title" to "Antigravity", "host" to "antigravity.google", "expect" to mapOf("kind" to "group", "group" to "Antigravity"),
                    "observed" to mapOf("outcome" to "proxied", "rule" to "RuleSet as-agy", "path" to listOf("Antigravity", "Antigravity自动选择", "🇯🇵 日本-03"), "exit" to mapOf("ip" to "126.36.1.2", "loc" to "JP"), "ms" to 118), "ok" to true,
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
        "sessions" -> listOf(DemoSettingsRoute.Sessions)
        "transcript", "transcriptfiles" -> sessions.firstOrNull()?.let { listOf(DemoSettingsRoute.Sessions, DemoSettingsRoute.Session(it)) } ?: listOf(DemoSettingsRoute.Sessions)
        else -> emptyList()
    }
}
