import AgentSwitchKit
import SwiftUI

/// Model output rendered by blocks (AgentSwitchKit `Markdown`): headings, lists, quotes, code and tables, with inline
/// Markdown inside each. Links open in the browser when tapped; images are never loaded, only their alt text shows.
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
            Text(Markdown.inline(text)).font(Self.headingFont(level)).padding(.top, 2)
        case .paragraph(let text):
            Text(Markdown.inline(text))
        case .listItem(let depth, let ordinal, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ordinal.map { "\($0)." } ?? "•").monospacedDigit().foregroundStyle(.secondary)
                Text(Markdown.inline(text))
            }
            .padding(.leading, CGFloat(depth) * 16)
        case .quote(let text):
            HStack(alignment: .top, spacing: 8) {
                Rectangle().fill(.tertiary).frame(width: 3)
                Text(Markdown.inline(text)).foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text).font(.caption.monospaced()).padding(10)
            }
            .background(Theme.raised)
            .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
        case .table(let header, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    GridRow {
                        ForEach(header.indices, id: \.self) { c in Text(Markdown.inline(header[c])).bold() }
                    }
                    Divider()
                    ForEach(rows.indices, id: \.self) { r in
                        GridRow {
                            ForEach(rows[r].indices, id: \.self) { c in Text(Markdown.inline(rows[r][c])) }
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
