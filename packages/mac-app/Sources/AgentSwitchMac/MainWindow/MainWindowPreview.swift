#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The main window for `-designPreview <dir>` (DesignPreview.swift; debug builds only): the bar over each page, drawn
/// off screen from made-up work — no service, no sign-in, no web view (a plain stand-in takes the terminal page's place).
/// Run the debug binary with only that argument, e.g.
///
///     swift build && .build/debug/AgentSwitchMac -designPreview /tmp/agentswitch-preview
///
/// and it writes, light and dark (`-dark`), beside the menu and settings pictures — the Dispatch page drawn from the
/// demo's made-up Mac (DispatchDemo.swift, the work of `docs/design/implemented/mac-window.html`):
/// - `main-dispatch`: Dispatch's record at its end, the counts `⠙1 ▪1`, Terminals waiting for you;
/// - `main-dispatch-full`: the same record in a window tall enough for all of it;
/// - `main-dispatch-task`: a task's page — `‹` + mark + title, the approval, the process — with the gateway down
///   (`■ Gateway Down`);
/// - `main-dispatch-topic`: a topic's page;
/// - `main-dispatch-code`: a task's page with code (2026-10-03) — what you typed with a fenced block, the result's block
///   and inline code;
/// - `main-terminals`: the Terminals bar (list, title, `+`, all the terminals' mark), Dispatch waiting for you; the
///   page itself is always dark;
/// - `main-terminals-fullscreen`: the same full screen — the system's traffic lights gone, the bar's own in their place;
/// - `main-refresh-2`, `-6`, `-10` (dark): steps of a change from Dispatch to Terminals held still (as the demo's
///   `?freeze=`): the bar already on Terminals, the page drawn in down to the scan line, black below it;
/// - `main-refresh-dispatch-2`, `-6`, `-10` (light): the same back to Dispatch, the scan line in ink on the paper;
/// - `main-browser`: the Browser page (always dark) from a made-up browser (BrowserDemo.swift, the tabs of
///   `docs/design/implemented/browser.html`): Codex's pull request on screen, its last click boxed, `[ Take Over ]`;
/// - `main-browser-held`: the same tab taken over by this Mac (`You · Taken Over from Codex`, `[ Hand Back ]`; no Fill
///   Ciphertext on an agent's tab), the take-over notice in the footer;
/// - `main-browser-filled`: your local dev server's page, a ciphertext just filled (`[ Fill Ciphertext ]`, `Filled
///   dev/pass · localhost:5173`);
/// - `main-browser-fill`, `main-browser-fill-new`: Fill Ciphertext's sheet over that page — a ciphertext to paste; the
///   New… form with the page's site filled in;
/// - `main-browser-waiting`: the task's login waiting for a code (`[ Take Over ]` filled);
/// - `main-browser-file`: one of your tabs, a file of the Mac's (no hold, no lock);
/// - `main-browser-zoom`: your dev server's page zoomed to 125 % (2026-10-03): the status bar's `−` `125%` `+`, the
///   page laid out for the browser area ÷ 1.25 and drawn across it; in the other pictures the zoom is at the bar's far
///   right at 100 %, dim on a tab this Mac does not size (Codex's before `[ Take Over ]`);
/// - `main-browser-new`: the new tab box (recent addresses, the Mac's local servers);
/// - `main-browser-empty`: no tabs yet;
/// - `main-refresh-browser-6`: a step of the change from Dispatch to Browser;
/// - `main-rail-hidden`, `main-rail-hidden-dispatch`: the rail put away (docs/dispatch-v0.md §1 图标栏可以收起,
///   2026-10-04) on Terminals and on Dispatch — the bars on the window's edge: Dispatch at work, Terminals waiting for
///   you, Browser with nothing going on (no bar);
/// - `main-rail-quiet`: the same with nothing going on anywhere: the one bar of the page on screen;
/// - `main-bare`: the rail put away and the page's list closed: no line anywhere — the bar, the terminal and the status
///   bar one surface;
/// - `main-rail-out`: the pointer on the edge, the rail out over the page.
/// `-designPreviewOnly browser` draws only the Browser pictures.
@MainActor
enum MainWindowPreview {
    static let size = NSSize(width: 1280, height: 820)
    /// Tall enough for the demo's whole record.
    static let fullSize = NSSize(width: 1280, height: 1640)

