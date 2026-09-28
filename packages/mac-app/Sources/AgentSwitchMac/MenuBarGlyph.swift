import AgentSwitchMacCore
import AppKit

/// The menu bar item: the app's pixel mark (docs/ui-v0.md §7.3), one point per cell, as a template image so it follows
/// the menu bar's colour — state by shape and opacity alone, and flat (no shadow at this size, §7.2.10). Still, never
/// animated: a blinking menu bar is louder than anything it could say.
///   idle      the lit lane solid, the others faint
///   busy      everything faint but the source and a block half-way along the lit lane
///   waiting   everything faint but the lit lane's end (something needs the user, or a service is in trouble)
///   off       dithered to half
enum MenuBarGlyph {
    /// 14 × 11 cells and a point of margin.
    static let size = NSSize(width: CGFloat(PixelArt.markWidth + 2), height: CGFloat(PixelArt.markHeight + 2))

    static func image(_ level: StatusLevel, waiting: Int = 0) -> NSImage {
        let state = PixelArt.markState(level, waiting: waiting)
        let image = NSImage(size: size, flipped: true) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            draw(in: ctx, state: state)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "AgentSwitch"
        return image
    }

    /// In points, y down, one point of margin.
    static func draw(in ctx: CGContext, state: PixelArt.MarkState) {
        let faint: CGFloat = 0.4
        let block = Set([7, 8].map { "\($0),1" })
        for cell in PixelArt.markCells {
            var alpha: CGFloat
            switch state {
            case .idle: alpha = cell.lit ? 1 : faint
            case .busy: alpha = cell.lit && (!cell.end && (cell.x < 3 || block.contains("\(cell.x),\(cell.y)"))) ? 1 : faint
            case .waiting, .error: alpha = cell.end ? 1 : faint
            case .off:
                if PixelArt.dithered(cell) { continue }
                alpha = cell.lit ? 1 : faint
            }
            ctx.setFillColor(CGColor(gray: 0, alpha: alpha))
            ctx.fill(CGRect(x: CGFloat(cell.x + 1), y: CGFloat(cell.y + 1), width: 1, height: 1))
        }
    }
}
