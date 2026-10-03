import AgentSwitchMacCore
import SwiftUI

/// Model output by blocks (DispatchMarkdown, ported from the phone's MarkdownView): headings, lists, quotes, code and
/// tables, with inline Markdown inside each; links open in the browser, images are never loaded. Answers and results
/// are read in the system font (docs/dispatch-v0.md §2); `size` is the paragraph's.
struct MarkdownBlocks: View {
    let text: String
    var size: CGFloat = 14
    var color: Color = Look.ink
    var lineSpacing: CGFloat = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(DispatchMarkdown.readableBlocks(text).enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block, size: size, lineSpacing: lineSpacing)
            }
        }
        .foregroundStyle(color)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownBlockView: View {
    let block: DispatchMarkdownBlock
    let size: CGFloat
    let lineSpacing: CGFloat

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(DispatchMarkdown.inline(text))
                .font(.system(size: level == 1 ? size + 3 : level == 2 ? size + 1 : size, weight: .semibold))
                .padding(.top, 2)
        case .paragraph(let text):
            paragraph(DispatchMarkdown.inline(text))
        case .listItem(let depth, let ordinal, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ordinal.map { "\($0)." } ?? "•").font(.system(size: size).monospacedDigit()).foregroundStyle(Look.ink2)
                paragraph(DispatchMarkdown.inline(text))
            }
            .padding(.leading, CGFloat(depth) * 16)
        case .quote(let text):
            HStack(alignment: .top, spacing: 8) {
                Rectangle().fill(Look.faint).frame(width: 2)
                paragraph(DispatchMarkdown.inline(text)).foregroundStyle(Look.ink2)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text).font(.system(size: size - 2, design: .monospaced)).padding(10)
            }
            .background(Look.raised)
            .overlay(Rectangle().strokeBorder(Look.line, lineWidth: 1))
        case .table(let header, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    GridRow {
                        ForEach(header.indices, id: \.self) { c in Text(DispatchMarkdown.inline(header[c])).bold() }
                    }
                    Rectangle().fill(Look.line).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                    ForEach(rows.indices, id: \.self) { r in
                        GridRow {
                            ForEach(rows[r].indices, id: \.self) { c in Text(DispatchMarkdown.inline(rows[r][c])) }
                        }
                    }
                }
                .font(.system(size: size - 1))
                .padding(10)
            }
            .background(Look.raised)
            .overlay(Rectangle().strokeBorder(Look.line, lineWidth: 1))
        case .rule:
            DottedRule(color: Look.line)
        }
    }

    private func paragraph(_ text: AttributedString) -> some View {
        Text(text).font(.system(size: size)).lineSpacing(lineSpacing).fixedSize(horizontal: false, vertical: true)
    }
}