    static func render(model: AppModel, into directory: URL) async throws {
        try await renderBrowser(model: model, into: directory)
        for (suffix, name) in [("", NSAppearance.Name.aqua), ("-dark", .darkAqua)] {
            let look = NSAppearance(named: name)
            func file(_ base: String) -> URL { directory.appendingPathComponent("\(base)\(suffix).png") }
            try await shot(model: model, page: .dispatch, system: look, to: file("main-dispatch"))
            try await shot(model: model, page: .dispatch, system: look, size: fullSize, to: file("main-dispatch-full"))
            model.loadDemo(gate: .notResponding)
            try await shot(model: model, page: .dispatch, system: look, open: .task("t1"), to: file("main-dispatch-task"))
            model.loadDemo()
            try await shot(model: model, page: .dispatch, system: look, open: .topic("th1"), to: file("main-dispatch-topic"))
            try await shot(model: model, page: .dispatch, system: look, open: .task("t5"), to: file("main-dispatch-code"))
            try await shot(model: model, page: .terminals, system: look, to: file("main-terminals"))
        }
        try await shot(model: model, page: .terminals, system: NSAppearance(named: .darkAqua), fullScreen: true,
                       to: directory.appendingPathComponent("main-terminals-fullscreen.png"))
        try await refresh(model: model, to: .terminals, system: NSAppearance(named: .darkAqua), name: "main-refresh", into: directory)
        try await refresh(model: model, to: .dispatch, system: NSAppearance(named: .aqua), name: "main-refresh-dispatch", into: directory)
        try await renderRail(model: model, into: directory)
    }

    /// The rail put away, and out again under the pointer.
    /// `main-clash`: the Clash page (docs/clash-v0.md §6) from a made-up Clash Verge, what is still to do at its top.
    static func renderClash(model: AppModel, into directory: URL) async throws {
        try await shot(model: model, page: .clash, system: NSAppearance(named: .darkAqua), to: directory.appendingPathComponent("main-clash.png"))
    }

    static func renderRail(model: AppModel, into directory: URL) async throws {
        func file(_ base: String) -> URL { directory.appendingPathComponent("\(base).png") }
        let dark = NSAppearance(named: .darkAqua)
        try await shot(model: model, page: .terminals, system: dark, rail: .hidden, to: file("main-rail-hidden"))
        try await shot(model: model, page: .dispatch, system: dark, rail: .hidden, to: file("main-rail-hidden-dispatch"))
        try await shot(model: model, page: .terminals, system: dark, rail: .out, to: file("main-rail-out"))
        try await shot(model: model, page: .terminals, system: dark, rail: .quiet, to: file("main-rail-quiet"))
        // Everything put away — the rail, and the page's list: no line anywhere (BarRule).
        try await shot(model: model, page: .terminals, system: dark, rail: .bare, to: file("main-bare"))
    }

    /// The rail in a picture: as it is, put away, put away with nothing going on anywhere, put away with the page's
    /// list closed too, or put away and out under the pointer.
    enum Rail { case shown, hidden, quiet, bare, out }

