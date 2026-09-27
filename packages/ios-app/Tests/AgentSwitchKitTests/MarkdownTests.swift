import XCTest
@testable import AgentSwitchKit

/// Model output is Markdown; the phone renders it by blocks (headings, lists, code, quotes, tables) with Foundation's
/// inline parser inside each block. No images are ever loaded.
final class MarkdownTests: XCTestCase {
    func testBlocks() {
        let text = """
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
        """
        XCTAssertEqual(Markdown.blocks(text), [
            .heading(level: 1, text: "结果"),
            .paragraph("已完成原任务：**登录** x.com。\n第二行紧跟着"),
            .listItem(depth: 0, ordinal: nil, text: "第一条\n续行"),
            .listItem(depth: 0, ordinal: nil, text: "第二条"),
            .listItem(depth: 1, ordinal: nil, text: "嵌套"),
            .listItem(depth: 0, ordinal: 1, text: "一"),
            .listItem(depth: 0, ordinal: 2, text: "二"),
            .quote("引用一\n引用二"),
            .code(language: "json", text: "{\"a\": 1}"),
            .rule,
        ])
    }

    func testTablesAndUnterminatedFences() {
        let table = """
        | 模型 | 结果 |
        |---|:---:|
        | sonnet | ok |
        | opus | **flagged** |
        after
        """
        XCTAssertEqual(Markdown.blocks(table), [
            .table(header: ["模型", "结果"], rows: [["sonnet", "ok"], ["opus", "**flagged**"]]),
            .paragraph("after"),
        ])
        XCTAssertEqual(Markdown.blocks("```\nSSL: CERTIFICATE_VERIFY_FAILED\n"), [.code(language: nil, text: "SSL: CERTIFICATE_VERIFY_FAILED")])
        XCTAssertEqual(Markdown.blocks("a | b without a separator"), [.paragraph("a | b without a separator")])
        XCTAssertEqual(Markdown.blocks(""), [])
    }

    func testInlineKeepsTextDropsMarkers() {
        let inline = Markdown.inline("**原始报错** 在 `x.com` 上，见 [说明](https://example.com)")
        XCTAssertEqual(String(inline.characters), "原始报错 在 x.com 上，见 说明")
        XCTAssertEqual(inline.runs.first { $0.link != nil }?.link, URL(string: "https://example.com"))
        XCTAssertEqual(String(Markdown.inline("![logo](https://tracker.example/p.png) text").characters), "logo text", "an image is only its alt text")
        XCTAssertEqual(String(Markdown.inline("unbalanced **bold").characters), "unbalanced **bold")
        let schemes = Markdown.inline("[重连](agentswitch://pair?p=x) [看](http://a.test) [js](javascript:alert(1))")
        XCTAssertEqual(schemes.runs.compactMap(\.link).map(\.absoluteString), ["http://a.test"], "only web links stay tappable")
        XCTAssertEqual(String(schemes.characters), "重连 看 js")
    }

    func testFlattenedPreviewAndLocks() {
        let token = "enc:v1:" + String(repeating: "a_b", count: 10)
        let flat = String(Markdown.flattened("## 摘要\n- 一 \(token)\n- 二\n\n```\ncode\n```\n| a | b |\n|---|---|\n| 1 | 2 |").characters)
        XCTAssertEqual(flat, "摘要\n• 一 🔒密文\n• 二\ncode\na · b\n1 · 2")
    }

    func testTheRealXResultReadsAsBlocks() {
        let result = """
        已完成原任务：登录 x.com、检索「kyc 护照」相关内容并整理为简体中文摘要。

        摘要覆盖的帖子（均标注为页面直接观察）：
        - @chenju_ai（陈局）：正文原文「CLAUDE KYC…」
        - @CryptoJHK 多条相关帖
        - 其余帖涉及护照/KYC 隐私风险提醒
        """
        let blocks = Markdown.blocks(result)
        XCTAssertEqual(blocks.count, 5)
        XCTAssertEqual(blocks.filter { if case .listItem = $0 { return true } else { return false } }.count, 3)
    }

    /// Bold next to Chinese punctuation (2026-09-25: "**未解决阻塞。**本次" showed its asterisks).
    func testBoldBesideChinesePunctuation() {
        for (source, bold) in [("**未解决阻塞。**本次只读查询", "未解决阻塞。"), ("结论是**「正常」**。", "「正常」")] {
            let out = Markdown.inline(source)
            let text = String(out.characters)
            XCTAssertFalse(text.contains("*"), text)
            XCTAssertFalse(text.contains("\u{200B}"), text)
            let strong = out.runs.filter { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
                .map { String(out[$0.range].characters) }.joined()
            XCTAssertEqual(strong, bold)
        }
        XCTAssertEqual(String(Markdown.inline("a **b** c").characters), "a b c")
    }
}
