import CoreGraphics
import Foundation

/// How much picture a tab's stream asks for (browser-v0 §1 iPhone, §2: 15–30 frames on the local network, fewer and a
/// lower quality on a slow link). On the local network the screen's device pixels (3). Over Tailscale by the speed
/// measured (2026-10-03, user: tailscale 直接根据网速来行了，中转有的时候比直连快): whether the path is direct or relayed
/// (once guessed from how fast the Mac answered) says little about how much it carries. Each frame is at most the
/// screen's pixels, so a desktop page shown across the phone's width comes no larger than the screen shows it. A page
/// this phone zoomed (browser-v0 §1 页面缩放, 2026-10-03) is fewer CSS pixels across the same screen, or more: every
/// way asks for its own pixels a point times the factor (BrowserPageZoom.streamScale), and the frame stays the size
/// the way had at 100% — zoomed out too, where a way's own scale let it grow to the whole screen's pixels (review,
/// 2026-10-03).
public enum BrowserStreamPolicy {
    /// From this speed (megabits a second) as the local network: the phone's own size at 3× is about 209 KB a frame
    /// (§5's measure), 15 a second about 25 Mbps while the page moves.
    public static let fastMbps = 25.0
    /// From this speed at most 2× and 10 frames: about 100 KB a frame, about 8 Mbps.
    public static let fairMbps = 8.0
    public static let fairScale = 2.0
    /// Slower than that, or not measured: one frame pixel a point, the CSS size.
    public static let slowScale = 1.0

    public static let local = BrowserStreamOptions(quality: 70, fps: 15)
    public static let fair = BrowserStreamOptions(quality: 60, fps: 10)
    public static let slow = BrowserStreamOptions(quality: 45, fps: 5)

    /// The link is measured for the stream: Tailscale (the local network needs no measure; without an address there is
    /// nothing to measure).
    public static func measures(_ kind: EndpointKind?) -> Bool { kind == .tailnet }

    /// `mbps`: the speed measured over this address (nil: not known, the slow way). `screenPixels`: the phone's screen
    /// in pixels, the most any frame needs. `screenScale`: its points to pixels. `zoom`: the factor of the page zoom
    /// this phone set the page at (1: none, or the phone only watches). Each way asks its own frame pixels a point —
    /// the screen's on the local network and a fast link, at most 2 on a fair one, 1 (the CSS size) on a slow one —
    /// times the factor (BrowserPageZoom.streamScale), and is bounded by the screen's pixels, or by its own where the
    /// page is zoomed out past them (`most`).
    public static func options(kind: EndpointKind?, mbps: Double?, screenPixels: CGSize? = nil, screenScale: Double? = nil,
                               zoom: Double = 1) -> BrowserStreamOptions {
        // The screen in points: with them a way's own pixels can be counted.
        let points = screenPixels.flatMap { pixels in
            screenScale.flatMap { $0 > 0 ? CGSize(width: pixels.width / $0, height: pixels.height / $0) : nil }
        }
        switch kind {
        case .bonjour, .lan:
            return sharp(local, scale: screenScale, own: true, pixels: screenPixels, points: points, zoom: zoom)
        case .tailnet, .none:
            let speed = mbps ?? 0
            if speed >= fastMbps { return sharp(local, scale: screenScale, own: true, pixels: screenPixels, points: points, zoom: zoom) }
            if speed >= fairMbps {
                // A fair link shows a 2× screen's own pixels, and fewer than a 3× screen has.
                return sharp(fair, scale: screenScale.map { min($0, fairScale) }, own: screenScale.map { $0 <= fairScale } ?? false,
                             pixels: screenPixels, points: points, zoom: zoom)
            }
            let bound = screenPixels.map { most($0, points: points, scale: slowScale, zoom: zoom) }
            let asked = BrowserPageZoom.streamScale(slowScale, factor: zoom)
            return BrowserStreamOptions(quality: slow.quality, fps: slow.fps, maxWidth: bound.map { Int($0.width.rounded()) },
                                        maxHeight: bound.map { Int($0.height.rounded()) }, scale: asked > 1 ? asked : nil)
        }
    }

