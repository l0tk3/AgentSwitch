import CoreGraphics
import Foundation

/// The phone's own zoom of the picture (browser-v0 §1: two fingers zoom the picture on the phone only, the page is not
/// told): content point `p` shows at `p × scale + offset`. Pinching keeps the point under the fingers where it is; the
/// zoomed picture always covers the screen area (no empty margin dragged in). Not the page's zoom (`BrowserPageZoom`,
/// which lays the page out afresh): that one is the zoom key's while this phone sizes the tab; while it only watches,
/// the same key steps this one (`steps`, `stepped`).
public struct BrowserZoom: Sendable, Equatable {
    public var scale: Double
    public var offset: CGPoint

    public init(scale: Double = 1, offset: CGPoint = .zero) {
        self.scale = scale
        self.offset = offset
    }

    public static let none = BrowserZoom()
    public static let range: ClosedRange<Double> = 1...4
    /// The scales the zoom key goes through (browser-v0 §1 页面缩放, 2026-10-03: 100 125 150 200 300 400); a pinch stops
    /// anywhere between.
    public static let steps: [Double] = [1, 1.25, 1.5, 2, 3, 4]

    public var isZoomed: Bool { scale > 1.001 }

    /// The scale as the zoom key writes it (`150%`).
    public var percent: Int { Int((scale * 100).rounded()) }

    /// The scale as the chip at the picture's top right writes it (browser-v0 §1 iPhone: `2.0×`): to one decimal,
    /// wherever two fingers left it (`1.4×`) — but a step of the zoom key that has hundredths in full (`1.25×`, as the
    /// demo page; review, 2026-10-03: to one decimal the 125% step read `1.2×` beside a key and a row saying `125%`).
    public var times: String {
        let step = Self.steps.first { abs($0 - scale) < 0.001 }
        let tenths = step.map { ($0 * 10).rounded() == $0 * 10 } ?? true
        return String(format: tenths ? "%.1f×" : "%.2f×", step ?? scale)
    }

    /// The next step above the scale now; nil at the end of the range.
    public var stepIn: Double? { Self.steps.first { $0 > scale + 0.001 } }

    /// The next step below the scale now; nil at the whole picture.
    public var stepOut: Double? { Self.steps.last { $0 < scale - 0.001 } }

    public func apply(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x * scale + offset.x, y: p.y * scale + offset.y)
    }

    public func invert(_ p: CGPoint) -> CGPoint {
        CGPoint(x: (p.x - offset.x) / scale, y: (p.y - offset.y) / scale)
    }

    /// Zoomed to `newScale` (kept in `range`) about `center`, a point of the screen area.
    public func pinched(to newScale: Double, around center: CGPoint, area: CGSize) -> BrowserZoom {
        let s = min(max(newScale, Self.range.lowerBound), Self.range.upperBound)
        let content = invert(center)
        return BrowserZoom(scale: s, offset: CGPoint(x: center.x - content.x * s, y: center.y - content.y * s)).clamped(to: area)
    }

    /// Zoomed to `newScale` by the key rather than by fingers: about the middle of the part of the picture now in view
    /// (`picture`: where it is drawn before the zoom, BrowserLayout). A picture still shorter than the area keeps its
    /// top edge at the area's top, where a page being watched sits — it grows downwards, never out of sight with room
    /// left under it; a taller one covers the area's height.
    public func stepped(to newScale: Double, picture: CGRect, area: CGSize) -> BrowserZoom {
        let shown = CGRect(origin: apply(picture.origin), size: CGSize(width: picture.width * scale, height: picture.height * scale))
        let seen = shown.intersection(CGRect(origin: .zero, size: area))
        let middle = seen.isNull || seen.isEmpty ? CGPoint(x: area.width / 2, y: area.height / 2) : CGPoint(x: seen.midX, y: seen.midY)
        let next = pinched(to: newScale, around: middle, area: area)
        let top = picture.minY * next.scale + next.offset.y
        let kept = min(0, max(min(0, area.height - picture.height * next.scale), top))
        return BrowserZoom(scale: next.scale, offset: CGPoint(x: next.offset.x, y: next.offset.y + kept - top)).clamped(to: area)
    }

    /// Moved by a two-finger drag.
    public func panned(by delta: CGSize, area: CGSize) -> BrowserZoom {
        BrowserZoom(scale: scale, offset: CGPoint(x: offset.x + delta.width, y: offset.y + delta.height)).clamped(to: area)
    }

    /// The offset kept so the zoomed area still covers the screen area; none at all at scale 1.
    public func clamped(to area: CGSize) -> BrowserZoom {
        let minX = area.width - area.width * scale, minY = area.height - area.height * scale
        return BrowserZoom(scale: scale, offset: CGPoint(x: min(0, max(minX, offset.x)), y: min(0, max(minY, offset.y))))
    }
}

