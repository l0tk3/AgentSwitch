package com.agentswitch.kit

import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.MarkdownBlock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * Model output is Markdown; the phone renders it by blocks (headings, lists, code, quotes, tables) with an inline
 * parser inside each block. No images are ever loaded.
 */
class MarkdownTests {
    @Test
    fun testBlocks() {
        val text = """
            # 结果
            已完成原任务：**登录** x.com。
            第二行紧跟着

            - 第一条
              续行
            - 第二条
              - 嵌套
            1. 一
            2) 二

            > 引用一
            > 引用二

            ```json
            {"a": 1}
            ```
            ---
        """.trimIndent()
        assertEquals(
            listOf(
                MarkdownBlock.Heading(1, "结果"),
                MarkdownBlock.Paragraph("已完成原任务：**登录** x.com。\n第二行紧跟着"),
                MarkdownBlock.ListItem(0, null, "第一条\n续行"),
                MarkdownBlock.ListItem(0, null, "第二条"),
                MarkdownBlock.ListItem(1, null, "嵌套"),
                MarkdownBlock.ListItem(0, 1, "一"),
                MarkdownBlock.ListItem(0, 2, "二"),
                MarkdownBlock.Quote("引用一\n引用二"),
                MarkdownBlock.Code("json", "{\"a\": 1}"),
                MarkdownBlock.Rule,
            ),
            Markdown.blocks(text),
        )
    }

    @Test
    fun testTablesAndUnterminatedFences() {
        val table = """
            | 模型 | 结果 |
            |---|:---:|
            | sonnet | ok |
            | opus | **flagged** |
            after
        """.trimIndent()
        assertEquals(
            listOf(
                MarkdownBlock.Table(listOf("模型", "结果"), listOf(listOf("sonnet", "ok"), listOf("opus", "**flagged**"))),
                MarkdownBlock.Paragraph("after"),
            ),
            Markdown.blocks(table),
        )
        assertEquals(listOf(MarkdownBlock.Code(null, "SSL: CERTIFICATE_VERIFY_FAILED")), Markdown.blocks("```\nSSL: CERTIFICATE_VERIFY_FAILED\n"))
        assertEquals(listOf(MarkdownBlock.Paragraph("a | b without a separator")), Markdown.blocks("a | b without a separator"))
        assertEquals(emptyList(), Markdown.blocks(""))
    }

    @Test
    fun testInlineKeepsTextDropsMarkers() {
        val inline = Markdown.inline("**原始报错** 在 `x.com` 上，见 [说明](https://example.com)")
        assertEquals("原始报错 在 x.com 上，见 说明", inline.text)
        assertEquals("https://example.com", inline.runs.firstOrNull { it.link != null }?.link)
        assertEquals("说明", inline.runs.first { it.link != null }.text)
        assertEquals(true, inline.runs.first { it.text == "原始报错" }.bold)
        assertEquals(true, inline.runs.first { it.text == "x.com" }.code)
        assertEquals("logo text", Markdown.inline("![logo](https://tracker.example/p.png) text").text, "an image is only its alt text")
        assertEquals(null, Markdown.inline("![logo](https://tracker.example/p.png) text").runs.firstNotNullOfOrNull { it.link }, "an image loads nothing and links nothing")
        assertEquals("unbalanced **bold", Markdown.inline("unbalanced **bold").text)
        val schemes = Markdown.inline("[重连](agentswitch://pair?p=x) [看](http://a.test) [js](javascript:alert(1))")
        assertEquals(listOf("http://a.test"), schemes.runs.mapNotNull { it.link }, "only web links stay tappable")
        assertEquals("重连 看 js", schemes.text)
    }

    @Test
    fun testFlattenedPreviewAndLocks() {
        val token = "enc:v1:" + "a_b".repeat(10)
        val flat = Markdown.flattened("## 摘要\n- 一 $token\n- 二\n\n```\ncode\n```\n| a | b |\n|---|---|\n| 1 | 2 |").text
        assertEquals("摘要\n• 一 🔒密文\n• 二\ncode\na · b\n1 · 2", flat)
    }

