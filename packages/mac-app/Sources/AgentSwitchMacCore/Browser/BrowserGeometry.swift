import CoreGraphics
import Foundation

// The Mac's screen of a tab (docs/browser-v0.md §1 Mac): the frame drawn aspect-fit in the view — as wide as it can be,
// centred across, from the top (a page starts under the address bar; what is left below is the page's ground) — and the
// points of the view mapped to the frame's pixels the input names (the daemon divides by `scale` for CSS pixels), and
// the page's CSS boxes (an agent's last action) mapped back onto the view. The view's coordinates are flipped: y down.

/// Where a frame's pixels sit on the page: its pixel size and `scale` frame pixels per CSS pixel.
public struct BrowserFrameGeometry: Sendable, Equatable {
    public let seq: Int
    public let width: Double
    public let height: Double
    public let scale: Double

    public init(seq: Int = 0, width: Double, height: Double, scale: Double = 1) {
        self.seq = seq
        self.width = width
        self.height = height
        self.scale = scale > 0 ? scale : 1
    }
}

public enum BrowserGeometry {
    /// The frame's rectangle in a view of `size` (y down): aspect-fit, centred across, at the top; empty for an empty
    /// frame or view.
    public static func fit(_ frame: BrowserFrameGeometry, in size: CGSize) -> CGRect {
        guard frame.width > 0, frame.height > 0, size.width > 0, size.height > 0 else { return .zero }
        let ratio = min(Double(size.width) / frame.width, Double(size.height) / frame.height)
        let width = frame.width * ratio, height = frame.height * ratio
        return CGRect(x: ((Double(size.width) - width) / 2).rounded(), y: 0, width: width.rounded(), height: height.rounded())
    }

    /// A point of the view as a pixel of the frame. Outside the drawn frame: nil, unless `clamped` (a drag that left
    /// the screen goes on at its edge).
    public static func framePoint(_ point: CGPoint, frame: BrowserFrameGeometry, in size: CGSize, clamped: Bool = false) -> CGPoint? {
        let rect = fit(frame, in: size)
        guard rect.width > 0, rect.height > 0 else { return nil }
        if !clamped, !rect.contains(point) { return nil }
        let x = (Double(point.x - rect.minX) / Double(rect.width)) * frame.width
        let y = (Double(point.y - rect.minY) / Double(rect.height)) * frame.height
        return CGPoint(x: round2(min(max(x, 0), frame.width - 1)), y: round2(min(max(y, 0), frame.height - 1)))
    }

    /// A distance of the view (a scroll) in the frame's pixels.
    public static func frameDistance(_ distance: Double, frame: BrowserFrameGeometry, in size: CGSize) -> Double {
        let rect = fit(frame, in: size)
        guard rect.width > 0 else { return distance }
        return round2(distance * frame.width / Double(rect.width))
    }

    /// A box in the page's CSS pixels (an agent's action) as a rectangle of the view.
    public static func viewRect(_ box: BrowserBox, frame: BrowserFrameGeometry, in size: CGSize) -> CGRect? {
        let rect = fit(frame, in: size)
        guard rect.width > 0, rect.height > 0, box.width >= 0, box.height >= 0 else { return nil }
        let perPixel = Double(rect.width) / frame.width
        let k = frame.scale * perPixel
        return CGRect(x: Double(rect.minX) + box.x * k, y: Double(rect.minY) + box.y * k, width: box.width * k, height: box.height * k)
    }

    /// The size the Mac asks for while it holds a tab (`POST /browser/tabs/:id/viewport`): the screen's points as CSS
    /// pixels, the display's backing scale as the device pixel ratio — kept within what the daemon takes.
    public static func viewport(for size: CGSize, backingScale: Double) -> BrowserViewportRequest {
        BrowserViewportRequest(width: clampSide(size.width), height: clampSide(size.height),
                               scale: min(max(backingScale, BrowserViewportRequest.scaleRange.lowerBound), BrowserViewportRequest.scaleRange.upperBound))
    }

    private static func clampSide(_ value: CGFloat) -> Int {
        let side = Int(Double(value).rounded(.down))
        return min(max(side, BrowserViewportRequest.sideRange.lowerBound), BrowserViewportRequest.sideRange.upperBound)
    }

    private static func round2(_ n: Double) -> Double { (n * 100).rounded() / 100 }
}

/// `POST /browser/tabs/:id/viewport {width, height, scale, mobile}`: the holding screen's size.
public struct BrowserViewportRequest: Sendable, Equatable, Encodable {
    public let width: Int
    public let height: Int
    public let scale: Double
    public let mobile: Bool

    /// What the daemon accepts (api/browser.ts ViewportBody).
    public static let sideRange = 200...4096
    public static let scaleRange = 0.5...4.0

    public init(width: Int, height: Int, scale: Double = 1, mobile: Bool = false) {
        self.width = width
        self.height = height
        self.scale = scale
        self.mobile = mobile
    }
}
