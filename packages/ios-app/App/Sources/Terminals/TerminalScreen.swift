import AgentSwitchKit
import SwiftTerm
import SwiftUI
import UIKit

/// SwiftTerm as a display only (docs/terminal-v0.md §1 iPhone): it never takes the keyboard and never sends what it
/// would type or report — the phone has no raw keystroke route; replies go through the box (as typed, or sealed), keys
/// and the wheel by name.
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

    /// A drag scrolls the program rather than this screen: it tracks the mouse, or it is full screen (no history of the
    /// terminal's own; Claude Code's current screen is both).
    var scrollsByWheel: Bool {
        let t = view.getTerminal()
        return t.mouseMode != .off || t.isCurrentBufferAlternate
    }

    /// One notch of the wheel per this much drag.
    var notch: CGFloat { max(8, view.font.lineHeight) }

    /// The cell under a point of the view while the program tracks the mouse (a tap then clicks there); nil when it does
    /// not, or the point is off the grid. The program's own full screen has no history, so the top of what shows is row 0.
    func clickCell(at point: CGPoint) -> (col: Int, row: Int)? {
        let t = view.getTerminal()
        guard t.mouseMode != .off, t.cols > 0, t.rows > 0 else { return nil }
        let grid = view.getOptimalFrameSize().size
        guard grid.width > 0, grid.height > 0 else { return nil }
        let col = Int(point.x / (grid.width / CGFloat(t.cols)))
        let row = Int((point.y - view.contentOffset.y) / (grid.height / CGFloat(t.rows)))
        guard (0..<t.cols).contains(col), (0..<t.rows).contains(row) else { return nil }
        return (col, row)
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

/// The controller's view in SwiftUI, and touch (terminal-v0 §1 second round): a drag scrolls — this screen's history,
/// or the program itself by wheel notches when it is full screen or tracks the mouse (a flick carries on a little);
/// pinch changes the text size (the grid follows, and with it the agent); a tap clicks in a program that tracks the
/// mouse, else puts the keyboard away.
struct TerminalScreen: UIViewRepresentable {
    let controller: TerminalScreenController
    var onPinchEnded: (CGFloat) -> Void = { _ in }
    /// Wheel notches for the program: up (back through what it showed), and how many.
    var onWheel: (Bool, Int) -> Void = { _, _ in }
    var onTap: (CGPoint) -> Void = { _ in }

    func makeUIView(context: Context) -> DisplayTerminalView {
        let c = context.coordinator
        let pinch = UIPinchGestureRecognizer(target: c, action: #selector(Coordinator.pinched(_:)))
        let pan = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.panned(_:)))
        let tap = UITapGestureRecognizer(target: c, action: #selector(Coordinator.tapped(_:)))
        pan.maximumNumberOfTouches = 1
        for g in [pinch, pan, tap] as [UIGestureRecognizer] {
            g.delegate = c
            g.cancelsTouchesInView = false
            controller.view.addGestureRecognizer(g)
        }
        return controller.view
    }

    func updateUIView(_ uiView: DisplayTerminalView, context: Context) {
        context.coordinator.onWheel = onWheel
        context.coordinator.onTap = onTap
    }

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller, ended: onPinchEnded, onWheel: onWheel, onTap: onTap) }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        let controller: TerminalScreenController
        let ended: (CGFloat) -> Void
        var onWheel: (Bool, Int) -> Void
        var onTap: (CGPoint) -> Void
        private var start: CGFloat = 10
        private var dragged: CGFloat = 0
        private var coast: Task<Void, Never>?

        init(controller: TerminalScreenController, ended: @escaping (CGFloat) -> Void, onWheel: @escaping (Bool, Int) -> Void, onTap: @escaping (CGPoint) -> Void) {
            self.controller = controller
            self.ended = ended
            self.onWheel = onWheel
            self.onTap = onTap
        }

        nonisolated func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        /// The wheel drag only while the program takes the wheel, and only up and down.
        nonisolated func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            MainActor.assumeIsolated {
                guard let pan = g as? UIPanGestureRecognizer else { return true }
                let v = pan.velocity(in: pan.view)
                return controller.scrollsByWheel && abs(v.y) > abs(v.x)
            }
        }

        @objc func panned(_ gesture: UIPanGestureRecognizer) {
            switch gesture.state {
            case .began:
                coast?.cancel()
                dragged = 0
            case .changed:
                dragged += gesture.translation(in: gesture.view).y
                gesture.setTranslation(.zero, in: gesture.view)
                let notches = Int(dragged / controller.notch)
                if notches != 0 {
                    dragged -= CGFloat(notches) * controller.notch
                    // The finger going down brings back what was above: the wheel turns up.
                    onWheel(notches > 0, abs(notches))
                }
            case .ended:
                // A flick carries on, slowing: a few more notches, fewer each time.
                let v = gesture.velocity(in: gesture.view).y
                var left = Int(min(24, abs(v) / 220))
                guard left > 0 else { return }
                let up = v > 0
                coast = Task { [weak self] in
                    while left > 0, !Task.isCancelled {
                        let now = max(1, left / 2)
                        self?.onWheel(up, now)
                        left -= now
                        try? await Task.sleep(for: .milliseconds(70))
                    }
                }
            default:
                break
            }
        }

        @objc func tapped(_ gesture: UITapGestureRecognizer) { onTap(gesture.location(in: gesture.view)) }

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
