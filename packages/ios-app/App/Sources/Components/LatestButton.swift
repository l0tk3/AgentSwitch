import SwiftUI

/// `↓ Latest` over a list's foot, while the reader has scrolled away from its end (2026-11-24, user: 应该加一个回到
/// 底部的按钮，聊天室和简略模式都要). `New` while something came in that the reader has not scrolled down to.
struct LatestButton: View {
    let unseen: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                LookGlyph(glyph: "↓", symbol: "arrow.down", size: 13)
                Text(unseen ? "New" : "Latest").mono(12, weight: .medium)
            }
            .foregroundStyle(unseen ? Theme.signal : Theme.ink)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .grounded(Theme.panel, radius: 16)
            .framed(Theme.line, radius: 16)
        }
        .buttonStyle(.plain)
        .padding(.bottom, 8)
        .transition(.opacity)
    }
}

/// Where a list's end is, in the scroll view's own space: the end marker reports its bottom, the scroll view its
/// height, and the reader is at the end when the one is within reach of the other. Works on a list that lays out
/// everything (no lazy stack), where the marker's `onAppear` says nothing about what is on screen.
struct ListEndY: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = min(value, nextValue()) }
}

extension View {
    /// On the end marker: its bottom in `space`.
    func reportsListEnd(in space: String) -> some View {
        background(GeometryReader { g in Color.clear.preference(key: ListEndY.self, value: g.frame(in: .named(space)).maxY) })
    }
}