    /// `base` at `scale` frame pixels a point (times the page zoom), never larger than the screen: without the scale
    /// and the screen's pixels known, as `base` — and so is a screen of one pixel a point showing the page as it is,
    /// which has nothing to ask (as before the zoom). `own`: `scale` is the screen's own, so the bound, the screen's
    /// pixels, is what the frame should be to the pixel (BrowserPageZoom.streamScale's `met`).
    private static func sharp(_ base: BrowserStreamOptions, scale: Double?, own: Bool, pixels: CGSize?, points: CGSize?, zoom: Double) -> BrowserStreamOptions {
        guard let scale, let pixels else { return base }
        let asked = BrowserPageZoom.streamScale(scale, factor: zoom, met: own)
        guard asked > 1 || (zoom > 0 && zoom < 1) else { return base }
        let bound = most(pixels, points: points, scale: scale, zoom: zoom)
        return BrowserStreamOptions(quality: base.quality, fps: base.fps, maxWidth: Int(bound.width.rounded()), maxHeight: Int(bound.height.rounded()),
                                    scale: asked > 1 ? asked : nil)
    }

    /// The most pixels a frame needs on a way that shows `scale` frame pixels a point: the screen's own (`pixels`) —
    /// except for a page zoomed out past a frame pixel a CSS pixel (BrowserPageZoom.pastPixels; on a 3× phone the
    /// local network under 34%, a fair link under 50%, a slow one under 100%), which the Mac still draws at its CSS
    /// size, more pixels than the way shows. There the way's own pixels bound it, the screen's `points` times
    /// `scale`, and the screencast makes the frame that small (review, 2026-10-03: bounded by the whole screen, the
    /// page of a 402 × 690 pt area at 25% came 1206 × 2070 on a fair link for the tier's 804 × 1380, and on a slow one
    /// for its 402 × 690). The Mac does the same with its browser area (its BrowserScreenPolicy.stream). Without the
    /// points known, the screen's pixels as before.
    private static func most(_ pixels: CGSize, points: CGSize?, scale: Double, zoom: Double) -> CGSize {
        guard let points, BrowserPageZoom.pastPixels(scale, factor: zoom) else { return pixels }
        return CGSize(width: points.width * scale, height: points.height * scale)
    }
}

/// The phone's measure of its link to the Mac (`GET /browser/speed`, browser-v0 §5): bytes over the time from the first
/// chunk to the last, so the time to the first byte (the round trip, the Mac starting to answer) is not counted. Ends
/// when the bytes are in or at `limit`, whatever has come by then counting.
public enum BrowserSpeed {
    /// The bytes asked for: at 25 Mbps about a third of a second, at 8 about one.
    public static let bytes = 1024 * 1024
    /// The longest a measure takes; slower than about 4 Mbps it ends here, on what came.
    public static let limit: Duration = .seconds(2)
    /// A measure is used again for this long on the same address.
    public static let fresh: TimeInterval = 60
    /// Fewer bytes after the first chunk than this say nothing (a chunk or two, or none).
    public static let least = 32 * 1024

    /// Chunks as they came: (bytes, seconds since the measure began).
    public struct Meter: Sendable, Equatable {
        public private(set) var first: Double?
        public private(set) var last: Double?
        /// Bytes after the first chunk.
        public private(set) var after = 0

        public init() {}

        public mutating func add(_ count: Int, at seconds: Double) {
            guard count > 0 else { return }
            if first == nil { first = seconds } else { after += count }
            last = seconds
        }

        /// The measure ended before all the bytes came (the limit, a broken connection): the time waited counts.
        public mutating func cut(at seconds: Double) {
            if first != nil, seconds > (last ?? seconds) { last = seconds }
        }

