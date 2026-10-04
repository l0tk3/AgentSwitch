import AgentSwitchLive
import SwiftUI

/// Drawing the pixel look's shaded pictures (docs/ui-v0.md §9, ShadedSprite), for the app's views and the Live
/// Activity's alike: each cell a square in its tone of the ink, over a hard shadow a cell down and right.
public enum ShadedPaint {
    public static func color(_ rgb: UInt32) -> Color {
        Color(red: Double(rgb >> 16 & 0xFF) / 255, green: Double(rgb >> 8 & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
    }

    /// The hard shadow: a step off the ground.
    public static func shadow(dark: Bool) -> Color { color(dark ? 0x2C2A28 : 0xCFC9BC) }

    static func rect(_ x: Int, _ y: Int, _ cell: CGFloat) -> Path {
        Path(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell))
    }

    public static func draw(_ sprite: ShadedSprite, in context: inout GraphicsContext, cell: CGFloat, dark: Bool, shadow: Bool) {
        let cells = sprite.cells(dark: dark)
        if shadow { for c in cells { context.fill(rect(c.x + 1, c.y + 1, cell), with: .color(Self.shadow(dark: dark))) } }
        for c in cells { context.fill(rect(c.x, c.y, cell), with: .color(color(c.rgb))) }
    }

    /// A status square's edges: a key has a light one above and left and a dark one below and right; its empty seat
    /// the other way round.
    public static func keyEdges(in context: inout GraphicsContext, side: CGFloat, edge: CGFloat, raised: Bool) {
        let light = GraphicsContext.Shading.color(.white.opacity(raised ? 0.45 : 0.3)), shade = GraphicsContext.Shading.color(.black.opacity(0.35))
        let (above, below) = raised ? (light, shade) : (shade, light)
        context.fill(Path(CGRect(x: 0, y: 0, width: side - edge, height: edge)), with: above)
        context.fill(Path(CGRect(x: 0, y: edge, width: edge, height: side - 2 * edge)), with: above)
        context.fill(Path(CGRect(x: edge, y: side - edge, width: side - edge, height: edge)), with: below)
        context.fill(Path(CGRect(x: side - edge, y: edge, width: edge, height: side - 2 * edge)), with: below)
    }
}

/// What a state puts on the app's shaded mark (ShadedMark, docs/ui-v0.md §10): the picture is tones of the one ink, the
/// only colour the state's — the front window's title bar as a raised strip in the state's colour, a light block on it
/// while busy; off is the picture with every other cell gone.
public struct ShadedMarkPaint {
    public var dark: Bool
    /// The hard shadow, a cell down and right, and a little glow under the running block.
    public var depth: Bool
    public var glow: Bool
    public var off: Bool
    /// The title bar in a state's colour, and how lit it is (a waiting one is faint every other beat).
    public var end: Color?
    public var endLit: Double
    /// The running block: steps along the title bar, each with how strongly it shows, in `busy`.
    public var block: [(step: Int, alpha: Double)]
    public var busy: Color

    public init(dark: Bool = true, depth: Bool = false, glow: Bool = false, off: Bool = false, end: Color? = nil, endLit: Double = 1,
                block: [(step: Int, alpha: Double)] = [], busy: Color = LiveLook.busy) {
        self.dark = dark
        self.depth = depth
        self.glow = glow
        self.off = off
        self.end = end
        self.endLit = endLit
        self.block = block
        self.busy = busy
    }

    public func draw(_ context: inout GraphicsContext, cell: CGFloat) {
        let rect = { (x: Int, y: Int) in ShadedPaint.rect(x, y, cell) }
        let rows = ShadedMark.picture.rows.map(Array.init)
        let cells = ShadedMark.picture.cells(dark: dark).filter { !off || !ShadedMark.dithered(x: $0.x, y: $0.y) }
        let lane = ShadedMark.lane
        if glow, let head = block.first {
            var under = context
            under.addFilter(.blur(radius: cell * 1.6))
            under.opacity = 0.7
            for at in lane[head.step] { under.fill(rect(at.x, at.y), with: .color(busy)) }
        }
        if depth { for c in cells { context.fill(rect(c.x + 1, c.y + 1), with: .color(ShadedPaint.shadow(dark: dark))) } }
        for c in cells {
            guard let end, ShadedMark.isEnd(x: c.x, y: c.y) else {
                context.fill(rect(c.x, c.y), with: .color(ShadedPaint.color(c.rgb)))
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

    /// The block at `frame` with its fading trail, or alone.
    public static func block(at frame: Int, trail: Bool) -> [(step: Int, alpha: Double)] {
        let count = ShadedMark.lane.count
        let fade: [(back: Int, alpha: Double)] = trail ? [(0, 1), (1, 0.55), (2, 0.25)] : [(0, 1)]
        return fade.map { (step: ((frame - $0.back) % count + count) % count, alpha: $0.alpha) }
    }
}
