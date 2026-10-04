import AgentSwitchMacCore
import AppKit
import SwiftUI

// The Browser page's tab list edge (docs/browser-v0.md §1 Mac, 2026-10-03; the Terminals page's sidebar, terminal-v0 §1
// 2026-09-29): the list's 1 pt right edge, grabbed 7 points wide across it. Drag it to set the list's width (the
// screen refits as it goes), let go left of 120 to close the list; a double click puts the default width back. Under the
// pointer the edge is a solid ink line, while dragged the signal colour, as the terminal page's `.side-grip`.

struct BrowserSideEdge: View {
    /// A drag of the edge is under way (the page shows where it would leave the list).
    let dragging: Bool
    /// The list's width now: where the edge is from the page's left.
    let width: () -> Double
    /// The edge dragged to this x (from the page's left), and let go there.
    let drag: (Double) -> Void
    let drop: (Double) -> Void
    let reset: () -> Void
    @State private var hovering = false

    /// What the edge can be grabbed by, centred on the rule.
    static let grab: CGFloat = 7

    var body: some View {
        ZStack {
            HairRule(color: Look.line, vertical: true)
            if hovering || dragging {
                Rectangle().fill(dragging ? Color.signal : Look.ink2).frame(width: 1)
            }
            BrowserSideGrip(width: width, drag: drag, drop: drop, reset: reset, hover: { hovering = $0 })
                .frame(width: Self.grab)
                .help("Drag · Double-Click Resets")
        }
        .frame(width: Self.grab)
        // The rule on the list's last point, the grip reaching 3 points over the screen.
        .offset(x: (Self.grab - 1) / 2)
        .accessibilityHidden(true)
    }
}


/// The edge's grip as a view of AppKit's own: the resize cursor, the press and the drag that follows it (AppKit sends a
/// drag to the view it began in, so it goes on while the pointer is over the screen or the list closes under it), and the
/// double click.
private struct BrowserSideGrip: NSViewRepresentable {
    let width: () -> Double
    let drag: (Double) -> Void
    let drop: (Double) -> Void
    let reset: () -> Void
    let hover: (Bool) -> Void

    func makeNSView(context: Context) -> GripView { GripView() }

    func updateNSView(_ view: GripView, context: Context) {
        view.width = width
        view.onDrag = drag
        view.onDrop = drop
        view.onReset = reset
        view.onHover = hover
    }

    final class GripView: NSView {
        var width: () -> Double = { 0 }
        var onDrag: (Double) -> Void = { _ in }
        var onDrop: (Double) -> Void = { _ in }
        var onReset: () -> Void = {}
        var onHover: (Bool) -> Void = { _ in }
        /// Where the press began (window x) and the list's width then; whether it has moved past the slop.
        private var start: (x: CGFloat, width: Double)?
        private var moved = false

        override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            for area in trackingAreas { removeTrackingArea(area) }
            addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
        }

        override func mouseEntered(with event: NSEvent) { onHover(true) }
        override func mouseExited(with event: NSEvent) { if start == nil { onHover(false) } }

        override func mouseDown(with event: NSEvent) {
            if event.clickCount >= 2 {
                start = nil
                onReset()
                return
            }
            start = (event.locationInWindow.x, width())
            moved = false
        }

        override func mouseDragged(with event: NSEvent) {
            guard let start else { return }
            let dx = Double(event.locationInWindow.x - start.x)
            if !moved, abs(dx) <= BrowserSide.dragSlop { return }
            moved = true
            NSCursor.resizeLeftRight.set()
            onDrag(start.width + dx)
        }

        override func mouseUp(with event: NSEvent) {
            guard let start else { return }
            self.start = nil
            if moved { onDrop(start.width + Double(event.locationInWindow.x - start.x)) }
            moved = false
            let inside = bounds.contains(convert(event.locationInWindow, from: nil))
            if !inside { onHover(false) }
        }
    }
}
