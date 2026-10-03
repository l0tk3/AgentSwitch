import XCTest
@testable import AgentSwitchKit

/// Code in what Dispatch shows (2026-10-03, user: dispatch里加上代码块支持吧 …… 手机上也是): what a person typed keeps
/// every character, only its fences and backtick spans read as code; model output's fences follow the same rule
/// (the Mac Core's DispatchCodeTests, the same cases).
final class MarkdownCodeTests: XCTestCase {
    private func code(_ text: AttributedString) -> [String] {
        text.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }.map { String(text[$0.range].characters) }
    }

    func testTypedTextSplitsOnlyAtFences() {
        let typed = "跑一下这两条，把输出贴回来：\n```bash\ngit status --short\nnpm test -- --reporter=dot\n```\n\n然后告诉我结果"
        XCTAssertEqual(Markdown.typedBlocks(typed), [
            .paragraph("跑一下这两条，把输出贴回来："),
            .code(language: "bash", text: "git status --short\nnpm test -- --reporter=dot"),
            .paragraph("然后告诉我结果"),
        ])
    }

    func testTypedTextKeepsWhatLooksLikeMarkdown() {
        let typed = "# 不是标题\n- 不是列表\n1. 也不是\n*星号* 和 _下划线_ 原样\n\n\n空行也在"
        XCTAssertEqual(Markdown.typedBlocks(typed), [.paragraph(typed)])
        XCTAssertEqual(String(Markdown.codeSpans(typed).characters), typed, "nothing but code is read")
        XCTAssertEqual(Markdown.typedBlocks(""), [])
    }

    func testAnOpenFenceRunsToTheEnd() {
        XCTAssertEqual(Markdown.typedBlocks("看这个：\n~~~\nls -la\nfind . -name \"*.md\""), [
            .paragraph("看这个："),
            .code(language: nil, text: "ls -la\nfind . -name \"*.md\""),
        ])
    }

    func testFenceRules() {
        // ```ls``` on a line is a code span, not a fence.
        XCTAssertEqual(Markdown.typedBlocks("```ls``` 是行内代码"), [.paragraph("```ls``` 是行内代码")])
        XCTAssertEqual(code(Markdown.codeSpans("```ls``` 是行内代码")), ["ls"])
        // Only a bare fence of the same mark and at least its length closes: a longer fence holds a shorter one.
        XCTAssertEqual(Markdown.typedBlocks("````md\n```bash\nls\n```\n````"), [.code(language: "md", text: "```bash\nls\n```")])
        XCTAssertEqual(Markdown.typedBlocks("```\na\n```bash\nb\n~~~\n```"), [.code(language: nil, text: "a\n```bash\nb\n~~~")])
        // A fence under a list item: its indentation comes off the block's lines, no more than each has.
        XCTAssertEqual(Markdown.typedBlocks("- 步骤：\n  ```sh\n  make\n    make install\n done\n  ```"), [
            .paragraph("- 步骤："),
            .code(language: "sh", text: "make\n  make install\ndone"),
        ])
    }

    func testModelOutputUsesTheSameFences() {
        XCTAssertEqual(Markdown.blocks("结果：\n\n```\nok\n```text\nstill code\n```"), [
            .paragraph("结果："),
            .code(language: nil, text: "ok\n```text\nstill code"),
        ])
        XCTAssertEqual(Markdown.blocks("```ls``` 也是行内代码"), [.paragraph("```ls``` 也是行内代码")])
        XCTAssertEqual(Markdown.blocks("```python title=x\nprint(1)\n```"), [.code(language: "python", text: "print(1)")])
    }

    func testCodeSpans() {
        let spans = Markdown.codeSpans("运行 `npm test` 和 ``a`b``，*星号* 不变，`没闭合")
        XCTAssertEqual(String(spans.characters), "运行 npm test 和 a`b，*星号* 不变，`没闭合")
        XCTAssertEqual(code(spans), ["npm test", "a`b"])
        XCTAssertEqual(code(Markdown.codeSpans("` padded ` and `  `")), ["padded", "  "], "one space off both ends, unless all spaces")
        let split = Markdown.codeSpans("`a\nb`")
        XCTAssertEqual(String(split.characters), "`a\nb`", "a span stays on one line")
        XCTAssertEqual(code(split), [])
    }
}
