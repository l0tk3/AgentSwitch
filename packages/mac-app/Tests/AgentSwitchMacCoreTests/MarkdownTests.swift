import XCTest
@testable import AgentSwitchMacCore

/// Results and answers as Markdown blocks, sealed text with locks, search snippets and what a voice reads (ported from
/// the Kit's MarkdownTests, FeedTests, AttentionTests and AttachmentTests).
final class DispatchMarkdownTests: XCTestCase {
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
        XCTAssertEqual(DispatchMarkdown.blocks(text), [
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
        XCTAssertEqual(DispatchMarkdown.blocks(table), [
            .table(header: ["模型", "结果"], rows: [["sonnet", "ok"], ["opus", "**flagged**"]]),
            .paragraph("after"),
        ])
        XCTAssertEqual(DispatchMarkdown.blocks("```\nSSL: CERTIFICATE_VERIFY_FAILED\n"), [.code(language: nil, text: "SSL: CERTIFICATE_VERIFY_FAILED")])
        XCTAssertEqual(DispatchMarkdown.blocks("a | b without a separator"), [.paragraph("a | b without a separator")])
        XCTAssertEqual(DispatchMarkdown.blocks(""), [])
    }

    func testInlineKeepsTextDropsMarkersAndOnlyWebLinks() {
        let inline = DispatchMarkdown.inline("**原始报错** 在 `x.com` 上，见 [说明](https://example.com)")
        XCTAssertEqual(String(inline.characters), "原始报错 在 x.com 上，见 说明")
        XCTAssertEqual(inline.runs.first { $0.link != nil }?.link, URL(string: "https://example.com"))
        XCTAssertEqual(String(DispatchMarkdown.inline("![logo](https://tracker.example/p.png) text").characters), "logo text", "an image is only its alt text")
        XCTAssertEqual(String(DispatchMarkdown.inline("unbalanced **bold").characters), "unbalanced **bold")
        let schemes = DispatchMarkdown.inline("[重连](agentswitch://pair?p=x) [看](http://a.test) [js](javascript:alert(1))")
        XCTAssertEqual(schemes.runs.compactMap(\.link).map(\.absoluteString), ["http://a.test"], "only web links stay clickable")
    }

    func testFlattenedPreviewAndLocks() {
        let token = "enc:v1:" + String(repeating: "a_b", count: 10)
        let flat = String(DispatchMarkdown.flattened("## 摘要\n- 一 \(token)\n- 二\n\n```\ncode\n```\n| a | b |\n|---|---|\n| 1 | 2 |").characters)
        XCTAssertEqual(flat, "摘要\n• 一 🔒密文\n• 二\ncode\na · b\n1 · 2")
    }

    func testBoldBesideChinesePunctuation() {
        for (source, bold) in [("**未解决阻塞。**本次只读查询", "未解决阻塞。"), ("结论是**「正常」**。", "「正常」")] {
            let out = DispatchMarkdown.inline(source)
            let text = String(out.characters)
            XCTAssertFalse(text.contains("*"), text)
            XCTAssertFalse(text.contains("\u{200B}"), text)
            let strong = out.runs.filter { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
                .map { String(out[$0.range].characters) }.joined()
            XCTAssertEqual(strong, bold)
        }
    }

    func testSealedMessageReadsWithoutTheLegendOrLongTokens() {
        let token = "enc:v1:" + String(repeating: "A", count: 80) + "xyz789"
        let stored = "登录 https://fin.example.test 用 \(token) 查报表\n\n[AgentSwitch sealed the credentials in this message. The following field names …]\nCandidate record layout: password\n- \(token): password → fin.example.test"
        XCTAssertEqual(DispatchMessageDisplay.readable(stored), "登录 https://fin.example.test 用 🔒密文 查报表")
        XCTAssertEqual(DispatchMessageDisplay.readable("\(token) \(token)"), "🔒密文 🔒密文")
        XCTAssertEqual(DispatchMessageDisplay.readable("enc:v1:short"), "enc:v1:short", "only real-looking tokens are shortened")
    }

    func testMultipartBody() {
        let body = DispatchMultipart.body([DispatchUploadFile(name: "shot \"1\".png", type: "image/png", data: Data([1, 2])),
                                           DispatchUploadFile(name: "a\r\nb.txt", type: "", data: Data("x".utf8))], boundary: "B")
        let text = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("--B\r\nContent-Disposition: form-data; name=\"files\"; filename=\"shot %221%22.png\"\r\nContent-Type: image/png\r\n\r\n\u{1}\u{2}\r\n"))
        XCTAssertTrue(text.contains("filename=\"ab.txt\"\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n"), "no header injection, a default type")
        XCTAssertTrue(text.hasSuffix("--B--\r\n"))
    }
}
