import CoreGraphics
import Foundation

/// The page's own zoom (browser-v0 §1, 2026-10-03 页面缩放; user: 然后我发现agentswitch的浏览器页没有放大缩小的选项，加上
/// 用来调节大小): the browser's zoom, as Chrome's and Safari's — the page is laid out for a smaller or a larger window and
/// so drawn larger or smaller (at 50% a 402 pt phone is an 804 px window: room for a page made for a desktop). Not
/// `BrowserZoom`, which enlarges the picture on the phone only and tells the page nothing.
///
/// The Mac's service knows no zoom. A tab has one size and the screen that holds it sets it ("尺寸有主"), so the zoom is
/// part of that size: the screen's area over the factor in whole CSS pixels, at its own pixel ratio times the factor —
/// the picture comes out the size of the area again, and input, in frame pixels as ever, lands where the finger is.
/// Only the screen that sizes a tab can zoom its page.
public enum BrowserPageZoom {
    /// The steps in percent (Chrome's).
    public static let steps = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]
    /// No zoom: where a site not zoomed is, and a blank tab always.
    public static let standard = 100
    /// The sides in CSS pixels and the pixel ratios `POST /browser/tabs/:id/viewport` takes (§5).
    public static let sides = 200...4096
    public static let pixelRatios = 0.5...4.0
    /// The most CSS pixels a zoomed page has in all: what the Mac draws of a view at most (3840 × 2400, §5). Zoomed
    /// out the page is drawn at its CSS size whatever that is — 25% of a 945 × 726 area is 3780 × 2904, 11 million
    /// pixels drawn to show fewer than 3 — so a step that would pass it is not used (review, 2026-10-03; the same
    /// rule and name as the Mac's). A phone's area never comes near it: 1608 × 2760 at 25%.
    public static let pagePixels = 3840 * 2400

    /// 1 at 100%; a percent that is none counts as 100.
    public static func factor(_ percent: Int) -> Double { percent > 0 ? Double(percent) / 100 : 1 }

    /// A blank tab (no site, `about:blank`): never zoomed, never remembered.
    public static func isBlank(_ site: String) -> Bool {
        let place = site.trimmingCharacters(in: .whitespacesAndNewlines)
        return place.isEmpty || place == "about:blank"
    }

    /// What a screen sets for a tab it holds: its `area` (points) over the factor in whole CSS pixels, and its pixels a
    /// point times the factor, as far as the Mac takes a pixel ratio (to the hundredth). `mobile`: a phone's layout.
    public static func viewport(area: CGSize, screenScale: Double, percent: Int, mobile: Bool = true) -> BrowserViewport {
        let by = factor(percent)
        let ratio = min(max(screenScale * by, pixelRatios.lowerBound), pixelRatios.upperBound)
        return BrowserViewport(width: pixels(area.width, over: by), height: pixels(area.height, over: by),
                               scale: (ratio * 100).rounded() / 100, mobile: mobile)
    }

    /// Whole pixels, and never a number that cannot be sent.
    private static func pixels(_ points: Double, over factor: Double) -> Double {
        let side = (points / factor).rounded()
        return side.isFinite ? min(max(side, 0), 1_000_000) : 0
    }

    /// The area a page is sized for, in whole points: the screen area as it is `now` and, its width the same, no lower
    /// than `sent` — the area it was sized for before; the page passes the roomiest the area has stood at this width,
    /// whether or not it holds the tab just then (nil: none yet). What a keyboard, a note or the zoom row takes of the
    /// height neither shrinks the page — a phone's browser keeps its layout under the keyboard — nor moves the steps
    /// it can use; another width (the phone turned) or more height is the area as it is.
    public static func sizedArea(now area: CGSize, sent: CGSize?) -> CGSize {
        let now = CGSize(width: area.width.rounded(), height: area.height.rounded())
        guard let sent, sent.width == now.width else { return now }
        return CGSize(width: now.width, height: max(now.height, sent.height))
    }

    /// How long a screen area takes to settle: a size waits this long for the area to stop changing, and an area that
    /// stood for less was a passing one.
    public static let settle: Duration = .milliseconds(300)

    /// The roomiest area a page has had at this width (`sizedArea`'s `sent`), now that `area` was replaced after
    /// standing for `stood`. Only an area that stood for `settle` is room the page has, not every area it was given
    /// (review, 2026-10-03): a page just opened is laid out in passes, the first before its bars are — on a 402 pt
    /// simulator 800 pt high for 0.06 s, then 601 until the tab bar has gone, then its 650 — and with those counted
    /// the page was sized 150 pt taller than what is seen of it. No area (zero) is none.
    public static func roomiest(_ roomiest: CGSize?, after area: CGSize, stood: Duration) -> CGSize? {
        guard area.width > 0, area.height > 0, stood >= settle else { return roomiest }
        return sizedArea(now: area, sent: roomiest)
    }

    /// The steps a screen with this area can use: those that keep both sides of the page within what the Mac takes
    /// and the page within `pagePixels` — on a phone about 25% to 200%. None before the area is known.
    public static func usable(in area: CGSize) -> [Int] {
        steps.filter { percent in
            let page = viewport(area: area, screenScale: 1, percent: percent)
            let width = Int(page.width), height = Int(page.height)
            return sides.contains(width) && sides.contains(height) && width * height <= pagePixels
        }
    }

    /// The step in force for a site: the usable one nearest to what is `remembered` for it (the area may not allow
    /// that one; what is remembered stays as it is), a tie going toward 100%; 100% for a site not remembered. Before
    /// the area is known, the nearest of all the steps.
    public static func inForce(remembered: Int?, area: CGSize) -> Int {
        guard let remembered else { return standard }
        // Whatever was kept: far outside the steps is as far as their ends.
        let wanted = min(max(remembered, 0), 2 * (steps.last ?? standard))
        let allowed = usable(in: area)
        let nearest = (allowed.isEmpty ? steps : allowed).min { a, b in
            let da = abs(a - wanted), db = abs(b - wanted)
            return da == db ? abs(a - standard) < abs(b - standard) : da < db
        }
        return nearest ?? standard
    }

    /// Zooming in on a tab at `site`: the next usable step above `percent`; nil at the end of the range, and on a blank
    /// tab, which is always at 100%.
    public static func stepIn(from percent: Int, site: String, area: CGSize) -> Int? {
        isBlank(site) ? nil : usable(in: area).first { $0 > percent }
    }

    /// Zooming out: the next usable step below `percent`; nil at the end of the range, and on a blank tab.
    public static func stepOut(from percent: Int, site: String, area: CGSize) -> Int? {
        isBlank(site) ? nil : usable(in: area).last { $0 < percent }
    }

    /// What a stream asks for above the product where its bound is the screen's own pixels (`streamScale`): a fiftieth
    /// of a frame pixel a CSS pixel.
    public static let streamMargin = 0.02

    /// The frame pixels per CSS pixel a stream asks for at a zoom: what the screen shows a point at (`scale`: its
    /// device pixels, fewer on a slower link) times the factor, the Mac's own rule (its
    /// BrowserScreenPolicy.frameScale). A page zoomed in has fewer CSS pixels across the same screen and is still
    /// drawn at the screen's pixels; a page zoomed out comes no larger than the screen shows it (review, 2026-10-03:
    /// asking `scale` itself there, only the whole screen's pixels bounded the frame, and over Tailscale a page at 50%
    /// came at 2.25 times its tier's pixels). Never under 1, where the Mac draws the CSS size (`pastPixels`), nor over
    /// what it takes.
    ///
    /// `met`: the stream's bound is the screen's own pixels at this scale (the way shows the screen's pixels: the
    /// local network, a fast link). There the ask is `streamMargin` more than the product, to the hundredth the query
    /// sends (review, 2026-10-03). The page's sides are whole CSS pixels, up to half a pixel off the area over the
    /// factor — at 200 pixels a quarter of a percent of the scale, 0.02 at 8 — so at the product itself the view came
    /// a pixel or two narrower than the screen and was stretched across it: a 365 px page at 3.3 is 1205 wide for the
    /// 1206 of the screen, a 433 px one at 2.7 (90% on a 390 pt phone) 1169 for 1170. Asked the little more, the
    /// bound settles the view at exactly the screen's width (1206 / 365: drawn at 3.304). Not at 100% (the page is as
    /// wide as the area to the point), not under a product of 1 (the CSS size: nothing to settle), and not on a way
    /// that shows fewer pixels than the screen has (a fair or a slow link): no bound of its own meets the ask there,
    /// and the frame would only come a few pixels larger than the way's.
    public static func streamScale(_ scale: Double, factor: Double, met: Bool = false) -> Double {
        let by = factor > 0 ? factor : 1
        let product = scale * by
        let asked = met && by != 1 && product > 1 ? ((product + streamMargin) * 100).rounded() / 100 : product
        return min(max(asked, 1), BrowserStreamOptions.maxScale)
    }

    /// The page is zoomed out past a frame pixel a CSS pixel on a screen (or a link) that shows `scale` to a point:
    /// their product is under 1. The stream cannot ask for less than 1, and the Mac draws the CSS size, more pixels
    /// than are shown: there the frame is bounded by what is shown instead (BrowserStreamPolicy).
    public static func pastPixels(_ scale: Double, factor: Double) -> Bool {
        factor > 0 && scale * factor < 1
    }
}

