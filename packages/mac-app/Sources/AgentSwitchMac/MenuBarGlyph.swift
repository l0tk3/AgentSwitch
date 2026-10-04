import AgentSwitchMacCore
import AppKit

/// The menu bar item: the app's mark in one colour (docs/ui-v0.md §10, `PixelArt.stackRows`: the front window as a
/// solid panel with its prompt cut out, the edge of a window behind it), one point per cell, as a template image so it
/// follows the menu bar's colour — state by shape and opacity alone, and flat (no shadow at this size, §7.2.10). Still,
/// never animated: a blinking menu bar is louder than anything it could say.
///   idle      the panel solid, the window behind faint
///   busy      the window behind solid too
///   waiting   the panel faint, its prompt lit (something needs the user, or a service is in trouble)
///   off       dithered to half
/// In the classic look the same picture is drawn smooth (the user, of the pixel one in the classic look: 这个东西没有
/// classic 的版本吗？我怎么看都是像素版): a rounded panel, the prompt as round strokes, the window behind as a line; off
/// is the whole mark faint.
enum MenuBarGlyph {
    /// 14 × 11 cells and a point of margin.
    static let size = NSSize(width: CGFloat(PixelArt.markWidth + 2), height: CGFloat(PixelArt.markHeight + 2))

    static func image(_ level: StatusLevel, waiting: Int = 0, look: InterfaceLook = .current) -> NSImage {
        let state = PixelArt.markState(level, waiting: waiting)
        let image = NSImage(size: size, flipped: true) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            if look.isClassic { drawClassic(in: ctx, state: state) } else { draw(in: ctx, state: state) }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "AgentSwitch"
        return image
    }

    /// In points, y down, one point of margin: each cell in full or faint, as the state has it (PixelArt.stackShows).
    static func draw(in ctx: CGContext, state: PixelArt.MarkState) {
        let faint: CGFloat = 0.4
        for cell in PixelArt.stackCells {
            guard let full = PixelArt.stackShows(cell, in: state) else { continue }
            ctx.setFillColor(CGColor(gray: 0, alpha: full ? 1 : faint))
            ctx.fill(CGRect(x: CGFloat(cell.x + 1), y: CGFloat(cell.y + 1), width: 1, height: 1))
        }
    }

    /// The classic look's: the pixel picture's proportions drawn smooth, in points, y down, one point of margin. The
    /// panel is 12 × 9 with round corners; the prompt is the app icon's, a `>` and a cursor as round strokes — a hole
    /// in the panel, or lit on a faint one while something waits; the window behind is a line above and to the right.
    static func drawClassic(in ctx: CGContext, state: PixelArt.MarkState) {
        let faint: CGFloat = 0.4
        let whole: CGFloat = state == .off ? faint : 1
        func alpha(_ part: PixelArt.StackCell.Part) -> CGFloat? { PixelArt.stackShows(part, in: state).map { ($0 ? 1 : faint) * whole } }
        ctx.translateBy(x: 1, y: 1)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        if let strength = alpha(.behind) {
            let behind = CGMutablePath()
            behind.move(to: CGPoint(x: 3.5, y: 0.5))
            behind.addLine(to: CGPoint(x: 11.6, y: 0.5))
            behind.addArc(tangent1End: CGPoint(x: 13.5, y: 0.5), tangent2End: CGPoint(x: 13.5, y: 2.4), radius: 1.9)
            behind.addLine(to: CGPoint(x: 13.5, y: 7.5))
            ctx.setStrokeColor(CGColor(gray: 0, alpha: strength))
            ctx.setLineWidth(1)
            ctx.addPath(behind)
            ctx.strokePath()
        }
        if let strength = alpha(.panel) {
            ctx.setFillColor(CGColor(gray: 0, alpha: strength))
            ctx.addPath(CGPath(roundedRect: CGRect(x: 0, y: 2, width: 12, height: 9), cornerWidth: 2.4, cornerHeight: 2.4, transform: nil))
            ctx.fillPath()
        }
        let prompt = CGMutablePath()
        prompt.move(to: CGPoint(x: 2.25, y: 4.86))
        prompt.addLine(to: CGPoint(x: 4.08, y: 6.5))
        prompt.addLine(to: CGPoint(x: 2.25, y: 8.14))
        prompt.move(to: CGPoint(x: 5.72, y: 8.14))
        prompt.addLine(to: CGPoint(x: 8.28, y: 8.14))
        ctx.setLineWidth(1.2)
        ctx.addPath(prompt)
        // Lit, the prompt is drawn over the panel; otherwise it is taken out of it.
        if let strength = alpha(.prompt) {
            ctx.setStrokeColor(CGColor(gray: 0, alpha: strength))
        } else {
            ctx.setStrokeColor(CGColor(gray: 0, alpha: 1))
            ctx.setBlendMode(.clear)
        }
        ctx.strokePath()
        ctx.setBlendMode(.normal)
    }
}
