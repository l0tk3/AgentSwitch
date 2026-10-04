import AgentSwitchKit
import SwiftUI

/// Model output rendered by blocks (AgentSwitchKit `Markdown`): headings, lists, quotes, code (CodeBlock) and tables,
/// with inline Markdown inside each (its code on the code wash). A link tapped opens in the Mac's shared browser, on
/// the Browser tab (RootView's `openURL`; Safari when the Mac has none); images are never loaded, only their alt text shows.
struct MarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Markdown.readableBlocks(text).enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(inline(text)).font(Self.headingFont(level)).padding(.top, 2)
        case .paragraph(let text):
            Text(inline(text))
        case .listItem(let depth, let ordinal, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ordinal.map { "\($0)." } ?? "•").monospacedDigit().foregroundStyle(.secondary)
                Text(inline(text))
            }
            .padding(.leading, CGFloat(depth) * 16)
        case .quote(let text):
            HStack(alignment: .top, spacing: 8) {
                Rectangle().fill(.tertiary).frame(width: 3)
                Text(inline(text)).foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text):
            CodeBlock(code: text, language: language)
        case .table(let header, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    GridRow {
                        ForEach(header.indices, id: \.self) { c in Text(inline(header[c])).bold() }
                    }
                    Divider()
                    ForEach(rows.indices, id: \.self) { r in
                        GridRow {
                            ForEach(rows[r].indices, id: \.self) { c in Text(inline(rows[r][c])) }
                        }
                    }
                }
                .font(.callout)
                .padding(10)
            }
            .background(Theme.raised)
            .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
        case .rule:
            Divider()
        }
    }

    /// Inline Markdown with its code on the code wash.
    private func inline(_ text: String) -> AttributedString {
        Markdown.inline(text).codeWashed()
    }

    private static func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title3.bold()
        case 2: return .headline
        default: return .subheadline.bold()
        }
    }
}

#Preview {
    ScrollView {
        MarkdownView(text: "# 结果\n已完成：**登录** x.com，见 [说明](https://example.com)。\n\n- 第一条\n  - 嵌套\n1. 一\n\n> 引用\n\n```\nSSL: CERTIFICATE_VERIFY_FAILED\n```\n| 模型 | 结果 |\n|---|---|\n| sonnet | ok |")
            .padding()
    }
}
