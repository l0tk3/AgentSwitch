package com.agentswitch.kit.api

import com.agentswitch.kit.support.JSONValue
import java.text.BreakIterator

/** Swift counts and cuts a `String` by grapheme clusters (`count`, `prefix`); these do the same on the JVM. */
internal fun String.graphemeCount(): Int {
    if (isEmpty()) return 0
    val it = BreakIterator.getCharacterInstance()
    it.setText(this)
    var n = 0
    while (it.next() != BreakIterator.DONE) n++
    return n
}

/** The first [n] grapheme clusters (Swift's `String(s.prefix(n))`). */
internal fun String.graphemePrefix(n: Int): String {
    if (n <= 0 || isEmpty()) return ""
    if (length <= n) return this
    val it = BreakIterator.getCharacterInstance()
    it.setText(this)
    var end = 0
    var k = 0
    while (k < n) {
        val next = it.next()
        if (next == BreakIterator.DONE) return this
        end = next
        k++
    }
    return substring(0, end)
}

/**
 * A tool call said as people say it (2026-09-25): the tool as a verb and the one thing it works on in the process
 * list ("运行 git log -n 3", "浏览器 · 打开 https://…"), and its input field by field when the call is opened. The
 * three executors name tools differently: Claude `Bash`, `mcp__playwright__browser_click`; Codex `commandExecution`,
 * `playwright.browser_click`; OpenCode `bash`, `playwright_browser_click`.
 */
object ToolDisplay {
    /** One field of an opened call's input (Swift's `(name:, value:)` tuple). */
    data class Field(val name: String, val value: String)

    /** The list line of a `tool_call` event's payload. */
    fun line(payload: JSONValue): String {
        val label = label(payload["tool"]?.string ?: "?")
        val target = target(payload) ?: return label
        return "$label $target"
    }

    fun label(tool: String): String {
        verbs[tool]?.let { return it }
        verbs[tool.lowercase()]?.let { return it }
        val (server, name) = split(tool)
        if (server == null) return tool
        if (server == "playwright" || name.startsWith("browser_")) {
            val action = if (name.startsWith("browser_")) name.drop(8) else name
            return "浏览器 · ${browser[action] ?: action}"
        }
        if (server.contains("secret")) return secret[name] ?: "密文 · $name"
        return "$server · $name"
    }

    /**
     * The tool in one short word, for the compact island (assistant-v0 §4, 2026-10-01: what it is doing instead of a
     * clock); title case as ui-v0 §7.2.7.
     */
    fun word(tool: String): String {
        words[tool]?.let { return it }
        words[tool.lowercase()]?.let { return it }
        val (server, name) = split(tool)
        if (server == "playwright" || name.startsWith("browser_")) return "Web"
        if (server?.contains("secret") == true) return "Sealed"
        return "Tool"
    }

    private val words: Map<String, String> = mapOf(
        "bash" to "Run", "shell" to "Run", "commandexecution" to "Run", "exec_command" to "Run", "local_shell" to "Run",
        "read" to "Read", "view" to "Read", "notebookread" to "Read",
        "write" to "Edit", "edit" to "Edit", "multiedit" to "Edit", "filechange" to "Edit", "apply_patch" to "Edit", "patch" to "Edit", "notebookedit" to "Edit",
        "grep" to "Search", "glob" to "Search", "list" to "Search", "ls" to "Search",
        "webfetch" to "Web", "websearch" to "Web", "web_search" to "Web",
        "task" to "Agents", "agent" to "Agents", "subagent" to "Agents",
        "todowrite" to "Plan", "update_plan" to "Plan", "skill" to "Skill", "askuserquestion" to "Answer",
        // Not a tool: what a terminal is doing while its agent compacts its context (docs/simple-view-v0.md §5.7).
        "compact" to "Compact",
    )

    /** The one thing a call works on: its command (without Codex's shell wrapper), page, file, pattern or query. */
    fun target(payload: JSONValue): String? {
        val command = payload["command"]?.string ?: payload["input"]?.get("command")?.string
        if (command != null) return clip(EventDescriber.unwrapShell(command))
        val input = payload["input"]
        for (key in targetKeys) {
            val value = input?.get(key)?.string
            if (value != null && value.isNotEmpty()) return clip(value)
        }
        val files = input?.get("files")?.array?.mapNotNull { it.string }
        if (files != null && files.isNotEmpty()) return clip(files.joinToString(", "))
        return null
    }

