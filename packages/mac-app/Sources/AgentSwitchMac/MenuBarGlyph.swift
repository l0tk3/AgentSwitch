import AgentSwitchMacCore
import AppKit

/// The menu bar item: the app icon's switch (scripts/make-icons.swift), bolder, as a template image so it follows the
/// menu bar's colour. Starting or stopped: the whole glyph faint. Something needs attention: a solid dot in place of the
/// bottom lane's end.
enum MenuBarGlyph {
    static let size = NSSize(width: 22, height: 16)

    static func image(_ level: StatusLevel) -> NSImage {
        let image = NSImage(size: size, flipped: false) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            draw(in: ctx, level: level)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "AgentSwitch"
        return image
    }

    /// In points, y up, on the 22 × 16 canvas.
    static func draw(in ctx: CGContext, level: StatusLevel) {
        let black = CGColor(gray: 0, alpha: 1)
        let source = CGPoint(x: 4, y: 8)
        let lanes: [CGFloat] = [13.2, 8, 2.8]
        let end: CGFloat = 15.4
        let alert = level == .warning || level == .error
        func lane(_ y: CGFloat) -> CGPath {
            let path = CGMutablePath()
            path.move(to: source)
            path.addCurve(to: CGPoint(x: 10, y: y), control1: CGPoint(x: 7, y: 8), control2: CGPoint(x: 6.8, y: y))
            path.addLine(to: CGPoint(x: end, y: y))
            return path
        }
        func dot(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) -> CGRect { CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r) }

        ctx.saveGState()
        ctx.setAlpha(level == .busy || level == .off ? 0.45 : 1)
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        ctx.setStrokeColor(black)
        ctx.setFillColor(black)
        ctx.setLineWidth(1.7)
        ctx.setLineCap(.round)

        ctx.saveGState()
        ctx.setAlpha(0.4)
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        for y in lanes.dropFirst() {
            ctx.addPath(lane(y))
            ctx.strokePath()
            if !(alert && y == lanes[2]) { ctx.fillEllipse(in: dot(end, y, 1.7)) }
        }
        ctx.endTransparencyLayer()
        ctx.restoreGState()

        ctx.addPath(lane(lanes[0]))
        ctx.strokePath()
        ctx.fillEllipse(in: dot(end, lanes[0], 2.1))
        ctx.fillEllipse(in: dot(source.x, source.y, 2.8))

        if alert {
            let badge = CGPoint(x: 17.2, y: lanes[2])
            ctx.setBlendMode(.clear)
            ctx.fillEllipse(in: dot(badge.x, badge.y, 3.6))
            ctx.setBlendMode(.normal)
            ctx.fillEllipse(in: dot(badge.x, badge.y, 2.5))
        }
        ctx.endTransparencyLayer()
        ctx.restoreGState()
    }
}
