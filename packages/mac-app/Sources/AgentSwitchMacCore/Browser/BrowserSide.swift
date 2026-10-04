import Foundation

// The Browser page's tab list as a side column (docs/browser-v0.md §1 Mac, 2026-10-03, user: 浏览器侧栏应该也能调整
// 大小/开启关闭才对), the same as the Terminals page's sidebar (docs/terminal-v0.md §1, 2026-09-29 侧栏): its
// right edge drags it wider or narrower, 290 by default, 220 at the least and 560 at the most while the page keeps 420;
// a double click on the edge puts the default back; let go left of 120 and it closes entirely, no strip left; the bar's
// list button and ⌘B open and close it. Its width and whether it is open are kept on this Mac.

public struct BrowserSide: Sendable, Equatable, Codable {
    /// The width the list opens at (the last one it had while open).
    public var width: Double
    public var closed: Bool

    public static let defaultWidth = 290.0
    public static let minWidth = 220.0
    public static let maxWidth = 560.0
    /// What the page keeps for the screen beside the list.
    public static let pageRoom = 420.0
    /// A drag that ends left of this (from the page's left edge) closes the list.
    public static let closeBelow = 120.0
    /// A press on the edge that moves less than this is not a drag (a double click resets instead).
    public static let dragSlop = 3.0
    /// Where it is kept (UserDefaults), the terminal page's `terminal.side` shape: `{"width": 290, "closed": false}`.
    public static let storeKey = "browser.side"

    public static let standard = BrowserSide(width: defaultWidth, closed: false)

    public init(width: Double = BrowserSide.defaultWidth, closed: Bool = false) {
        self.width = width
        self.closed = closed
    }

    /// A width as the page shows it: within the bounds, the page keeping its room (the bounds win over the room on a
    /// page too narrow for both), in whole points.
    public static func clamped(_ width: Double, pageWidth: Double) -> Double {
        max(minWidth, min(width, maxWidth, pageWidth - pageRoom)).rounded()
    }

    /// The list's width on a page `pageWidth` wide: none while closed.
    public func shown(pageWidth: Double) -> Double {
        closed ? 0 : Self.clamped(width, pageWidth: pageWidth)
    }

    /// The edge dragged to `x` (from the page's left edge), as the drag shows it and as it stays once let go there:
    /// closed left of `closeBelow` (the width kept for the next opening), else open at that width.
    public func dragged(to x: Double, pageWidth: Double) -> BrowserSide {
        x < Self.closeBelow ? BrowserSide(width: width, closed: true) : BrowserSide(width: Self.clamped(x, pageWidth: pageWidth), closed: false)
    }

    /// The bar's button or ⌘B: open at the width it had, or closed.
    public func toggled() -> BrowserSide { BrowserSide(width: width, closed: !closed) }

    /// A double click on the edge: the default width (only while open; closed, there is no edge).
    public func reset() -> BrowserSide { closed ? self : BrowserSide(width: Self.defaultWidth, closed: false) }

    /// What was kept, or the default for nothing or something unreadable (a width out of bounds is bounded as shown).
    public static func restored(_ stored: String?) -> BrowserSide {
        guard let data = stored?.data(using: .utf8), let side = try? JSONDecoder().decode(BrowserSide.self, from: data), side.width.isFinite else { return .standard }
        return side
    }

    /// What is kept.
    public var stored: String {
        let data = (try? JSONEncoder().encode(self)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    private enum Key: String, CodingKey { case width, closed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        width = (try? c.decode(Double.self, forKey: .width)) ?? Self.defaultWidth
        closed = (try? c.decode(Bool.self, forKey: .closed)) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(width, forKey: .width)
        try c.encode(closed, forKey: .closed)
    }
}