    @Test
    fun testTheRealXResultReadsAsBlocks() {
        val result = """
            已完成原任务：登录 x.com、检索「kyc 护照」相关内容并整理为简体中文摘要。

            摘要覆盖的帖子（均标注为页面直接观察）：
            - @chenju_ai（陈局）：正文原文「CLAUDE KYC…」
            - @CryptoJHK 多条相关帖
            - 其余帖涉及护照/KYC 隐私风险提醒
        """.trimIndent()
        val blocks = Markdown.blocks(result)
        assertEquals(5, blocks.size)
        assertEquals(3, blocks.count { it is MarkdownBlock.ListItem })
    }

    /** Bold next to Chinese punctuation (2026-09-25: "**未解决阻塞。**本次" showed its asterisks). */
    @Test
    fun testBoldBesideChinesePunctuation() {
        for ((source, bold) in listOf("**未解决阻塞。**本次只读查询" to "未解决阻塞。", "结论是**「正常」**。" to "「正常」")) {
            val out = Markdown.inline(source)
            val text = out.text
            assertFalse(text.contains("*"), text)
            assertFalse(text.contains("​"), text)
            val strong = out.runs.filter { it.bold }.joinToString("") { it.text }
            assertEquals(bold, strong)
        }
        assertEquals("a b c", Markdown.inline("a **b** c").text)
    }

    // Beyond the Swift tests: what Foundation's parser does with the rest of inline syntax, as probed there.

    @Test
    fun inlineStylesAndAddresses() {
        val styles = Markdown.inline("a **b** *c* _d_ ~~e~~ ~f~ `g` ***h***")
        assertEquals("a b c d e f g h", styles.text)
        assertEquals(listOf("b", "h"), styles.runs.filter { it.bold }.map { it.text })
        assertEquals(listOf("c", "d", "h"), styles.runs.filter { it.italic }.map { it.text })
        assertEquals(listOf("e", "f"), styles.runs.filter { it.strikethrough }.map { it.text })
        assertEquals(listOf("g"), styles.runs.filter { it.code }.map { it.text })
        assertEquals("a_b_c foo*bar*baz".replace("*", ""), Markdown.inline("a_b_c foo*bar*baz").text)
        assertEquals("<b>hi</b> x", Markdown.inline("<b>hi</b> x").text, "raw HTML stays text")
        assertEquals("a*b & <xA", Markdown.inline("a\\*b &amp; &lt;x&#65;").text)
        assertEquals("a b", Markdown.inline("`a\nb`").text, "a newline in a code span is a space")

        val bare = Markdown.inline("see https://a.com/x. ok")
        assertEquals(listOf("https://a.com/x"), bare.runs.mapNotNull { it.link })
        assertEquals(listOf("http://www.example.com"), Markdown.inline("www.example.com x").runs.mapNotNull { it.link })
        assertEquals(listOf("https://x.com"), Markdown.inline("<https://x.com> <a@b.co>").runs.mapNotNull { it.link })
        // An address followed by Chinese text with no space: cut where the address ends.
        val cjk = Markdown.inline("见 https://example.com/a。然后 https://b.test/c")
        assertEquals(listOf("https://example.com/a", "https://b.test/c"), cjk.runs.mapNotNull { it.link })
        assertEquals("见 https://example.com/a。然后 https://b.test/c", cjk.text)
        // An address in backticks is a link too.
        val code = Markdown.inline("`https://a.test/x`")
        assertEquals(listOf("https://a.test/x"), code.runs.mapNotNull { it.link })
        assertEquals(true, code.runs.single().code)
        assertEquals(listOf("http://x.com/%E4%B8%AD%E6%96%87"), Markdown.inline("[a](http://x.com/中文)").runs.mapNotNull { it.link })
    }

    @Test
    fun linksInTextInOrderEachOnce() {
        val found = Markdown.links("see [x](https://a.test/1) and https://a.test/1 then\n```\ncurl https://b.test/2\n```\n[no](agentswitch://pair)")
        assertEquals(listOf("https://a.test/1", "https://b.test/2"), found.map { (it as com.agentswitch.kit.feed.TappedLink.Web).address })
    }
}
