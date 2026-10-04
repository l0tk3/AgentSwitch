import CoreGraphics
import Foundation

// Page zoom (docs/browser-v0.md §1 页面缩放, 2026-10-03, user: 然后我发现agentswitch的浏览器页没有放大缩小的选项，加上 用来
// 调节大小): the browser's own zoom, as Chrome's and Safari's — the page is laid out for a smaller or a larger window, and
// so is drawn larger or smaller. The daemon knows nothing of it. It is part of the size a screen gives a tab it holds
// (尺寸有主): the browser area ÷ the zoom in CSS pixels and the display's scale × the zoom as the page's pixel ratio
// (BrowserGeometry.viewport), frames at that many pixels per CSS pixel (BrowserScreenPolicy.stream), the
// picture drawn `zoom` points to a CSS pixel (BrowserGeometry.fit). So only the screen that sizes a tab zooms its page
// (BrowserScreenPolicy.zoom): your own tab while it is on this Mac, an agent's after `[ Take Over ]`.
// - The steps are Chrome's. A screen uses those at which the tab still has a size the daemon takes.
// - Remembered per site on this Mac (BrowserZoomMemory), as Chrome does; the phone keeps its own.

/// A tab's zoom on a screen: the step in force, and the steps `+` and `−` go to.
public struct BrowserPageZoom: Sendable, Equatable {
    /// The step in force, in percent.
    public let percent: Int
    /// The next usable step above (Zoom In) and below (Zoom Out); nil at the ends.
    public let larger: Int?
    public let smaller: Int?

    /// The steps, in percent (Chrome's).
    public static let steps = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]
    /// No zoom: where a site is until it is set, and what is never remembered.
    public static let standard = 100
    /// A page this screen does not zoom (a tab it does not size, a blank tab): 100 %, no step to take.
    public static let fixed = BrowserPageZoom(percent: standard, larger: nil, smaller: nil)

    public init(percent: Int, larger: Int?, smaller: Int?) {
        self.percent = percent
        self.larger = larger
        self.smaller = smaller
    }

    /// The zoom of a site remembered at `remembered` (nil: never set, 100 %) on a screen that can use the steps
    /// `usable`: the usable step nearest to what is remembered — the area may have changed since it was set —, a tie
    /// going toward 100 %. What is remembered is not changed by it.
    public init(remembered: Int?, usable: [Int]) {
        let percent = remembered.flatMap { Self.nearest(to: $0, among: usable) } ?? Self.standard
        self.init(percent: percent, larger: usable.first { $0 > percent }, smaller: usable.last { $0 < percent })
    }

    /// The same on a screen whose browser area is `area`.
    public init(remembered: Int?, area: CGSize) {
        self.init(remembered: remembered, usable: Self.usable(in: area))
    }

    /// Points drawn to a CSS pixel.
    public var factor: Double { Self.factor(percent) }
    public var isStandard: Bool { percent == Self.standard }

    public static func factor(_ percent: Int) -> Double { Double(percent) / 100 }

    /// A side of the tab on a screen `points` long at `factor`: the points ÷ the factor, to the nearest CSS pixel (the
    /// daemon takes whole ones). The picture drawn `factor` points to a CSS pixel is then within half a CSS pixel of
    /// the screen (BrowserGeometry.fit).
    public static func side(_ points: Double, factor: Double) -> Int {
        let pixels = (points / (factor > 0 ? factor : 1)).rounded()
        guard pixels.isFinite else { return 0 }
        return Int(min(max(pixels, 0), Double(Int32.max)))
    }

    /// The most CSS pixels a zoomed page has in all: what the daemon draws of a view at most (3840 × 2400, §5). Zoomed
    /// out the page is drawn at its CSS size whatever that is — 25 % of a 945 × 726 area is 3780 × 2904, 11 million
    /// pixels drawn to show fewer than 3 —, so a step that would pass it is not used (review, 2026-10-03).
    public static let pagePixels = 3840 * 2400

    /// The steps a screen whose browser area is `area` can use: those at which both sides of the tab stay within what
    /// the daemon takes (`POST /browser/tabs/:id/viewport`, 200…4096) and the page within `pagePixels`. About
    /// 33 %–300 % in the Mac's window.
    public static func usable(in area: CGSize) -> [Int] {
        steps.filter { step in
            let sides = [area.width, area.height].map { side(Double($0), factor: factor(step)) }
            return sides.allSatisfy(BrowserViewportRequest.sideRange.contains) && sides[0] * sides[1] <= pagePixels
        }
    }

    /// The step of `steps` nearest to `percent`, of two as near the one nearer 100 %; nil of none.
    static func nearest(to percent: Int, among steps: [Int]) -> Int? {
        steps.min { (abs($0 - percent), abs($0 - standard)) < (abs($1 - percent), abs($1 - standard)) }
    }
}

