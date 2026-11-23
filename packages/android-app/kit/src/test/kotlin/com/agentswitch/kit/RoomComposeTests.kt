package com.agentswitch.kit

import com.agentswitch.kit.api.RoomAttachTokens
import com.agentswitch.kit.api.RoomMarkdown
import com.agentswitch.kit.api.RoomSessionSearch
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalProfile
import com.agentswitch.kit.api.TerminalStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The box's attachment tokens, the add-sessions search and a message's Markdown (the Mac's 2026-11-23 change). The iPhone's RoomTests. */
class RoomComposeTests {
    @Test
    fun attachTokensStandForFilesInTheBox() {
        val t = RoomAttachTokens()
        assertEquals("[Image #1]", t.add("1", "photo-1.jpg"))
        assertEquals("[Image #2]", t.add("2", "photo-2.PNG"))
        assertEquals("[File notes.md]", t.add("/a/notes.md"))
        assertEquals("[File notes.md #2]", t.add("/b/notes.md"))
        assertEquals("[Image #1]", t.add("1", "photo-1.jpg"))
        assertEquals(emptyList(), t.gone(""))
        assertEquals(emptyList(), t.gone("看 [Image #1] [Image #2] [File notes.md] [File notes.md #2]"))
        assertEquals(listOf("2"), t.gone("看 [Image #1] [File notes.md] [File notes.md #2]"))
        assertEquals("[File notes.md]", t.forget("/a/notes.md"))
        assertEquals("[Image #2]", t.add("3", "x.heic"))
        assertEquals("看 [Image #1] ", RoomAttachTokens.appended(listOf("[Image #1]"), "看"))
        assertEquals("[Image #1] [Image #2] ", RoomAttachTokens.appended(listOf("[Image #1]", "[Image #2]"), ""))
        assertEquals("看 这个", RoomAttachTokens.removing("[Image #1]", "看 [Image #1] 这个"))
    }

    @Test
    fun addSessionsSearch() {
        val a = TerminalInfo(id = "t1", harness = "claude-code", cwd = "/Users/u/Work/api", model = "claude-opus-5-5", name = "修复登录", status = TerminalStatus.Idle,
            createdAt = 1, lastOutputAt = 1, profile = TerminalProfile(name = "Work"))
        val b = TerminalInfo(id = "t2", harness = "codex", cwd = "/Users/u/Play/site", model = "gpt-6-luna", name = "Site", status = TerminalStatus.Idle, createdAt = 1, lastOutputAt = 1)
        val all = listOf(a, b)
        fun ids(q: String) = RoomSessionSearch.filter(all, q).map { it.id }
        assertEquals(listOf("t1", "t2"), ids("  "))
        assertEquals(listOf("t1"), ids("登录"))
        assertEquals(listOf("t2"), ids("CODEX"))
        assertEquals(listOf("t1"), ids("claude code"))
        assertEquals(listOf("t1"), ids("opus 5.5"))
        assertEquals(listOf("t2"), ids("luna"))
        assertEquals(listOf("t1"), ids("work"))
        assertEquals(listOf("t2"), ids("play/site"))
        assertEquals(emptyList(), ids("nothing"))
    }

    @Test
    fun markdownOfAMessage() {
        val cjk = RoomMarkdown.runs("**原因**：dpsk", lineStart = true)
        assertEquals("原因：dpsk", cjk.text)
        assertEquals(listOf("原因"), cjk.runs.filter { it.bold }.map { it.text })
        val list = RoomMarkdown.runs("# 结果\n- *过期*的令牌\n  * 二级\n+ ~~旧~~\n2 * 3 = 6", lineStart = true)
        assertEquals("结果\n• 过期的令牌\n  • 二级\n• 旧\n2 * 3 = 6", list.text)
        assertEquals(listOf("结果"), list.runs.filter { it.bold }.map { it.text })
        assertTrue(list.runs.any { it.italic && it.text == "过期" })
        assertTrue(list.runs.any { it.strikethrough && it.text == "旧" })
        val link = RoomMarkdown.runs("看 [文档](https://example.com/a)", lineStart = true)
        assertEquals("看 文档", link.text)
        assertEquals("https://example.com/a", link.runs.firstNotNullOf { it.link })
        // A stretch after a mention does not start a line: its `-` stays; the spaces around it stay too.
        assertEquals("- x", RoomMarkdown.runs("- x", lineStart = false).text)
        assertEquals(" 你好 ", RoomMarkdown.runs(" 你好 ", lineStart = false).text)
        // An attachment token stays as typed.
        assertEquals("看 [Image #1] ", RoomMarkdown.runs("看 [Image #1] ", lineStart = true).text)
    }
}
