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
        case .dispatch: .dispatchGround
        case .terminals, .browser: .black
        }
    }
}

extension NSColor {
    /// The Dispatch page's ground (ui-v0 §7.3): black, or the warm paper of the light look. The classic look's is the
    /// same black as the terminal's (§8, 2026-10-04; user: classic不够黑，不够一体化，和终端有些割裂; a dark grey before).
    static let dispatchGround = NSColor.dynamic(light: 0xF3F1EA, dark: 0x000000, classicLight: 0xF5F5F7, classicDark: 0x000000, name: "AgentSwitchDispatchGround")
    /// The bar's edge (`--ink4`); in the classic look a hairline that reads on black.
    static let barEdge = NSColor.dynamic(light: 0xD3CEC3, dark: 0x262524, classicLight: 0xDCDCDE, classicDark: 0x2A2A2D, name: "AgentSwitchBarEdge")
}