        /// Megabits a second, or nil when too little came to tell.
        public var mbps: Double? {
            guard let first, let last, after >= BrowserSpeed.least, last > first else { return nil }
            return Double(after) * 8 / (last - first) / 1_000_000
        }
    }
}

/// What the address bar sends, and what it shows.
public enum BrowserAddress {
    /// The text typed, as the Mac takes it: a port on its own (`5173`, `:5173`) is a local server; anything else goes as
    /// typed (`localhost:5173`, a bare host, `/path`, `~/path`, a URL — the Mac reads it, browser-v0 §5). Nil when empty.
    public static func target(for typed: String) -> BrowserTarget? {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let digits = text.hasPrefix(":") ? String(text.dropFirst()) : text
        if !digits.isEmpty, digits.count <= 5, digits.allSatisfy({ $0.isASCII && $0.isNumber }), let port = Int(digits), (1...65_535).contains(port) {
            return .port(port)
        }
        return .url(text)
    }

    /// The bar's text for a URL: `github.com/acme/app/pull/128` (no scheme, no lone `/`), `localhost:5173/`,
    /// `file:///Users/me/x.html`; and whether it is a secure site (the lock).
    public static func display(_ raw: String) -> (text: String, secure: Bool) {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return (raw, false) }
        switch scheme {
        case "https", "http":
            var text = raw.dropFirst(scheme.count + 3)
            if text.hasPrefix("www.") { text = text.dropFirst(4) }
            if text.hasSuffix("/") && text.filter({ $0 == "/" }).count == 1 { text = text.dropLast() }
            return (String(text), scheme == "https")
        case "file":
            return ("file://" + (url.path.removingPercentEncoding ?? url.path), false)
        default:
            return (raw, false)
        }
    }

    /// Typed addresses opened from this phone, newest first, without repeats, at most `limit`.
    public static func remember(_ typed: String, in recent: [String], limit: Int = 8) -> [String] {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return recent }
        return Array(([text] + recent.filter { $0 != text }).prefix(limit))
    }
}

/// What the page says about a hold, the same words as the Mac's footer (ui-v0 §4.1).
public enum BrowserNotice {
    /// Two minutes without input gave the tab back.
    public static let idleHandBack = "2 分钟无操作，已自动交还。"
    /// Said once when a person takes over an agent's tab: what is typed stays on the page for the agent to see after
    /// the hand-back, and Fill Ciphertext is only on one's own tabs (docs/browser-v0.md §2 安全, §6).
    public static let takeOver = "接手期间你输入的内容，交还后 agent 能在页面上看到；密码请在自己的标签里填写。"
    /// Fill Ciphertext asked for on an agent's tab (the key is not offered there).
    public static let fillOwnTabsOnly = "只能在你自己的标签中填入密文。"
}

/// Where a tab is held: the screen ids carry their kind (`mac-…`, `phone-…`, `web-…`); without one the Mac records the
/// paired device's id, or `local`.
public enum BrowserHolder: Equatable, Sendable {
    case mac, iphone, web, elsewhere

    public init(_ screen: String) {
        if screen.hasPrefix("phone") { self = .iphone }
        else if screen.hasPrefix("mac") || screen == "local" { self = .mac }
        else if screen.hasPrefix("web") { self = .web }
        else { self = .elsewhere }
    }

    /// The short words of the holder line (§7.2.7).
    public var label: String {
        switch self {
        case .mac: return "On Mac"
        case .iphone: return "On iPhone"
        case .web: return "On Web"
        case .elsewhere: return "On Another Device"
        }
    }

    /// The sentence for it (§4.1).
    public var said: String {
        switch self {
        case .mac: return "此标签正在 Mac 上使用。"
        case .iphone: return "此标签正在另一台 iPhone 上使用。"
        case .web: return "此标签正在浏览器中使用。"
        case .elsewhere: return "此标签正在另一台设备上使用。"
        }
    }
}
