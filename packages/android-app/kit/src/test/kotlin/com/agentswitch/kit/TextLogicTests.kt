package com.agentswitch.kit

import com.agentswitch.kit.feed.EffortScale
import com.agentswitch.kit.feed.ShellHighlight
import com.agentswitch.kit.feed.ShellHighlight.Kind
import com.agentswitch.kit.feed.Speech
import com.agentswitch.kit.feed.TerminalDraft
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Cases of the Swift test files that test only these types: `testSpeakableText` (AttachmentTests), the ShellHighlight
 * part of the Swift RecordTests' tool test and `testEffortAsAPlaceOnALine` (RecordTests), TerminalDraftTests (TerminalTests).
 */
class TextLogicTests {
    @Test
    fun testSpeakableText() {
        val token = "enc:v1:" + "A".repeat(40)
        assertEquals("结论：详见，chenju ai 说 可用。第二点 code", Speech.speakable("**结论**：详见 https://x.com/a/status/2103 ，@chenju_ai 说 $token 可用。\n- 第二点 `code`"))
        assertEquals("编号 太长", Speech.speakable("编号 2103074361611817341 太长"), "long id runs are dropped")
        assertEquals("", Speech.speakable("  "))
        assertEquals("密码是，已填入", Speech.speakable("密码是$token，已填入"), "a token right after Chinese is dropped too")
        assertEquals("发到 alice@example.com，并 @ 了 chenju ai", Speech.speakable("发到 alice@example.com，并 @ 了 @chenju_ai"))
        assertEquals("会话 已失效，version2 正常", Speech.speakable("会话 sk_live_9fQ2xLmP4rT8wZ1c 已失效，version2 正常"))
        assertEquals("见 这里", Speech.speakable("见 [removed: not a secret-gate token] 这里"))
    }

    @Test
    fun testShellHighlight() {
        fun r(text: String, kind: Kind) = ShellHighlight.Run(text, kind)
        assertEquals(
            listOf(
                r("cd", Kind.Command), r(" /a && ", Kind.Plain), r("git", Kind.Command), r(" commit -F - <<", Kind.Plain), r("'EOF'", Kind.String),
                r("\n", Kind.Plain), r("fix: it\nEOF", Kind.String), r("\n", Kind.Plain),
                r("git", Kind.Command), r(" log 2>&1 | ", Kind.Plain), r("head", Kind.Command), r(" -1 ", Kind.Plain), r("# last", Kind.Comment),
            ),
            ShellHighlight.runs("cd /a && git commit -F - <<'EOF'\nfix: it\nEOF\ngit log 2>&1 | head -1 # last"),
        )
        for (source in listOf("echo \"never closed", "cat <<EOF\nno end", "", "FOO=1 make 'a b'")) {
            assertEquals(source, ShellHighlight.runs(source).joinToString("") { it.text })
        }
    }

    /** The effort slider (2026-10-07, user: 思考强度改成滑块调节): the levels are stops on a line. */
    @Test
    fun testEffortAsAPlaceOnALine() {
        val levels = listOf("low", "medium", "high", "xhigh", "max")
        assertEquals(2, EffortScale.index("high", levels))
        assertNull(EffortScale.index(null, levels))
        // The nearest stop to where the finger is, never off the line's ends.
        assertEquals(listOf(0, 0, 0, 1, 2, 3, 3, 4, 4), listOf(-40.0, 0.0, 24.0, 26.0, 100.0, 149.0, 151.0, 200.0, 900.0).map { EffortScale.stop(it, 200.0, 5) })
        assertEquals(0, EffortScale.stop(50.0, 200.0, 1))
        assertEquals(listOf(0.0, 50.0, 100.0, 150.0, 200.0), (0 until 5).map { EffortScale.place(it, 200.0, 5) })
        assertEquals(listOf(0.0, 0.25, 0.5, 0.75, 1.0), (0 until 5).map { EffortScale.heat(it, 5) })
        // VoiceOver's step (TalkBack's here): one stop either way, stopping at the ends; from none chosen, the default.
        assertEquals(4, EffortScale.step(4, 1, null, 5))
        assertEquals(1, EffortScale.step(null, 1, 1, 5))
        assertNull(EffortScale.step(null, 1, null, 0))
    }

    /** Pictures and files in a terminal reply (2026-09-30, user: 图片只能插到消息开头……要和 cc 一样给占位符). */
    @Test
    fun testPlaceholdersGoWhereTheCaretIsSpacedAsTyped() {
        assertEquals("[Image #1]", TerminalDraft.token(image = true, number = 1))
        assertEquals("[File #2]", TerminalDraft.token(image = false, number = 2))
        var r = TerminalDraft.insert(listOf("[Image #1]"), "看这张哪里不对", 3)
        assertEquals("看这张 [Image #1] 哪里不对", r.text)
        assertEquals(15, r.caret)
        r = TerminalDraft.insert(listOf("[Image #1]", "[File #2]"), "", null)
        assertEquals("[Image #1] [File #2] ", r.text)
        r = TerminalDraft.insert(listOf("[Image #3]"), "a b", 1)
        assertEquals("a [Image #3] b", r.text, "the space already there is not doubled")
        assertEquals("看这张 哪里不对", TerminalDraft.remove("[Image #1]", "看这张 [Image #1] 哪里不对"))
    }
}
