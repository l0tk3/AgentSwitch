import AgentSwitchMacCore
import SwiftUI

// Code on the Dispatch page (docs/dispatch-v0.md §2, demo `mac-window.html` `.cb`, 2026-10-03, user: dispatch里加上代码块
// 支持吧，这样看着太难受了): a fenced block in the mono font on the code wash, square, framed; one line per line — a long
// one scrolls sideways rather than wrapping, so a command never reads as two — its language and `Copy` above it. Inline
// code sits on the same wash. What a person typed is read for code only (TypedText); model output is Markdown.

/// A fenced block; `Copy` puts its text on the clipboard (`Copied` for a moment).
struct CodeBlockView: View {
    let code: String
    var language: String?
    var size: CGFloat = 12
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if let language { Text(language).foregroundStyle(Look.faint).lineLimit(1) }
                Spacer(minLength: 8)
                Button(action: copy) { Text(copied ? "Copied" : "Copy") }
                    .buttonStyle(QuietButtonStyle(active: copied))
            }
            .mono(10.5)
            .padding(EdgeInsets(top: 6, leading: 10, bottom: 0, trailing: 10))
            // As wide as its longest line while that fits; else the width it is given, scrolling sideways.
            ViewThatFits(in: .horizontal) {
                lines
                ScrollView(.horizontal, showsIndicators: false) { lines }
            }
        }
        .frame(minWidth: 160, alignment: .leading)
        .background(Look.code)
        .overlay(Rectangle().strokeBorder(Look.line, lineWidth: 1))
    }

    private var lines: some View {
        Text(code)
            .font(.system(size: size, design: .monospaced))
            .lineSpacing(3)
            .foregroundStyle(Look.ink)
            .textSelection(.enabled)
            .fixedSize()
            .padding(EdgeInsets(top: 4, leading: 10, bottom: 9, trailing: 10))
    }

    private func copy() {
        Clipboard.copy(code)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            copied = false
        }
    }
}

/// What a person typed, as typed (DispatchMarkdown.typedBlocks): fenced blocks drawn as code, backtick spans on the code
/// wash, and nothing else read — a `*` or `#` they typed stays.
struct TypedText: View {
    let text: String
    var size: CGFloat = 14
    var weight: Font.Weight = .regular
    var lineSpacing: CGFloat = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(DispatchMarkdown.typedBlocks(text).enumerated()), id: \.offset) { _, block in
                if case .code(let language, let code) = block {
                    CodeBlockView(code: code, language: language, size: size - 2)
                } else if case .paragraph(let words) = block {
                    Text(DispatchMarkdown.codeSpans(words).codeWashed())
                        .font(.system(size: size, weight: weight))
                        .lineSpacing(lineSpacing)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

extension AttributedString {
    /// Its code runs (inline code, a flattened block) on the code wash; the rest as it is.
    func codeWashed() -> AttributedString {
        var out = self
        for run in out.runs where run.inlinePresentationIntent?.contains(.code) == true {
            out[run.range].backgroundColor = Look.code
        }
        return out
    }
}
