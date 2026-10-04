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

    /// A frame of these pixels at this scale is drawn where `other` is, and the page's boxes (an agent's last action)
    /// land on it where they do on `other` (BrowserGeometry.fit, viewRect): a screen that placed `other` has nothing
    /// to place again. The scale counts as the pixels do (docs/browser-v0.md §1 页面缩放, 2026-10-03): a step of the
    /// page's zoom can change it alone — a 946 × 722 screen gets 1892 × 1444 pixels at 200 % and at 100 %, 4 and then
    /// 2 to a CSS pixel — and the picture is then where it was while the boxes are not.
    public func sits(as other: BrowserFrameGeometry) -> Bool {
        width == other.width && height == other.height && scale == other.scale
    }
}

public enum BrowserGeometry {
    /// How far above `zoom` points per CSS pixel (one at 100 %) a fit is drawn at exactly that: a tab at this screen's
    /// own size (its points ÷ the zoom, in whole CSS pixels) may be a little smaller than the screen, and drawing it a
    /// hair larger would resample every pixel of a frame at the display's scale.
    public static let oneToOneSlack = 0.02

    /// The frame's rectangle in a view of `size` (y down): aspect-fit, centred across, at the top; empty for an empty
    /// frame or view. A page of about the view's own size is drawn one CSS pixel to a point (docs/browser-v0.md §5,
    /// 2026-10-03): with frames at the display's device pixels, each lands on one pixel of the screen.
    ///
    /// `zoom`: the page's zoom where this Mac sized the tab (§1 页面缩放, 2026-10-03; 1 for a tab it did not size). The
    /// page is then the view ÷ the zoom, to the nearest CSS pixel, and is drawn `zoom` points to a CSS pixel: across
    /// the whole view at every zoom, each frame pixel still on one pixel of the screen. Its rounding leaves it up to
    /// half a CSS pixel short of the view or past it: it starts at the view's left edge, as a page does, and what is
    /// past the right or the foot is cut by the screen (BrowserScreenView) rather than every pixel resampled to bring
    /// it in.
    public static func fit(_ frame: BrowserFrameGeometry, in size: CGSize, zoom: Double = 1) -> CGRect {
        guard frame.width > 0, frame.height > 0, size.width > 0, size.height > 0 else { return .zero }
        let fitted = min(Double(size.width) / frame.width, Double(size.height) / frame.height)
        let factor = zoom > 0 ? zoom : 1
        // Points a frame pixel at exactly `factor` points a CSS pixel, and how far a page of the view's size is from
        // the view by its rounding alone: half a CSS pixel (the size asked for), half a frame pixel (the view drawn).
        let exact = factor / frame.scale, rounding = (factor + exact) / 2 + 1e-6
        let exactWidth = frame.width * exact, exactHeight = frame.height * exact
        let past = max(exactWidth - Double(size.width), exactHeight - Double(size.height))
        if fitted >= exact ? fitted <= exact * (1 + oneToOneSlack) : past <= rounding {
            let spare = Double(size.width) - exactWidth
            return CGRect(x: spare <= rounding ? 0 : (spare / 2).rounded(), y: 0, width: round2(exactWidth), height: round2(exactHeight))
        }
        let width = frame.width * fitted, height = frame.height * fitted
        return CGRect(x: ((Double(size.width) - width) / 2).rounded(), y: 0, width: width.rounded(), height: height.rounded())
    }

    /// A point of the view as a pixel of the frame. Outside the drawn frame: nil, unless `clamped` (a drag that left
    /// the screen goes on at its edge). `zoom` as `fit` takes it, here and below: the same rectangle as the one drawn.
    public static func framePoint(_ point: CGPoint, frame: BrowserFrameGeometry, in size: CGSize, clamped: Bool = false, zoom: Double = 1) -> CGPoint? {
        let rect = fit(frame, in: size, zoom: zoom)
        guard rect.width > 0, rect.height > 0 else { return nil }
        if !clamped, !rect.contains(point) { return nil }
        let x = (Double(point.x - rect.minX) / Double(rect.width)) * frame.width
        let y = (Double(point.y - rect.minY) / Double(rect.height)) * frame.height
        return CGPoint(x: round2(min(max(x, 0), frame.width - 1)), y: round2(min(max(y, 0), frame.height - 1)))
    }

    /// A distance of the view (a scroll) in the frame's pixels.
    public static func frameDistance(_ distance: Double, frame: BrowserFrameGeometry, in size: CGSize, zoom: Double = 1) -> Double {
        let rect = fit(frame, in: size, zoom: zoom)
        guard rect.width > 0 else { return distance }
        return round2(distance * frame.width / Double(rect.width))
    }

    /// A box in the page's CSS pixels (an agent's action) as a rectangle of the view.
    public static func viewRect(_ box: BrowserBox, frame: BrowserFrameGeometry, in size: CGSize, zoom: Double = 1) -> CGRect? {
        let rect = fit(frame, in: size, zoom: zoom)
        guard rect.width > 0, rect.height > 0, box.width >= 0, box.height >= 0 else { return nil }
        let perPixel = Double(rect.width) / frame.width
        let k = frame.scale * perPixel
        return CGRect(x: Double(rect.minX) + box.x * k, y: Double(rect.minY) + box.y * k, width: box.width * k, height: box.height * k)
    }

    /// The size the Mac asks for while it holds a tab (`POST /browser/tabs/:id/viewport`): the screen's points ÷ the
    /// page's zoom as CSS pixels (to the nearest, BrowserPageZoom.side; 2026-10-03, down before), the display's backing
    /// scale × the zoom as the device pixel ratio — kept within what the daemon takes. The same for the same screen and
    /// zoom every time: the daemon takes the same size again as a renewal of the hold.
    public static func viewport(for size: CGSize, backingScale: Double, zoom: Double = 1) -> BrowserViewportRequest {
        let factor = zoom > 0 ? zoom : 1
        return BrowserViewportRequest(width: clampSide(size.width, factor: factor), height: clampSide(size.height, factor: factor),
                                      scale: min(max(backingScale * factor, BrowserViewportRequest.scaleRange.lowerBound), BrowserViewportRequest.scaleRange.upperBound))
    }

    private static func clampSide(_ value: CGFloat, factor: Double) -> Int {
        let side = BrowserPageZoom.side(Double(value), factor: factor)
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
