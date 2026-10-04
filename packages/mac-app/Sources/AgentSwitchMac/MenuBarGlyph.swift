import AgentSwitchMacCore
import AppKit

/// The menu bar item: the app's mark in one colour (docs/ui-v0.md §10, `PixelArt.stackRows`: three windows one behind
/// another), one point per cell, as a template image so it follows the menu bar's colour — state by shape and opacity
/// alone, and flat (no shadow at this size, §7.2.10). Still, never animated: a blinking menu bar is louder than
/// anything it could say.
///   idle      the front window solid, the ones behind faint
///   busy      everything faint but the front window's frame and a block on its title bar
///   waiting   everything faint but the front window's title bar (something needs the user, or a service is in trouble)
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

    /// In points, y down, one point of margin: each cell in full or faint, as the state has it (PixelArt.stackShows).
    static func draw(in ctx: CGContext, state: PixelArt.MarkState) {
        let faint: CGFloat = 0.4
        for cell in PixelArt.stackCells {
            guard let full = PixelArt.stackShows(cell, in: state) else { continue }
            ctx.setFillColor(CGColor(gray: 0, alpha: full ? 1 : faint))
            ctx.fill(CGRect(x: CGFloat(cell.x + 1), y: CGFloat(cell.y + 1), width: 1, height: 1))
        }
    }
}
