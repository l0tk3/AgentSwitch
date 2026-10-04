import AgentSwitchKit
import SwiftTerm
import SwiftUI
import UIKit

/// SwiftTerm as a display only (docs/terminal-v0.md §1 iPhone): it never takes the keyboard and never sends what it
/// would type or report — the phone has no raw keystroke route; replies go through the box (as typed, or sealed), keys
/// and the wheel by name. Its own link taps and its long-press menu need the first responder it never is, so they never
/// act here: the links are read off its screen and handled by the page (`TerminalScreenController.link(at:)`).
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

    // MARK: links (docs/terminal-v0.md §1 iPhone 链接, 2026-10-03)

    /// A finger's slop around a link, in points: about a line of text (12 points at the usual size).
    static let linkSlop: CGFloat = 14
    /// The slop of a tap while the program tracks the mouse: half a line. A tap beside a link is then a click the
    /// program may be waiting for (an option on the line under an address), not the link's.
    static let linkSlopClicking: CGFloat = 6

    /// A cell's size in points; nil before the screen has a grid.
    private var cell: CGSize? {
        let t = view.getTerminal()
        let grid = view.getOptimalFrameSize().size
        guard t.cols > 0, t.rows > 0, grid.width > 0, grid.height > 0 else { return nil }
        return CGSize(width: grid.width / CGFloat(t.cols), height: grid.height / CGFloat(t.rows))
    }

    /// The links on the screen now, read afresh at each touch (the screen changes under the finger): its rows cell by
    /// cell, the rows the terminal wrapped itself, the cells of OSC 8 links. The Kit finds them (`TerminalLinks`).
    func links(workdir: String?) -> [ScreenLink] {
        let t = view.getTerminal()
        var rows: [[Character]] = []
        var wrapped = Set<Int>()
        var explicit: [TerminalLinks.Explicit] = []
        for r in 0..<t.rows {
            guard let line = t.getLine(row: r) else { rows.append([]); continue }
            if line.isWrapped { wrapped.insert(r) }
            var cells: [Character] = []
            var run: (start: Int, address: String)?
            let count = min(t.cols, line.count)
            for col in 0..<count {
                let data = line[col]
                let tail = col > 0 && line[col - 1].width == 2
                cells.append(tail ? TerminalLinks.wideTail : t.getCharacter(for: data))
                // A wide character's second cell carries on what its first one has.
                let address = tail ? run?.address : (data.getPayload() as? String).flatMap(TerminalLinks.address(payload:))
                if address != run?.address {
                    if let run { explicit.append(TerminalLinks.Explicit(row: r, columns: run.start..<col, address: run.address)) }
                    run = address.map { (col, $0) }
                }
            }
            if let run { explicit.append(TerminalLinks.Explicit(row: r, columns: run.start..<count, address: run.address)) }
            rows.append(cells)
        }
        return TerminalLinks.find(rows: rows, wrapped: wrapped, explicit: explicit, workdir: workdir)
    }

    /// The link a touch at `point` (the view's coordinates, which scroll with its history) lands on: the nearest within
    /// the slop — `tap`: narrower while the program tracks the mouse, where a tap has another meaning.
    func link(at point: CGPoint, workdir: String?, tap: Bool = false) -> ScreenLink? {
        guard let cell else { return nil }
        let t = view.getTerminal()
        let row = point.y / cell.height - CGFloat(t.getTopVisibleRow())
        let slop = tap && t.mouseMode != .off ? Self.linkSlopClicking : Self.linkSlop
        return TerminalLinks.hit(links(workdir: workdir), column: point.x / cell.width, row: row,
                                 cell: (Double(cell.width), Double(cell.height)), slop: Double(slop))
    }

    /// Where a link's cells are, row by row, in the view's coordinates.
    private func rects(of link: ScreenLink) -> [CGRect] {
        guard let cell else { return [] }
        let top = CGFloat(view.getTerminal().getTopVisibleRow())
        return link.spans.map { span in
            CGRect(x: CGFloat(span.columns.lowerBound) * cell.width, y: (top + CGFloat(span.row)) * cell.height,
                   width: CGFloat(span.columns.count) * cell.width, height: cell.height)
        }
    }

    /// The link's place on the screen (the window's coordinates): its menu opens by it.
    func frame(of link: ScreenLink) -> CGRect {
        let all = rects(of: link).map { view.convert($0, to: nil) }
        return all.dropFirst().reduce(all.first ?? .zero) { $0.union($1) }
    }

    /// The link touched lights up for a moment: which one the finger took.
    func flash(_ link: ScreenLink) {
        for rect in rects(of: link) {
            let mark = UIView(frame: rect)
            mark.isUserInteractionEnabled = false
            mark.backgroundColor = UIColor(Theme.signal).withAlphaComponent(0.4)
            view.addSubview(mark)
            UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.18, delay: 0.14, options: [.curveLinear]) {
                mark.alpha = 0
            } completion: { _ in mark.removeFromSuperview() }
        }
    }

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
    /// Never called here (the view is not the first responder its own link taps need): the page reads the links off
    /// the screen and opens them in the Mac's browser (`TerminalPage.tapped`).
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
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
/// pinch changes the text size (the grid follows, and with it the agent); a tap opens a link, else clicks in a program
/// that tracks the mouse, else puts the keyboard away; a long press on a link opens its menu (2026-10-03).
struct TerminalScreen: UIViewRepresentable {
    let controller: TerminalScreenController
    var onPinchEnded: (CGFloat) -> Void = { _ in }
    /// Wheel notches for the program: up (back through what it showed), and how many.
    var onWheel: (Bool, Int) -> Void = { _, _ in }
    var onTap: (CGPoint) -> Void = { _ in }
    /// A press held where it began, at that point.
    var onHold: (CGPoint) -> Void = { _ in }

