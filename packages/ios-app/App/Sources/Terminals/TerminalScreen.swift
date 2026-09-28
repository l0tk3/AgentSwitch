import AgentSwitchKit
import SwiftTerm
import SwiftUI
import UIKit

/// SwiftTerm as a display only (docs/terminal-v0.md §1 iPhone): it never takes the keyboard and never sends what it
/// would type or report — the phone has no raw keystroke route; replies go through the box (sealed), keys through the
/// key bar (by name).
final class DisplayTerminalView: TerminalView {
    override var canBecomeFirstResponder: Bool { false }
}

/// Owns one terminal view: draws the stream into it, takes the Mac's colours, sizes its text, and says when the grid
/// it fits changes (the page tells the service).
@MainActor
final class TerminalScreenController: NSObject {
    let view: DisplayTerminalView
    /// The grid this view fits at its size and font: cols, rows.
    var onSize: ((Int, Int) -> Void)?
    static let fontRange: ClosedRange<CGFloat> = 7...16

    init(fontSize: CGFloat) {
        view = DisplayTerminalView(frame: CGRect(x: 0, y: 0, width: 390, height: 500), font: Self.font(fontSize))
        super.init()
        view.terminalDelegate = self
        view.allowMouseReporting = false
        view.backgroundColor = .black
        view.nativeBackgroundColor = .black
        view.nativeForegroundColor = UIColor(white: 0.9, alpha: 1)
        view.showsVerticalScrollIndicator = true
    }

    static func font(_ size: CGFloat) -> UIFont { UIFont.monospacedSystemFont(ofSize: size, weight: .regular) }

    var fontSize: CGFloat { view.font.pointSize }

    func setFontSize(_ size: CGFloat) {
        let clamped = min(max(size, Self.fontRange.lowerBound), Self.fontRange.upperBound)
        guard abs(clamped - fontSize) > 0.01 else { return }
        view.font = Self.font(clamped)
    }

    /// The user's iTerm colours from the Mac (`GET /terminals/style`), as on the Mac.
    func apply(_ style: TerminalStyle) {
        if let bg = style.background { view.nativeBackgroundColor = Self.uiColor(bg); view.backgroundColor = Self.uiColor(bg) }
        if let fg = style.foreground { view.nativeForegroundColor = Self.uiColor(fg) }
        if let ansi = style.ansi { view.installColors(ansi.map { SwiftTerm.Color(red8: UInt16($0.r), green8: UInt16($0.g), blue8: UInt16($0.b)) }) }
    }

    private static func uiColor(_ c: TerminalStyle.RGB) -> UIColor {
        UIColor(red: CGFloat(c.r) / 255, green: CGFloat(c.g) / 255, blue: CGFloat(c.b) / 255, alpha: 1)
    }

    /// The screen as the service has it: drawn afresh.
    func snapshot(_ data: String) {
        view.getTerminal().resetToInitialState()
        view.feed(text: data)
    }

    func output(_ data: String) { view.feed(text: data) }

    func write(_ line: String) { view.feed(text: line) }

    var grid: (cols: Int, rows: Int) {
        let t = view.getTerminal()
        return (t.cols, t.rows)
    }
}

extension TerminalScreenController: @preconcurrency TerminalViewDelegate {
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) { onSize?(newCols, newRows) }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    /// What the view would type (it has no keyboard here) or report: never sent.
    func send(source: TerminalView, data: ArraySlice<UInt8>) {}
    func scrolled(source: TerminalView, position: Double) {}
    /// Web links open in Safari; nothing else from an agent's output is opened.
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), Markdown.isWebLink(url) else { return }
        UIApplication.shared.open(url)
    }
    func bell(source: TerminalView) {}
    func clipboardCopy(source: TerminalView, content: Data) {
        if let text = String(data: content, encoding: .utf8) { UIPasteboard.general.string = text }
    }
    func clipboardRead(source: TerminalView) -> Data? { nil }
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

/// The controller's view in SwiftUI, with pinch to change the text size (the grid follows, and with it the agent).
struct TerminalScreen: UIViewRepresentable {
    let controller: TerminalScreenController
    var onPinchEnded: (CGFloat) -> Void = { _ in }

    func makeUIView(context: Context) -> DisplayTerminalView {
        let pinch = UIPinchGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pinched(_:)))
        controller.view.addGestureRecognizer(pinch)
        return controller.view
    }

    func updateUIView(_ uiView: DisplayTerminalView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller, ended: onPinchEnded) }

    @MainActor
    final class Coordinator: NSObject {
        let controller: TerminalScreenController
        let ended: (CGFloat) -> Void
        private var start: CGFloat = 10

        init(controller: TerminalScreenController, ended: @escaping (CGFloat) -> Void) {
            self.controller = controller
            self.ended = ended
        }

        @objc func pinched(_ gesture: UIPinchGestureRecognizer) {
            switch gesture.state {
            case .began: start = controller.fontSize
            case .changed: controller.setFontSize((start * gesture.scale).rounded())
            case .ended: ended(controller.fontSize)
            default: break
            }
        }
    }
}
