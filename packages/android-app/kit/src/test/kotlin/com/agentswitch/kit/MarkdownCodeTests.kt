package com.agentswitch.kit

import com.agentswitch.kit.feed.InlineText
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.MarkdownBlock
import com.agentswitch.kit.feed.codeSpans
import com.agentswitch.kit.feed.typedBlocks
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Code in what Dispatch shows (2026-10-03, user: dispatch里加上代码块支持吧 …… 手机上也是): what a person typed keeps
 * every character, only its fences and backtick spans read as code; model output's fences follow the same rule
 * (the Mac Core's DispatchCodeTests, the same cases).
 */
class MarkdownCodeTests {
    private fun code(text: InlineText): List<String> = text.runs.filter { it.code }.map { it.text }

    @Test
    fun testTypedTextSplitsOnlyAtFences() {
        val typed = "跑一下这两条，把输出贴回来：\n```bash\ngit status --short\nnpm test -- --reporter=dot\n```\n\n然后告诉我结果"
        assertEquals(
            listOf(
                MarkdownBlock.Paragraph("跑一下这两条，把输出贴回来："),
                MarkdownBlock.Code("bash", "git status --short\nnpm test -- --reporter=dot"),
                MarkdownBlock.Paragraph("然后告诉我结果"),
            ),
            Markdown.typedBlocks(typed),
        )
    }

    @Test
    fun testTypedTextKeepsWhatLooksLikeMarkdown() {
        val typed = "# 不是标题\n- 不是列表\n1. 也不是\n*星号* 和 _下划线_ 原样\n\n\n空行也在"
        assertEquals(listOf(MarkdownBlock.Paragraph(typed)), Markdown.typedBlocks(typed))
        assertEquals(typed, Markdown.codeSpans(typed).text, "nothing but code is read")
        assertEquals(emptyList(), Markdown.typedBlocks(""))
    }

    @Test
    fun testAnOpenFenceRunsToTheEnd() {
        assertEquals(
            listOf(
                MarkdownBlock.Paragraph("看这个："),
                MarkdownBlock.Code(null, "ls -la\nfind . -name \"*.md\""),
            ),
            Markdown.typedBlocks("看这个：\n~~~\nls -la\nfind . -name \"*.md\""),
        )
    }

    @Test
    fun testFenceRules() {
        // ```ls``` on a line is a code span, not a fence.
        assertEquals(listOf(MarkdownBlock.Paragraph("```ls``` 是行内代码")), Markdown.typedBlocks("```ls``` 是行内代码"))
        assertEquals(listOf("ls"), code(Markdown.codeSpans("```ls``` 是行内代码")))
        // Only a bare fence of the same mark and at least its length closes: a longer fence holds a shorter one.
        assertEquals(listOf(MarkdownBlock.Code("md", "```bash\nls\n```")), Markdown.typedBlocks("````md\n```bash\nls\n```\n````"))
        assertEquals(listOf(MarkdownBlock.Code(null, "a\n```bash\nb\n~~~")), Markdown.typedBlocks("```\na\n```bash\nb\n~~~\n```"))
        // A fence under a list item: its indentation comes off the block's lines, no more than each has.
        assertEquals(
            listOf(
                MarkdownBlock.Paragraph("- 步骤："),
                MarkdownBlock.Code("sh", "make\n  make install\ndone"),
            ),
            Markdown.typedBlocks("- 步骤：\n  ```sh\n  make\n    make install\n done\n  ```"),
        )
    }

    @Test
    fun testModelOutputUsesTheSameFences() {
        assertEquals(
            listOf(
                MarkdownBlock.Paragraph("结果："),
                MarkdownBlock.Code(null, "ok\n```text\nstill code"),
            ),
            Markdown.blocks("结果：\n\n```\nok\n```text\nstill code\n```"),
        )
        assertEquals(listOf(MarkdownBlock.Paragraph("```ls``` 也是行内代码")), Markdown.blocks("```ls``` 也是行内代码"))
        assertEquals(listOf(MarkdownBlock.Code("python", "print(1)")), Markdown.blocks("```python title=x\nprint(1)\n```"))
    }

    @Test
    fun testCodeSpans() {
        val spans = Markdown.codeSpans("运行 `npm test` 和 ``a`b``，*星号* 不变，`没闭合")
        assertEquals("运行 npm test 和 a`b，*星号* 不变，`没闭合", spans.text)
        assertEquals(listOf("npm test", "a`b"), code(spans))
        assertEquals(listOf("padded", "  "), code(Markdown.codeSpans("` padded ` and `  `")), "one space off both ends, unless all spaces")
        val split = Markdown.codeSpans("`a\nb`")
        assertEquals("`a\nb`", split.text, "a span stays on one line")
        assertEquals(emptyList(), code(split))
    }
}