/// Where a tab's picture sits on the phone, and how a touch maps back to the frame (docs/browser-v0.md §5: input points
/// are frame pixels of the frame they were aimed at; the Mac divides by the frame's scale for the page's CSS pixels).
///
/// Watching, the picture is fitted into the screen area, its top at the top. While this phone holds the tab at its own
/// size the frame is the screen area's size, drawn one to one across the width; when the keyboard takes part of the
/// area, the picture stays that size and is `lift`ed so what was touched stays in sight.
public struct BrowserLayout: Sendable, Equatable {
    /// The frame's size in pixels.
    public let frame: CGSize
    /// The screen area.
    public let area: CGSize
    /// Where the picture is drawn, before the zoom.
    public let picture: CGRect
    public let zoom: BrowserZoom

    public init(frame: CGSize, area: CGSize, fillWidth: Bool = false, lift: Double = 0, zoom: BrowserZoom = .none) {
        self.frame = frame
        self.area = area
        self.zoom = zoom
        guard frame.width > 0, frame.height > 0, area.width > 0, area.height > 0 else {
            picture = .zero
            return
        }
        let fit = min(area.width / frame.width, area.height / frame.height)
        let k = fillWidth ? area.width / frame.width : fit
        let size = CGSize(width: frame.width * k, height: frame.height * k)
        let room = max(0, size.height - area.height)
        picture = CGRect(x: (area.width - size.width) / 2, y: -min(max(lift, 0), room), width: size.width, height: size.height)
    }

    /// Screen points per frame pixel, the zoom included.
    public var pointsPerPixel: Double {
        guard frame.width > 0 else { return 1 }
        return picture.width / frame.width * zoom.scale
    }

    /// The frame pixel under a point of the screen area; nil off the picture.
    public func framePoint(at point: CGPoint) -> CGPoint? {
        guard picture.width > 0, picture.height > 0 else { return nil }
        let p = zoom.invert(point)
        let x = (p.x - picture.minX) / picture.width * frame.width
        let y = (p.y - picture.minY) / picture.height * frame.height
        guard x >= 0, y >= 0, x <= frame.width, y <= frame.height else { return nil }
        return CGPoint(x: x, y: y)
    }

    /// Where a box of the page (CSS pixels) shows on the screen area: `frameScale` frame pixels per CSS pixel.
    public func screenRect(ofPage box: BrowserBox, frameScale: Double) -> CGRect {
        guard frame.width > 0, frame.height > 0 else { return .zero }
        let s = frameScale > 0 ? frameScale : 1
        let kx = picture.width / frame.width, ky = picture.height / frame.height
        let origin = zoom.apply(CGPoint(x: picture.minX + box.x * s * kx, y: picture.minY + box.y * s * ky))
        return CGRect(x: origin.x, y: origin.y, width: box.width * s * kx * zoom.scale, height: box.height * s * ky * zoom.scale)
    }

    /// A finger's movement as the wheel's delta in frame pixels: the page follows the finger (drag up, the page goes on
    /// down), as a touch screen scrolls.
    public func wheelDelta(forDrag drag: CGSize) -> CGSize {
        let k = pointsPerPixel > 0 ? pointsPerPixel : 1
        return CGSize(width: -drag.width / k, height: -drag.height / k)
    }

    /// How far to lift a picture drawn across the width so that frame row `frameY` shows `margin` of the way down an
    /// area `visible` tall: 0 when it fits.
    public static func lift(toShow frameY: Double, frame: CGSize, areaWidth: Double, visible: Double, margin: Double = 0.4) -> Double {
        guard frame.width > 0, areaWidth > 0, visible > 0 else { return 0 }
        let k = areaWidth / frame.width
        let height = frame.height * k
        let room = max(0, height - visible)
        return min(max(frameY * k - visible * margin, 0), room)
    }
}
