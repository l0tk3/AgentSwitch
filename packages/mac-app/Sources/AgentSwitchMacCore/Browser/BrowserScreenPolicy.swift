import CoreGraphics
import Foundation

// What this Mac's Browser page asks of a tab (docs/browser-v0.md §1 Mac, §5; 2026-10-03, user: 浏览器能不能根据浏览器窗口
// 大小渲染的更sharp一些):
// - Frames at the display's device pixels: the stream asks for the window's backing scale (2 on a Retina display), never
//   for more pixels than the display has. The screen is on this Mac, so there is no link to spare.
// - The tab at the browser area's size where this Mac may set it (尺寸有主, as the phone): your own tab on screen is this
//   Mac's while no other screen holds it — taken quietly, its size kept up while it is shown, given back with the window
//   or for another tab. An agent's tab only after `[ Take Over ]`.
// - The page's zoom where this Mac sizes the tab (§1 页面缩放, 2026-10-03, BrowserPageZoom.swift): its site's step, and
//   as many frame pixels to a CSS pixel as the display has for one at that zoom (more above 100 %, fewer under it).

public enum BrowserScreenPolicy {
    /// The stream of a screen on a display of `backingScale` (points to pixels) whose whole area is `displayPoints`,
    /// for a page at `zoom` (1 where this Mac does not size the tab) shown in a browser area of `area` points.
    /// The display's pixels bound the frame, as before the zoom; but where the page is zoomed out past a frame pixel a
    /// CSS pixel (`backingScale × zoom` under 1: a 2x display under 50 %, a 1x display under 100 %) the daemon still
    /// draws the CSS size, more pixels than the area has, and there the area's own pixels bound it: the screencast makes
    /// the frame that small, where the display's bound let it come up to twice the area's pixels a side, minified on
    /// screen (review, 2026-10-03).
    public static func stream(backingScale: Double, displayPoints: CGSize?, zoom: Double = 1, area: CGSize? = nil) -> BrowserStreamOptions {
        let scale = frameScale(backingScale: backingScale, zoom: zoom)
        let pastPixels = zoom > 0 && backingScale * zoom < 1
        let bound = (pastPixels ? area.flatMap { $0.width >= 1 && $0.height >= 1 ? $0 : nil } : nil) ?? displayPoints
        let pixels = bound.map { CGSize(width: (Double($0.width) * backingScale).rounded(.up), height: (Double($0.height) * backingScale).rounded(.up)) }
        let side = { (v: CGFloat) -> Int in min(max(Int(Double(v).rounded()), 100), 8192) }
        return BrowserStreamOptions(maxWidth: pixels.map { side($0.width) }, maxHeight: pixels.map { side($0.height) }, scale: scale > 1 ? scale : nil)
    }

    /// The frame pixels per CSS pixel the stream asks for: the display's device pixels times the page's zoom, since a
    /// CSS pixel is `zoom` points wide there. More above 100 %, so the zoomed page is still drawn at the display's
    /// pixels; fewer under it, so a page zoomed out comes no larger than the area shows it (at 50 % on a 2x display one
    /// frame pixel a CSS pixel: asking the display's 2 there, only the whole display's pixels bound the frame, which
    /// came about 1.4 times the area's pixels a side and was resampled on screen). Never under 1, where the daemon
    /// draws the CSS size, nor over what it takes (8; one from before the zoom draws at 3 at most, larger than its
    /// pixels but in the same place).
    public static func frameScale(backingScale: Double, zoom: Double = 1) -> Double {
        min(max(backingScale * (zoom > 0 ? zoom : 1), BrowserStreamOptions.scaleRange.lowerBound), BrowserStreamOptions.scaleRange.upperBound)
    }

    /// This Mac takes `tab` over to set its size: your own tab, on screen, nobody holding it.
    public static func claims(_ tab: BrowserTab) -> Bool { tab.owner.kind == .you && tab.heldBy == nil }

    /// This Mac sizes `tab` on its screen, and so is the one that zooms its page: a tab it holds — your own while it is
    /// on this screen, an agent's after `[ Take Over ]` — and your own that nobody holds (taken as soon as it is shown).
    public static func sizes(_ tab: BrowserTab, screen: String) -> Bool { tab.heldBy == screen || claims(tab) }

    /// The zoom of `tab` on this Mac's screen, which can use the steps `usable` (BrowserPageZoom.usable): its site's
    /// step where this Mac sizes it; 100 % with no step to take where it does not, and on a blank tab.
    public static func zoom(of tab: BrowserTab, screen: String, memory: BrowserZoomMemory, usable: [Int]) -> BrowserPageZoom {
        guard sizes(tab, screen: screen), let site = BrowserZoomMemory.site(of: tab) else { return .fixed }
        return BrowserPageZoom(remembered: memory.percent(for: site), usable: usable)
    }

    /// This Mac keeps the size of `tab` while it is shown, setting the same size again before the daemon's two idle
    /// minutes would give it back (the daemon takes the same size as a renewal): your own tab, held by this Mac.
    public static func renews(_ tab: BrowserTab, screen: String) -> Bool { tab.owner.kind == .you && tab.heldBy == screen }

    /// How often a shown tab's size is set again (well inside the daemon's two minutes).
    public static let renewal: Duration = .seconds(60)

    /// Who holds the tab as the footer says it: this Mac holding your own tab is no take-over (it is simply on this
    /// screen), so the footer writes `You` and offers nothing to hand back.
    public static func footerHolder(_ tab: BrowserTab, screen: String) -> BrowserHolder? {
        let holder = BrowserTabText.holder(tab, screen: screen)
        return holder == .thisMac && tab.owner.kind == .you ? nil : holder
    }

    /// What the footer says when this Mac's hold of `tab` ends: as `BrowserTabText.holdEnded`, except nothing when your
    /// own tab's two idle minutes ran out (it is taken again while it is shown).
    public static func holdEnded(_ tab: BrowserTab, reason: BrowserHeldReason?, heldBy: String?) -> String? {
        if tab.owner.kind == .you, reason == .idle { return nil }
        return BrowserTabText.holdEnded(reason: reason, heldBy: heldBy)
    }
}
