import AgentSwitchMacCore
import SwiftUI

/// Model output by blocks (DispatchMarkdown, ported from the phone's MarkdownView): headings, lists, quotes, code
/// (CodeBlockView) and tables, with inline Markdown inside each; links open in the browser, images are never loaded.
/// Answers and results are read in the system font (docs/dispatch-v0.md §2); `size` is the paragraph's.
struct MarkdownBlocks: View {
    let text: String
    var size: CGFloat = 14
    var color: Color = Look.ink
    var lineSpacing: CGFloat = 4
    /// Between one block and the next.
    var blockSpacing: CGFloat = 8

    var body: some View {
        VStack(alignment: .leading, spacing: blockSpacing) {
            ForEach(Array(Self.runs(DispatchMarkdown.readableBlocks(text)).enumerated()), id: \.offset) { _, run in
                switch run {
                case .prose(let blocks):
                    ProseText(blocks: blocks, size: size, color: color, lineSpacing: lineSpacing, blockSpacing: blockSpacing)
                case .apart(let block):
                    MarkdownBlockView(block: block, size: size, lineSpacing: lineSpacing)
                }
            }
        }
        .foregroundStyle(color)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Prose next to prose is one text, selectable across (ProseText); code and a table are views of their own.
    enum Run { case prose([DispatchMarkdownBlock]), apart(DispatchMarkdownBlock) }

    static func runs(_ blocks: [DispatchMarkdownBlock]) -> [Run] {
        #if DEBUG
        // `-proseApart YES`: every block a view of its own, as before ProseText (for comparing in a probe).
        if UserDefaults.standard.bool(forKey: "proseApart") { return blocks.map(Run.apart) }
        #endif
        var out: [Run] = []
        for block in blocks {
            switch block {
            case .code, .table:
                out.append(.apart(block))
            default:
                if case .prose(let before) = out.last { out[out.count - 1] = .prose(before + [block]) } else { out.append(.prose([block])) }
            }
        }
        return out
    }
}

private struct MarkdownBlockView: View {
    let block: DispatchMarkdownBlock
    let size: CGFloat
    let lineSpacing: CGFloat
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(inline(text))
                .font(.system(size: level == 1 ? size + 3 : level == 2 ? size + 1 : size, weight: .semibold))
                .padding(.top, 2)
        case .paragraph(let text):
            paragraph(inline(text))
        case .listItem(let depth, let ordinal, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ordinal.map { "\($0)." } ?? "•").font(.system(size: size).monospacedDigit()).foregroundStyle(Look.ink2)
                paragraph(inline(text))
            }
            .padding(.leading, CGFloat(depth) * 16)
        case .quote(let text):
            HStack(alignment: .top, spacing: 8) {
                Rectangle().fill(Look.faint).frame(width: 2)
                paragraph(inline(text)).foregroundStyle(Look.ink2)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text):
            CodeBlockView(code: text, language: language, size: size - 2)
        case .table(let header, let rows):
            if look.isClassic { classicTable(header, rows) } else { boxedTable(header, rows) }
        case .rule:
            HairRule(color: Look.line)
        }
    }

    private func boxedTable(_ header: [String], _ rows: [[String]]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow {
                    ForEach(header.indices, id: \.self) { c in Text(inline(header[c])).bold() }
                }
                Rectangle().fill(Look.line).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                ForEach(rows.indices, id: \.self) { r in
                    GridRow {
                        ForEach(rows[r].indices, id: \.self) { c in Text(inline(rows[r][c])) }
                    }
                }
            }
            .font(.system(size: size - 1))
            .padding(10)
        }
        .background(Look.raised)
        .framed(Look.line, radius: 8)
    }

    /// Classic (user #469): no box around it — the head's words quieter, a hairline under each row, as wide as it is.
    private func classicTable(_ header: [String], _ rows: [[String]]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 0) {
                GridRow {
                    ForEach(header.indices, id: \.self) { c in
                        Text(inline(header[c])).font(.system(size: size - 1.5, weight: .semibold)).foregroundStyle(Look.ink2).padding(.vertical, 7)
                    }
                }
                Rectangle().fill(Look.ring).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                ForEach(rows.indices, id: \.self) { r in
                    GridRow {
                        ForEach(rows[r].indices, id: \.self) { c in Text(inline(rows[r][c])).padding(.vertical, 7) }
                    }
                    if r < rows.count - 1 { Rectangle().fill(Look.ring.opacity(0.6)).frame(height: 0.5).gridCellUnsizedAxes(.horizontal) }
                }
            }
            .font(.system(size: size - 0.5))
            .padding(.vertical, 2)
        }
    }

    /// Inline Markdown with its code on the code wash.
    private func inline(_ text: String) -> AttributedString {
        DispatchMarkdown.inline(text).codeWashed()
    }

    private func paragraph(_ text: AttributedString) -> some View {
        Text(text).font(.system(size: size)).lineSpacing(lineSpacing).fixedSize(horizontal: false, vertical: true)
    }
}