    func makeUIView(context: Context) -> DisplayTerminalView {
        let c = context.coordinator
        let pinch = UIPinchGestureRecognizer(target: c, action: #selector(Coordinator.pinched(_:)))
        let pan = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.panned(_:)))
        let tap = UITapGestureRecognizer(target: c, action: #selector(Coordinator.tapped(_:)))
        let hold = UILongPressGestureRecognizer(target: c, action: #selector(Coordinator.held(_:)))
        hold.minimumPressDuration = 0.4
        // A press held is not also a tap (lifting before it counts as held fails it at once: the tap is not delayed).
        tap.require(toFail: hold)
        pan.maximumNumberOfTouches = 1
        for g in [pinch, pan, tap, hold] as [UIGestureRecognizer] {
            g.delegate = c
            g.cancelsTouchesInView = false
            controller.view.addGestureRecognizer(g)
        }
        return controller.view
    }

    func updateUIView(_ uiView: DisplayTerminalView, context: Context) {
        context.coordinator.onWheel = onWheel
        context.coordinator.onTap = onTap
        context.coordinator.onHold = onHold
    }

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller, ended: onPinchEnded, onWheel: onWheel, onTap: onTap, onHold: onHold) }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        let controller: TerminalScreenController
        let ended: (CGFloat) -> Void
        var onWheel: (Bool, Int) -> Void
        var onTap: (CGPoint) -> Void
        var onHold: (CGPoint) -> Void
        private var start: CGFloat = 10
        private var dragged: CGFloat = 0
        private var coast: Task<Void, Never>?

        init(controller: TerminalScreenController, ended: @escaping (CGFloat) -> Void, onWheel: @escaping (Bool, Int) -> Void, onTap: @escaping (CGPoint) -> Void,
             onHold: @escaping (CGPoint) -> Void) {
            self.controller = controller
            self.ended = ended
            self.onWheel = onWheel
            self.onTap = onTap
            self.onHold = onHold
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

        @objc func held(_ gesture: UILongPressGestureRecognizer) {
            if gesture.state == .began { onHold(gesture.location(in: gesture.view)) }
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
