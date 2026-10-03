import AgentSwitchKit
import SwiftUI
import UIKit

// Code in Dispatch (docs/dispatch-v0.md §2, demo `app.html` `.cb`, 2026-10-03, user: dispatch里加上代码块支持吧 …… 手机上也
// 是): a fenced block in the mono font on the code wash, square, framed; one line per line — a long one scrolls sideways
// rather than wrapping, since on a phone a command wrapped over two lines reads as two — its language and `Copy` above
// it. Inline code sits on the same wash. What a person typed is read for code only (TypedText); model output is Markdown.

/// A fenced block; `Copy` puts its text on the clipboard (`Copied` for a moment).
struct CodeBlock: View {
    let code: String
    var language: String?
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if let language { Text(language).foregroundStyle(.tertiary).lineLimit(1) }
                Spacer(minLength: 8)
                Button(action: copy) {
                    Text(copied ? "Copied" : "Copy")
                        .foregroundStyle(copied ? Theme.signal : .secondary)
                        .padding(.vertical, 4)
                        .padding(.leading, 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("拷贝代码")
            }
            .mono(11)
            .padding(EdgeInsets(top: 2, leading: 10, bottom: 0, trailing: 10))
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.footnote.monospaced())
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(EdgeInsets(top: 2, leading: 10, bottom: 9, trailing: 10))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.code)
        .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
    }

    private func copy() {
        UIPasteboard.general.string = code
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            copied = false
        }
    }
}

/// What a person typed, as typed (Markdown.typedBlocks): fenced blocks drawn as code, backtick spans on the code wash,
/// and nothing else read — a `*` or `#` they typed stays.
struct TypedText: View {
    let text: String
    var font: Font = .body

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Markdown.typedBlocks(text).enumerated()), id: \.offset) { _, block in
                if case .code(let language, let code) = block {
                    CodeBlock(code: code, language: language)
                } else if case .paragraph(let words) = block {
                    Text(Markdown.codeSpans(words).codeWashed()).font(font)
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
            out[run.range].backgroundColor = Theme.code
        }
        return out
    }
}
