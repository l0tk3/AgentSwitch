import AgentSwitchMacCore

/// The Browser page's zoom (docs/browser-v0.md §1 页面缩放, 2026-10-03, user: 然后我发现agentswitch的浏览器页没有放大缩小的
/// 选项，加上 用来调节大小): the status bar's `−` `100%` `+` (BrowserZoomItems) and ⌘− ⌘+. It is the page's own zoom, as a
/// browser's: a tab this Mac sizes (尺寸有主: your own while it is on this screen, an agent's after `[ Take Over ]`) is
/// given the browser area ÷ the zoom and drawn across the whole area, so the page is laid out for a smaller window and
/// everything on it is larger, or the other way round. The daemon knows nothing of it.
///
/// - What is in force: the tab's site's step, remembered on this Mac (`browser.zoom`, BrowserZoomMemory), as near to
///   it as the browser area allows (BrowserPageZoom); 100 % and no step to take where this Mac does not size the tab.
/// - A step: remembered for the site, then put to work at once (`followZoom`, BrowserPageModel.swift): the size set
///   again, the stream asked again when the frame pixels it asks for changed. The same when the tab on screen goes to
///   another site while this Mac holds it. The size renewed each minute is the one at the zoom in force.
extension BrowserPageModel {
    /// The zoom of the tab on screen; nil without a tab (the status bar shows nothing then).
    var zoom: BrowserPageZoom? { current.map(zoom(of:)) }

    /// This Mac sizes the tab on screen, so `−` and `+` zoom its page.
    var canZoom: Bool { current.map { BrowserScreenPolicy.sizes($0, screen: screenID) } ?? false }

    /// The zoom of `tab` on this Mac's screen now: what is remembered of its site, among the steps the area can use.
    func zoom(of tab: BrowserTab) -> BrowserPageZoom {
        BrowserScreenPolicy.zoom(of: tab, screen: screenID, memory: zoomMemory, usable: zoomSteps)
    }

    /// `+`, ⌘+ and ⌘=: the next step up; nothing at the last one.
    func zoomIn() { setZoom(zoom?.larger) }

    /// `−`, ⌘−: the next step down.
    func zoomOut() { setZoom(zoom?.smaller) }

    /// The percent: back to 100 %, which forgets the site.
    func zoomReset() { setZoom(BrowserPageZoom.standard) }

    /// The site of the tab on screen at `percent` from now on (nil: no such step), on this Mac. A tab this Mac does
    /// not size says why nothing happens, as its input does; a blank tab stays at 100 %.
    private func setZoom(_ percent: Int?) {
        guard let tab = current else { return }
        guard canZoom else { return say(BrowserZoomText.notSized) }
        guard let percent, let site = BrowserZoomMemory.site(of: tab), percent != zoom(of: tab).percent else { return }
        zoomMemory = zoomMemory.setting(percent, for: site)
        followZoom(sizing: true)
    }
}
