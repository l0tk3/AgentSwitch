import AgentSwitchMacCore
import SwiftUI

/// What a state puts on the app's shaded mark (docs/ui-v0.md §10, ShadedMark): the picture is tones of the one ink, the
/// only colour the state's — the front window's title bar as a raised strip in the state's colour, a light block running
/// along it while busy; off is the picture with every other cell gone.
struct ShadedMarkPaint {
    var dark = true
    /// The hard shadow, a cell down and right, and a little glow under the running block.
    var depth = false
    var off = false
    /// The title bar in a state's colour, and how lit it is (a waiting one is faint every other beat).
    var end: Color? = nil
    var endLit = 1.0
    /// The running block: steps along the title bar, each with how strongly it shows, in `busy`.
    var block: [(step: Int, alpha: Double)] = []
    var busy: Color = .busy

    func draw(_ context: inout GraphicsContext, cell: CGFloat) {
        func rect(_ x: Int, _ y: Int) -> Path { Path(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)) }
        let rows = ShadedMark.picture.rows.map(Array.init)
        let cells = ShadedMark.picture.cells(dark: dark).filter { !off || !ShadedMark.dithered(x: $0.x, y: $0.y) }
        let lane = ShadedMark.lane
        if depth, let head = block.first {
            var glow = context
            glow.addFilter(.blur(radius: cell * 1.6))
            glow.opacity = 0.7
            for at in lane[head.step] { glow.fill(rect(at.x, at.y), with: .color(busy)) }
        }
        if depth { for c in cells { context.fill(rect(c.x + 1, c.y + 1), with: .color(.shadedShadow(dark: dark))) } }
        for c in cells {
            guard let end, ShadedMark.isEnd(x: c.x, y: c.y) else {
                context.fill(rect(c.x, c.y), with: .color(Color(nsColor: .rgb(c.rgb))))
                continue
            }
            context.fill(rect(c.x, c.y), with: .color(end.opacity(endLit)))
            switch ShadedMark.edge(of: rows[c.y][c.x]) {
            case .light: context.fill(rect(c.x, c.y), with: .color(.white.opacity(0.45 * endLit)))
            case .dark: context.fill(rect(c.x, c.y), with: .color(.black.opacity(0.35 * endLit)))
            case .face: break
            }
        }
        for (step, alpha) in block {
            for at in lane[step] { context.fill(rect(at.x, at.y), with: .color(busy.opacity(alpha))) }
        }
    }

    /// The block at `frame` with its fading trail (with depth), or alone.
    static func block(at frame: Int, trail: Bool) -> [(step: Int, alpha: Double)] {
        let count = ShadedMark.lane.count
        let fade: [(back: Int, alpha: Double)] = trail ? [(0, 1), (1, 0.55), (2, 0.25)] : [(0, 1)]
        return fade.map { (step: ((frame - $0.back) % count + count) % count, alpha: $0.alpha) }
    }
}

/// The app's mark in a state: its shaded picture, the front window's title bar cyan with a light block running along it
/// while busy (still under Reduce Motion), amber while something waits (it blinks) and red on an error. `cell` in
/// points, drawn as a whole number of pixels. It ticks only while busy or waiting, seen, and allowed to move (ui-v0 §7.4).
struct ShadedMarkView: View {
    let state: PixelArt.MarkState
    var cell: CGFloat = 1.5
    var depth = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onScreen) private var onScreen
    @Environment(\.displayScale) private var displayScale
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let interval = reduceMotion ? nil : state.motionInterval
        let cell = CGFloat(ShadedSprite.cell(scale: Double(displayScale), points: Double(cell)))
        let side = ((CGFloat(ShadedMark.picture.width) + (depth ? 1 : 0)) * cell).rounded(.up)
        Group {
            if let interval, onScreen {
                TimelineView(.periodic(from: Motion.epoch, by: interval)) { timeline in
                    Canvas { context, _ in paint(frame: Motion.step(at: timeline.date, every: interval)).draw(&context, cell: cell) }
                }
                .id(interval)   // busy ↔ waiting: the other beat
            } else {
                let frame = interval.map { Motion.step(at: Date(), every: $0) } ?? 0
                Canvas { context, _ in paint(frame: frame).draw(&context, cell: cell) }
            }
        }
        .frame(width: side, height: side, alignment: .topLeading)
    }

    private func paint(frame: Int) -> ShadedMarkPaint {
        ShadedMarkPaint(
            dark: scheme == .dark, depth: depth, off: state == .off,
            end: state == .waiting ? .waiting : state == .error ? .failed : state == .busy ? .busy : nil,
            endLit: state == .waiting && frame % 2 == 1 ? 0.25 : 1,
            block: state == .busy ? ShadedMarkPaint.block(at: frame, trail: depth) : [], busy: .white)
    }
}