    /// The Browser page's pictures (always dark: one look).
    static func renderBrowser(model: AppModel, into directory: URL) async throws {
        func file(_ base: String) -> URL { directory.appendingPathComponent("\(base).png") }
        let dark = NSAppearance(named: .darkAqua)
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(), to: file("main-browser"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(holding: "pr"),
                       note: BrowserTabText.takeOverNotice, to: file("main-browser-held"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(), select: "vite",
                       note: BrowserFillText.done(BrowserFillResult(label: "dev/pass", host: "localhost:5173")),
                       to: file("main-browser-filled"))
        try await fillSheet(model: model, startsNew: false, to: file("main-browser-fill"))
        try await fillSheet(model: model, startsNew: true, to: file("main-browser-fill-new"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(), select: "portal", to: file("main-browser-waiting"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(), select: "mesh", to: file("main-browser-file"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(holding: "vite"), select: "vite", zoom: 125,
                       to: file("main-browser-zoom"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(), compose: true, to: file("main-browser-new"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(empty: true), to: file("main-browser-empty"))
        // Tabs with windows of their own (docs/browser-v0.md §7.2; implemented/browser-window.html): a tab of yours, an
        // agent's at work, one you stepped into, one a phone holds — the last two also in the classic look's twin below.
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(windows: true), select: "vite", to: file("main-browser-window"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(windows: true), select: "pr", to: file("main-browser-window-agent"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(windows: true, heldBy: ["pr": BrowserDefaults.windowScreen]),
                       select: "pr", to: file("main-browser-window-took"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(windows: true, heldBy: ["portal": "phone-1a2b3c4d"]),
                       select: "portal", to: file("main-browser-window-phone"))
        // The identity and engine box (states identity / update / missing of the same design page).
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(windows: true), select: "vite", identity: .identity,
                       to: file("main-browser-identity"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(windows: true), select: "vite", identity: .updating,
                       to: file("main-browser-engine-update"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(), select: "vite", identity: .missing,
                       to: file("main-browser-engine-missing"))
        try await refresh(model: model, to: .browser, from: .dispatch, system: dark, steps: [6], name: "main-refresh-browser", into: directory)
    }

    /// Two tasks (one busy, one waiting), two terminals (the same), and the browser's tabs (an agent busy, one waiting).
    /// With the rail put away, each page a different bar: a task at work, a terminal waiting, nothing in the browser.
    private static func state(on page: MainPage, rail: Rail = .shown) -> MainWindowState {
        let state = MainWindowState(page: page, railHidden: rail != .shown)
        let now = Date()
        func row(_ id: String, _ kind: LiveSnapshot.Kind, waiting: Bool) -> LiveSnapshot.Row {
            LiveSnapshot.Row(id: id, kind: kind, title: id, step: "", startedAt: now, needsYou: waiting)
        }
        guard rail == .shown else {
            if rail != .quiet, rail != .bare {
                state.liveChanged(LiveSnapshot(rows: [row("t1", .task, waiting: false), row("k1", .terminal, waiting: true)], now: now))
            }
            state.showRail(out: rail == .out)
            return state
        }
        state.liveChanged(LiveSnapshot(rows: [row("t1", .task, waiting: false), row("t2", .task, waiting: true),
                                              row("k1", .terminal, waiting: true), row("k2", .terminal, waiting: false)], now: now))
        state.browserChanged(activity: PageActivity(busy: 1, waiting: 1), title: nil)
        return state
    }

    /// The terminal page's report for a terminal waiting for you.
    private static func head(list: Bool) -> TerminalHead {
        let head = TerminalHead()
        head.name = "AgentSwitch"
        head.git = "main ±5 ↑2"
        head.status = "waiting"
        head.mark = .waiting
        head.tag = "1 Waiting"
        head.context = TerminalContext(harness: "claude-code", model: "claude-opus-5-5", mode: "bypass", cols: 139, rows: 46)
        // The stand-in page's list (TerminalPageStandIn).
        head.sideWidth = list ? 300 : 0
        return head
    }

    /// `open`: the Dispatch page opens on this task's or topic's page (as after a click on its card or chip). `browser`:
    /// the made-up browser the Browser page shows (`select`: this tab on screen; `compose`: the new tab box open; `note`:
    /// the footer's line; `zoom`: the page zoomed in to this step).
    private static func shot(model: AppModel, page: MainPage, system: NSAppearance?, size: NSSize = size, open: DispatchRoute? = nil,
                             browser service: BrowserDemoService? = nil, select: String? = nil, compose: Bool = false,
                             note: String? = nil, zoom: Int? = nil, identity: BrowserIdentityDemo? = nil, fullScreen: Bool = false, rail: Rail = .shown,
                             to file: URL) async throws {
        let state = state(on: page, rail: rail)
        let browser = BrowserPageModel(service: { service ?? BrowserDemoService(empty: true) }, state: state, defaults: nil,
                                       recents: BrowserDemoService.recents)
        let (window, _) = makeWindow(model: model, state: state, page: page, system: system, size: size, open: open, browser: browser, rail: rail)
        if fullScreen {
            for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(button)?.isHidden = true }
            state.fullScreen = true
            state.windowChanged(key: true, visible: true)   // the lights in colour, as in the window in use
        }
        if page == .browser {
            browser.setActive(shown: true, visible: true)
            try await DesignPreview.settle()
            if let select { browser.select(select) }
            if compose { browser.composeNew() }
            if let note { browser.say(note) }
            if let zoom { try await zoomIn(browser, to: zoom) }
            // The status bar's right end, and its box where a picture is of it.
            let shown = identity ?? (browser.windows ? .closed : .chrome)
            browser.identity.preview(identity: shown.identity, engine: shown.engine, inUse: shown.inUse, open: shown.open)
        }
        try await DesignPreview.settle()
        try await DesignPreview.settle()
        try DesignPreview.write(window.contentView?.superview ?? window.contentView!, to: file)
        browser.stop()
        window.close()
    }

    /// The tab on screen zoomed in to `percent` a step at a time, as `+` does it, then its picture as the daemon would
    /// send it for the size this Mac asks for now (the made-up browser's pictures are of one size).
    private static func zoomIn(_ browser: BrowserPageModel, to percent: Int) async throws {
        for _ in BrowserPageZoom.steps where (browser.zoom?.percent ?? percent) < percent { browser.zoomIn() }
        try await DesignPreview.settle()
        guard let id = browser.selectedID, let asked = browser.screen.viewportRequest,
              let frame = BrowserDemoService.frame(of: id, sized: asked) else { return }
        browser.screen.show(frame)
    }

    /// Fill Ciphertext's sheet over your local dev server's page (always dark, as the page); `startsNew`: the New… form,
    /// the page's site filled in.
    private static func fillSheet(model: AppModel, startsNew: Bool, to file: URL) async throws {
        let demo = BrowserDemoService()
        let browser = BrowserPageModel(service: { demo }, state: nil, defaults: nil,
                                       sealer: { _ in throw CommandError("演示数据，未生成密文。") })
        let target = BrowserFillTarget(tabId: "vite", site: GateSealRequest.host(of: "http://localhost:5173/"))
        try await DesignPreview.renderSheet(BrowserFillSheet(model: browser, target: target, startsNew: startsNew)
                                                .environment(\.colorScheme, .dark),
                                            model: model, appearance: NSAppearance(named: .darkAqua), to: file)
    }

    /// A few steps of the refresh that draws `page` in, from the other page: the page and the bar changed at once, as
    /// the window does, each step held still.
    private static func refresh(model: AppModel, to page: MainPage, from: MainPage? = nil, system: NSAppearance?, steps: [Int] = [2, 6, 10],
                                name: String, into directory: URL) async throws {
        let from = from ?? (page == .dispatch ? .terminals : .dispatch)
        let state = state(on: from)
        let demo = BrowserDemoService()
        let browser = BrowserPageModel(service: { demo }, state: state, defaults: nil)
        let (window, container) = makeWindow(model: model, state: state, page: from, system: system, browser: browser)
        try await DesignPreview.settle()
        state.show(page)
        MainWindowController.dress(window, for: page, system: system)
        container.show(page)
        if page == .browser {
            browser.setActive(shown: true, visible: true)
            try await DesignPreview.settle()
        }
        for step in steps {
            container.refresh.show(step: step, of: .page, ground: page.ground, line: .scanLine)
            try await DesignPreview.settle()
            try DesignPreview.write(window.contentView?.superview ?? window.contentView!,
                                    to: directory.appendingPathComponent("\(name)-\(step).png"))
        }
        container.refresh.cancel()
        browser.stop()
        window.close()
    }

    /// The same window to keep on screen (PerfProbe): its state, to change pages with.
    static func liveWindow(model: AppModel, page: MainPage) -> (NSWindow, PageContainer, MainWindowState) {
        let state = state(on: page)
        let browser = BrowserPageModel(service: { BrowserDemoService() }, state: state, defaults: nil)
        let (window, container) = makeWindow(model: model, state: state, page: page, system: nil, browser: browser)
        return (window, container, state)
    }

    private static func makeWindow(model: AppModel, state: MainWindowState, page: MainPage, system: NSAppearance?,
                                   size: NSSize = size, open: DispatchRoute? = nil, browser: BrowserPageModel,
                                   rail: Rail = .shown) -> (NSWindow, PageContainer) {
        let window = PreviewWindow(contentRect: NSRect(origin: .zero, size: size),
                                   styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                                   backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        let dispatch = NSHostingView(rootView: DispatchRoot(model: model, state: state)
            .environment(\.dispatchService, DispatchDemoService())
            .environment(\.dispatchPreviewRoute, open))
        let container = PageContainer(pages: [.dispatch: dispatch, .terminals: NSHostingView(rootView: TerminalPageStandIn(list: rail != .bare)),
                                              .browser: BrowserPage.host(browser),
                                              .clash: NSHostingView(rootView: ClashPage(state: state, demo: .demo).environment(model))])
        let host = NSHostingController(rootView: MainWindowRoot(state: state, head: head(list: rail != .bare), model: model, content: container,
                                                                actions: MainBarActions(), browser: browser))
        host.sizingOptions = []
        window.contentViewController = host
        window.setContentSize(size)
        state.barHeight = max(28, window.frame.height - window.contentLayoutRect.height)
        state.lightsEnd = window.standardWindowButton(.zoomButton)?.frame.maxX ?? 70
        MainWindowController.dress(window, for: page, system: system)
        container.show(page)
        return (window, container)
    }
}

/// Where the terminal page would be: its list's edge and a line saying it is not loaded here.
private struct TerminalPageStandIn: View {
    /// Its list is open.
    var list = true

    var body: some View {
        HStack(spacing: 0) {
            if list {
                Color.black.frame(width: 300)
                    .overlay(alignment: .trailing) { Rectangle().fill(Color(nsColor: .barEdge)).frame(width: 1) }
            }
            Text("Terminal Page · Not Loaded in Preview").mono(12).foregroundStyle(Color.inkDim)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.black)
    }
}
#endif
