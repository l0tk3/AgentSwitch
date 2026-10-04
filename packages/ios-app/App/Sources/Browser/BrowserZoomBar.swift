import SwiftUI

/// The zoom row over the browser page's bar (browser-v0 §1 iPhone 页面缩放, 2026-10-03; user: 然后我发现agentswitch的浏览器页
/// 没有放大缩小的选项，加上 用来调节大小): `−` `100%` `+`, looking as the key bar shown while typing, opened and closed by the
/// bar's zoom key. The percent cap goes back to 100%; a cap at the end of the range is off. While this phone sizes the
/// tab the caps zoom the page; while it only watches, the picture on the phone, and the row says so at its end.
struct BrowserZoomBar: View {
    /// The percent in force: the page's, or the picture's while only watching.
    let percent: Int
    let canZoomOut: Bool
    let canZoomIn: Bool
    /// The phone only watches the tab: the caps zoom its picture, not the page.
    let pictureOnly: Bool
    var onOut: () -> Void
    var onReset: () -> Void
    var onIn: () -> Void

    var body: some View {
        // The caps at their full width (the terminal page's): all three as wide as `100%`, so `+` stays under the
        // finger as the percent goes from two digits to three.
        HStack(spacing: 5) {
            cap("−", label: "缩小", on: canZoomOut, action: onOut)
            cap("\(percent)%", label: "恢复 100%", action: onReset).accessibilityValue("\(percent)%")
            cap("+", label: "放大", on: canZoomIn, action: onIn)
            Spacer(minLength: Theme.Space.s)
            if pictureOnly {
                Text("仅放大手机上的画面").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, 8)
        .background(Theme.raised.opacity(0.5))
    }

    /// One cap, as the key bar's; off (dim, not to be pressed) when there is no step that way.
    private func cap(_ text: String, label: String, on: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(text).mono(13).foregroundStyle(on ? Theme.ink : Theme.inkDim) }
            .buttonStyle(KeyCapStyle())
            .disabled(!on)
            .accessibilityLabel(label)
    }
}
