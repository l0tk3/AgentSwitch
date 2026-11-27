import AgentSwitchMacCore
import AppKit

// Changing pages is a refresh (docs/dispatch-v0.md §1 "换页即刷新"; ui-v0 §7.4; demo docs/design/implemented/mac-window.html,
// `?freeze=0…12` step by step): the new page goes in at once and is drawn in from the top over the area under the bar,
// 13 steps in 0.26 s with a scan line ahead (`ScanRefresh.page`), as the phone's and the web's terminal screen are. The
// channel change it replaced belongs to switching hosts now (the mesh demo, shelved).

/// The window below the bar: every page, one shown, and over them the refresh that draws a page in, which never takes
/// the mouse. Any number of pages: each is a view the window hands it, in `MainPage.allCases` order.
final class PageContainer: NSView {
    let pages: [MainPage: NSView]
    let refresh = ScanRefreshView()
    private(set) var shown: MainPage?

    init(pages: [MainPage: NSView]) {
        self.pages = pages
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        wantsLayer = true
        for page in MainPage.allCases {
            guard let view = pages[page] else { continue }
            view.autoresizingMask = [.width, .height]
            view.isHidden = true
            addSubview(view)
        }
        addSubview(refresh)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func layout() {
        super.layout()
        for view in pages.values where view.frame != bounds { view.frame = bounds }
        if refresh.frame != bounds { refresh.frame = bounds }
    }

    /// The page shown; the others hidden (their keys, their drawing, their size claims stop with them).
    func show(_ page: MainPage) {
        shown = page
        for (key, view) in pages { view.isHidden = key != page }
    }

    /// The page on screen drawn in from the top: its ground below the edge, the scan line ahead.
    func drawIn(_ page: MainPage) {
        refresh.play(.page, ground: page.ground, line: .scanLine)
    }
}

extension MainPage {
    /// The page's ground: what the window shows behind it, and below the refresh's edge while it is drawn in.
    var ground: NSColor {
        switch self {
        // Clash too since 2026-11-11: the app's own ground, light or dark with the system (black whatever before).
        case .dispatch, .clash, .rooms: .dispatchGround
        // The browser's screen: black while the pages are all dark, else the app's own ground with the system.
        case .browser: MainPage.followSystem ? .dispatchGround : .black
        case .terminals: .black
        }
    }
}

extension NSColor {
    /// The Dispatch page's ground (ui-v0 §7.3): black, or the warm paper of the light look. In the classic look the
    /// content's ground is the window's (§8.1, 2026-11-26): white, or a near black beside the terminal's own; the
    /// bar, the rail and the status bar are drawn on it, the side columns float over it as cards.
    static let dispatchGround = NSColor.dynamic(light: 0xFAF9F6, dark: 0x000000, classicLight: 0xFFFFFF, classicDark: 0x0D0E10, name: "AgentSwitchDispatchGround")
    /// The bar's edge (`--ink4`); in the classic look the faint line inside the content.
    static let barEdge = NSColor.dynamic(light: 0xDCD8CF, dark: 0x262524, classicLight: 0xE6E7EB, classicDark: 0x26272C, name: "AgentSwitchBarEdge")
}