/// The page zoom a device remembers, a site at a time as Chrome does (browser-v0 §1 页面缩放). The key is the tab's
/// `site` — the list's second line: a host, `localhost:5173`, a file's path — so every tab of a site is at its zoom
/// here. The phone's own: the Mac keeps another (a page wanted at 50% on the phone is at 100% there). A site at 100%
/// is not kept, nor a blank tab; at most `limit` sites, the one set longest ago dropped first.
public struct BrowserZoomMemory: Sendable, Equatable, Codable {
    /// A site and the percent its pages are at.
    public struct Entry: Sendable, Equatable, Codable {
        public let site: String
        public let percent: Int

        public init(site: String, percent: Int) {
            self.site = site
            self.percent = percent
        }
    }

    public static let limit = 200

    /// The sites zoomed, the one set last first.
    public let sites: [Entry]

    public init() { sites = [] }

    /// What was kept, as this keeps it: a site once (its first, the newest), nothing blank, at 100% or outside the
    /// steps (a value this did not write), at most `limit`.
    public init(sites: [Entry]) {
        var seen = Set<String>()
        self.sites = Array(sites.filter { Self.keeps($0) && seen.insert($0.site).inserted }.prefix(Self.limit))
    }

    private enum CodingKeys: String, CodingKey { case sites }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(sites: try c.decode([Entry].self, forKey: .sites))
    }

    private static func keeps(_ entry: Entry) -> Bool {
        guard let least = BrowserPageZoom.steps.first, let most = BrowserPageZoom.steps.last else { return false }
        return !BrowserPageZoom.isBlank(entry.site) && entry.percent != BrowserPageZoom.standard && (least...most).contains(entry.percent)
    }

    /// The percent remembered for a site; nil for one not zoomed (100%).
    public func percent(for site: String) -> Int? { sites.first { $0.site == site }?.percent }

    /// With `site` at `percent` from now on, the newest of them: 100% forgets it; a blank tab is never kept.
    public func setting(_ percent: Int, for site: String) -> BrowserZoomMemory {
        BrowserZoomMemory(sites: [Entry(site: site, percent: percent)] + sites.filter { $0.site != site })
    }
}
