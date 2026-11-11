package com.agentswitch.kit

import com.agentswitch.kit.api.EventDescriber
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.api.ToolDisplay
import com.agentswitch.kit.support.JSONValue
import com.agentswitch.kit.support.KitJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class EventDescriberTests {
    private fun event(type: String, payload: Map<String, Any?>): TaskEvent =
        KitJson.decodeFromString(TaskEvent.serializer(), mapToJsonText(mapOf("taskId" to "t", "seq" to 1, "ts" to 0, "type" to type, "payload" to payload)))

    @Test
    fun testLines() {
        assertEquals("hi", EventDescriber.line(event("text", mapOf("text" to "hi"))))
        assertEquals("已交给 GPT-5.5 · Codex · high", EventDescriber.line(event("dispatched", mapOf("harness" to "codex", "model" to "gpt-5.5", "effort" to "high"))))
        assertEquals("运行 ls", EventDescriber.line(event("tool_call", mapOf("tool" to "bash", "command" to "ls"))))
        assertEquals(
            "运行 ps -Ao pid,pcpu -r | head -n 20",
            EventDescriber.line(event("tool_call", mapOf("tool" to "commandExecution", "command" to "/bin/zsh -lc 'ps -Ao pid,pcpu -r | head -n 20'"))),
        )
        assertEquals("调用工具", EventDescriber.line(event("tool_call", mapOf("tool" to "claude", "count" to 1))))
        assertEquals(
            "浏览器 · 点击 登录按钮",
            EventDescriber.line(event("tool_call", mapOf("tool" to "mcp__playwright__browser_click", "id" to "t1", "input" to mapOf("element" to "登录按钮", "ref" to "e12")))),
        )
        assertEquals("填入密文", EventDescriber.line(event("tool_call", mapOf("tool" to "mcp__secret-gate__secret_fill", "input" to mapOf("ref" to "e3")))))
        assertEquals("搜索 src", EventDescriber.line(event("tool_call", mapOf("tool" to "Grep", "input" to mapOf("pattern" to "TODO", "path" to "src")))))
        assertEquals("浏览器 · 读取页面", EventDescriber.line(event("tool_call", mapOf("tool" to "playwright.browser_snapshot", "input" to mapOf<String, Any?>()))))
        assertEquals(
            listOf("command", "description", "timeout"),
            ToolDisplay.fields(JSONValue.Object(mapOf("command" to JSONValue.Str("ls"), "description" to JSONValue.Str("list"), "timeout" to JSONValue.Number(5.0)))).map { it.name },
        )
        assertEquals(
            "已阻止：命令（受保护的目录）",
            EventDescriber.line(event("tool_call", mapOf("tool" to "commandExecution", "denied" to "denied by AgentSwitch: this path holds …"))),
        )
        assertEquals(
            "已拒绝：top -l 1（只读步骤，不可执行此操作）",
            EventDescriber.line(event("supervisor", mapOf("kind" to "approval", "decision" to "deny", "reason" to "research step is read-only", "action" to "Bash: top -l 1"))),
        )
        assertEquals(
            "已放行：ps -A（只读命令）",
            EventDescriber.line(event("supervisor", mapOf("kind" to "approval", "decision" to "allow", "reason" to "a command that only reads, in a read-only step", "action" to "Bash: ps -A"))),
        )
        assertEquals(
            "已放行：rm -rf build（跳过权限模式）",
            EventDescriber.line(event("supervisor", mapOf("kind" to "approval", "decision" to "allow", "reason" to "skip-permissions mode", "source" to "policy", "action" to "Bash: rm -rf build"))),
            "the daemon's skip mode never shows raw English",
        )
        assertEquals(
            "交由你确认（保留类别：删除、git push）",
            EventDescriber.line(event("supervisor", mapOf("kind" to "approval", "decision" to "ask_user", "reason" to "reserved: delete, git_push", "source" to "policy"))),
        )
        assertEquals(
            "交由你确认（逐项确认模式）",
            EventDescriber.line(event("supervisor", mapOf("kind" to "approval", "decision" to "ask_user", "reason" to "manual mode", "source" to "policy"))),
        )
        assertEquals("问题已自动回答：验证码 → 123456", EventDescriber.line(event("supervisor", mapOf("kind" to "question", "answered" to true, "text" to "验证码 → 123456"))))
        assertEquals("进度检查（600 秒无输出）：继续等待", EventDescriber.line(event("supervisor", mapOf("kind" to "checkin", "action" to "continue", "silentMs" to 600_000))))
        assertEquals("验收通过", EventDescriber.line(event("supervisor", mapOf("kind" to "acceptance", "accepted" to true))))
        assertEquals("浏览器 · 打开 https://x.com/login", EventDescriber.line(event("tool_call", mapOf("tool" to "browser_navigate", "input" to mapOf("url" to "https://x.com/login")))))
        assertEquals("读取 /a/b.md", EventDescriber.line(event("tool_call", mapOf("tool" to "Read", "input" to mapOf("file_path" to "/a/b.md", "limit" to 20)))))
        assertEquals(
            "提问：A?；B?",
            EventDescriber.line(event("approval_request", mapOf("kind" to "question", "source" to "executor", "questions" to listOf(mapOf("text" to "A?"), mapOf("text" to "B?"))))),
        )
        assertEquals("已拒绝", EventDescriber.line(event("approval_resolved", mapOf("decision" to "deny", "kind" to "approval", "by" to "user"))))
        assertEquals(
            "第 2 步：交由 M · Codex 执行",
            EventDescriber.line(event("step", mapOf("n" to 2, "action" to "dispatch", "target" to mapOf("harness" to "codex", "model" to "m")))),
        )
        assertEquals("等待 Codex 空闲", EventDescriber.line(event("waiting", mapOf("for" to "harness:codex"))))
        assertEquals("失败：boom（安全事件）", EventDescriber.line(event("failed", mapOf("error" to "boom", "security" to true))))
        assertEquals("""brand_new {"k":1}""", EventDescriber.line(event("brand_new", mapOf("k" to 1))))
        assertEquals(EventDescriber.Tone.Attention, EventDescriber.tone(event("approval_request", mapOf())))
    }

    /** The lines a real task produced on the phone (2026-09-24): planner failure, feedback receipt, intake, cleanup. */
    @Test
    fun testLinesTheWebConsoleAlreadyHad() {
        val failure = event(
            "step",
            mapOf(
                "n" to 0, "action" to "plan", "source" to "error", "stage" to "initial_plan", "model" to "claude-code/claude-opus-5-5",
                "routerError" to "规划模型服务调用失败", "routerMs" to 9409, "tries" to 2, "failureKind" to "service_error",
            ),
        )
        assertEquals("初次规划已停止 · Opus 5.5 · 服务调用失败 · 耗时 9.4 秒 · 尝试 2 次\n原因：规划模型服务调用失败", EventDescriber.line(failure))
        assertEquals(EventDescriber.Tone.Failure, EventDescriber.tone(failure))
        assertEquals(
            "反馈已记录（手动确认），后续任务将参考",
            EventDescriber.line(event("feedback", mapOf("version" to 1, "source" to "user", "status" to "answered", "answers" to mapOf("clarify" to listOf("x"))))),
        )
        assertEquals("反馈记录（格式待核对）", EventDescriber.line(event("feedback", mapOf("version" to 2))))
        assertEquals("已接收 · 加密敏感字段 2.4 秒", EventDescriber.line(event("step", mapOf("action" to "intake", "sealingMs" to 2379, "durationMs" to 2390))))
        assertEquals("多步任务，由 M 规划：要多步", EventDescriber.line(event("step", mapOf("n" to 0, "action" to "plan", "model" to "claude-code/m", "reason" to "要多步"))))
        assertEquals(
            "规划调用超时（45 秒），正在重试一次",
            EventDescriber.line(event("step", mapOf("n" to 0, "action" to "plan", "source" to "retry", "model" to "opencode-serve:dispatcher", "timeoutMs" to 45000))),
        )
        assertEquals("已清理临时目录，保留 2 个文件", EventDescriber.line(event("cleaned", mapOf("workDirRemoved" to true, "artifacts" to 2))))
        assertEquals("已保存进展 · 执行 · 本步已结束", EventDescriber.line(event("checkpoint", mapOf("purpose" to "do", "ok" to true))))
    }

    @Test
    fun testProviderSafetyResend() {
        val retry = event("refusal", mapOf("action" to "retry", "reason" to "provider_safety", "note" to "x"))
        assertEquals("服务商安全拦截：原样重发一次（新会话、同一模型）", EventDescriber.line(retry))
        assertEquals(EventDescriber.Tone.Muted, EventDescriber.tone(retry))
        val stop = event("refusal", mapOf("action" to "stop", "reason" to "provider_safety", "note" to "blocked again"))
        assertEquals("服务商安全拦截：已停止 · blocked again", EventDescriber.line(stop))
        assertEquals(EventDescriber.Tone.Failure, EventDescriber.tone(stop))
        assertEquals(
            "原样重发 · Sonnet 5 · Claude Code",
            EventDescriber.line(event("redispatch", mapOf("kind" to "provider_safety", "target" to mapOf("harness" to "claude-code", "model" to "claude-sonnet-5")))),
        )
    }

    @Test
    fun testCiphertextsInLinesShowAsLocks() {
        val token = "enc:v1:" + "Q".repeat(90)
        val answered = event("approval_resolved", mapOf("decision" to "answer", "text" to "问 → 账号 $token\n  密码 $token"))
        assertEquals("已回答：问 → 账号 🔒密文\n  密码 🔒密文", EventDescriber.line(answered))
        assertFalse(EventDescriber.line(event("brand_new", mapOf("v" to token))).contains(token))
    }
}