/// What this Mac remembers of its sites' zoom, as Chrome does: one step per site, for every tab on that site. The site
/// is what the tab list writes on a tab's second line (`BrowserTab.site`): a host, `localhost:5173`, a file's path.
/// 100 % is not kept (setting it forgets the site); at most 200 sites, the one set longest ago dropped first; a blank
/// tab never. Kept in the app's preferences (`browser.zoom`), the phone's apart from the Mac's: a page wanted at 50 %
/// on the phone is at 100 % here.
public struct BrowserZoomMemory: Sendable, Equatable, Codable {
    /// One site's zoom, in percent.
    public struct Entry: Sendable, Equatable, Codable {
        public let site: String
        public let percent: Int

        public init(site: String, percent: Int) {
            self.site = site
            self.percent = percent
        }
    }

    /// The sites zoomed away from 100 %, the one set last first.
    public let sites: [Entry]

    public static let limit = 200
    /// Where it is kept (UserDefaults): `{"sites": [{"site": "github.com", "percent": 125}]}`.
    public static let storeKey = "browser.zoom"
    public static let empty = BrowserZoomMemory()

    /// `sites`, the newest first: what cannot be a site's zoom left out (100 %, a percent outside the steps, no site),
    /// a site once (its newest), at most `limit`.
    public init(sites: [Entry] = []) {
        var seen: Set<String> = []
        self.sites = Array(sites.filter { Self.keeps($0) && seen.insert($0.site).inserted }.prefix(Self.limit))
    }

    /// What a tab's zoom is kept under: its site. Nil for a blank tab, which is never remembered and always at 100 %.
    public static func site(of tab: BrowserTab) -> String? {
        tab.kind == .blank || isBlank(tab.site) ? nil : tab.site
    }

    /// The step `site` was set to; nil for one never set (or set back to 100 %).
    public func percent(for site: String) -> Int? {
        sites.first { $0.site == site }?.percent
    }

    /// The memory with `site` set to `percent`, as the newest; forgotten at 100 %. Unchanged for a blank site or a
    /// percent no page can have.
    public func setting(_ percent: Int, for site: String) -> BrowserZoomMemory {
        let others = sites.filter { $0.site != site }
        if percent == BrowserPageZoom.standard { return BrowserZoomMemory(sites: others) }
        let entry = Entry(site: site, percent: percent)
        return Self.keeps(entry) ? BrowserZoomMemory(sites: [entry] + others) : self
    }

    /// What was kept; nothing for nothing or something unreadable.
    public static func restored(_ stored: String?) -> BrowserZoomMemory {
        guard let data = stored?.data(using: .utf8), let memory = try? JSONDecoder().decode(BrowserZoomMemory.self, from: data) else { return .empty }
        return memory
    }

    /// What is kept.
    public var stored: String {
        let data = (try? JSONEncoder().encode(self)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    private static func isBlank(_ site: String) -> Bool { site.isEmpty || site == "about:blank" }

    private static func keeps(_ entry: Entry) -> Bool {
        guard let least = BrowserPageZoom.steps.first, let most = BrowserPageZoom.steps.last else { return false }
        return !isBlank(entry.site) && entry.percent != BrowserPageZoom.standard && (least...most).contains(entry.percent)
    }

    private enum Key: String, CodingKey { case sites }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        self.init(sites: ((try? c.decode([LossyEntry].self, forKey: .sites)) ?? []).compactMap(\.entry))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(sites, forKey: .sites)
    }

    /// An entry that does not decode is left out rather than failing the whole memory.
    private struct LossyEntry: Decodable {
        let entry: Entry?
        init(from decoder: Decoder) throws { entry = try? Entry(from: decoder) }
    }
}

/// The zoom's words in the status bar (docs/browser-v0.md §1 页面缩放; ui-v0 §4.1): `−` `100%` `+`, their help under the
/// pointer, and why they do nothing on a tab this Mac does not size.
public enum BrowserZoomText {
    /// The minus sign (U+2212), as wide as the plus.
    public static let zoomOut = "\u{2212}"
    public static let zoomIn = "+"
    /// The widest percent a step writes: the word keeps this width (monospaced), so `+` stays where it is.
    public static let widest = "100%"

    public static let zoomOutHelp = "Zoom Out ⌘\u{2212}"
    public static let zoomInHelp = "Zoom In ⌘+"
    /// The percent goes back to 100 % (no key: ⌘0 is Dispatch).
    public static let resetHelp = "Actual Size"
    /// An agent's tab before `[ Take Over ]`, a tab another screen holds: this Mac does not size it.
    public static let notSized = "接手后才能缩放。"

    public static func percent(_ zoom: BrowserPageZoom) -> String { "\(zoom.percent)%" }
}