    /** The input of an opened call, field by field; a plain string input is one field. */
    fun fields(input: JSONValue?): List<Field> = when (input) {
        is JSONValue.Object -> {
            val keys = input.value.keys.sortedWith(compareBy<String> { rank(it) }.thenBy { it })
            keys.mapNotNull { key ->
                val value = input.value[key]
                if (value == null || value == JSONValue.Null) null else Field(key, value.string ?: value.compactText)
            }
        }
        is JSONValue.Str -> listOf(Field("输入", input.value))
        null, JSONValue.Null -> emptyList()
        else -> listOf(Field("输入", input.compactText))
    }

    private val verbs: Map<String, String> = mapOf(
        "Bash" to "运行", "bash" to "运行", "shell" to "运行", "commandExecution" to "运行",
        "Read" to "读取", "read" to "读取", "Write" to "写入", "write" to "写入",
        "Edit" to "修改", "MultiEdit" to "修改", "edit" to "修改", "fileChange" to "修改", "apply_patch" to "修改", "patch" to "修改",
        "NotebookEdit" to "修改笔记本", "Grep" to "搜索", "grep" to "搜索", "Glob" to "查找文件", "glob" to "查找文件", "list" to "列出目录",
        "WebFetch" to "打开网页", "webfetch" to "打开网页", "WebSearch" to "网页搜索", "webSearch" to "网页搜索", "websearch" to "网页搜索",
        "Task" to "子任务", "Agent" to "子任务", "task" to "子任务", "subagent" to "子任务",
        "TodoWrite" to "更新计划", "todowrite" to "更新计划", "update_plan" to "更新计划", "Skill" to "使用技能", "skill" to "使用技能",
        "Compact" to "压缩上下文", "compact" to "压缩上下文",
    )

    private val browser: Map<String, String> = mapOf(
        "navigate" to "打开", "navigate_back" to "后退", "click" to "点击", "type" to "输入", "fill_form" to "填写表单", "press_key" to "按键",
        "select_option" to "选择", "hover" to "悬停", "snapshot" to "读取页面", "take_screenshot" to "截图", "wait_for" to "等待",
        "evaluate" to "执行脚本", "tabs" to "标签页", "close" to "关闭", "file_upload" to "上传文件", "handle_dialog" to "处理弹窗",
    )

    private val secret: Map<String, String> = mapOf(
        "secret_fill" to "填入密文", "secret_type" to "填入密文", "secret_repair" to "修复密文", "credential_repair" to "修复密文",
    )

    private val targetKeys = listOf(
        "url", "file_path", "filePath", "notebook_path", "path", "pattern", "query", "element",
        "description", "skill", "prompt",
    )

    /** Where the fields of an opened call come first: what it runs or opens, then the rest by name. */
    private fun rank(key: String): Int {
        val i = targetKeys.indexOf(key)
        return if (i >= 0) i + 1 else if (key == "command") 0 else targetKeys.size + 1
    }

    /** `mcp__server__name`, `server.name`, `server_name` (a known server only: `apply_patch` is not one). */
    private fun split(tool: String): Pair<String?, String> {
        if (tool.startsWith("mcp__")) {
            val parts = tool.drop(5).split("__")
            if (parts.size >= 2) return parts[0] to parts.drop(1).joinToString("__")
        }
        val dot = tool.indexOf('.')
        if (dot >= 0) return tool.substring(0, dot) to tool.substring(dot + 1)
        for (server in listOf("playwright", "secret-gate", "secret_gate")) {
            if (tool.startsWith(server + "_")) return server to tool.drop(server.length + 1)
        }
        if (tool.startsWith("browser_")) return "playwright" to tool
        return null to tool
    }

    private fun clip(text: String): String {
        val line = text.splitNewlines().firstOrNull() ?: text
        return if (line.graphemeCount() > 160) line.graphemePrefix(159) + "…" else line
    }
}
