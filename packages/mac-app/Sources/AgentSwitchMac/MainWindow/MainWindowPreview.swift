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
/// - `main-terminals`: the Terminals bar (list, title, `+`, all the terminals' mark), Dispatch waiting for you; the
///   page itself is always dark;
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
/// - `main-browser-new`: the new tab box (recent addresses, the Mac's local servers);
/// - `main-browser-empty`: no tabs yet;
/// - `main-refresh-browser-6`: a step of the change from Dispatch to Browser.
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
            try await shot(model: model, page: .terminals, system: look, to: file("main-terminals"))
        }
        try await refresh(model: model, to: .terminals, system: NSAppearance(named: .darkAqua), name: "main-refresh", into: directory)
        try await refresh(model: model, to: .dispatch, system: NSAppearance(named: .aqua), name: "main-refresh-dispatch", into: directory)
    }

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
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(), compose: true, to: file("main-browser-new"))
        try await shot(model: model, page: .browser, system: dark, browser: BrowserDemoService(empty: true), to: file("main-browser-empty"))
        try await refresh(model: model, to: .browser, from: .dispatch, system: dark, steps: [6], name: "main-refresh-browser", into: directory)
    }

    /// Two tasks (one busy, one waiting), two terminals (the same), and the browser's tabs (an agent busy, one waiting).
    private static func state(on page: MainPage) -> MainWindowState {
        let state = MainWindowState(page: page)
        let now = Date()
        func row(_ id: String, _ kind: LiveSnapshot.Kind, waiting: Bool) -> LiveSnapshot.Row {
            LiveSnapshot.Row(id: id, kind: kind, title: id, step: "", startedAt: now, needsYou: waiting)
        }
        state.liveChanged(LiveSnapshot(rows: [row("t1", .task, waiting: false), row("t2", .task, waiting: true),
                                              row("k1", .terminal, waiting: true), row("k2", .terminal, waiting: false)], now: now))
        state.browserChanged(activity: PageActivity(busy: 1, waiting: 1), title: nil)
        return state
    }

    /// The terminal page's report for a terminal waiting for you.
    private static var head: TerminalHead {
        let head = TerminalHead()
        head.name = "AgentSwitch"
        head.git = "main ±5 ↑2"
        head.status = "waiting"
        head.mark = .waiting
        head.tag = "1 Waiting"
        return head
    }

    /// `open`: the Dispatch page opens on this task's or topic's page (as after a click on its card or chip). `browser`:
    /// the made-up browser the Browser page shows (`select`: this tab on screen; `compose`: the new tab box open; `note`:
    /// the footer's line).
    private static func shot(model: AppModel, page: MainPage, system: NSAppearance?, size: NSSize = size, open: DispatchRoute? = nil,
                             browser service: BrowserDemoService? = nil, select: String? = nil, compose: Bool = false,
                             note: String? = nil, to file: URL) async throws {
        let state = state(on: page)
        let browser = BrowserPageModel(service: { service ?? BrowserDemoService(empty: true) }, state: state, defaults: nil,
                                       recents: BrowserDemoService.recents)
        let (window, _) = makeWindow(model: model, state: state, page: page, system: system, size: size, open: open, browser: browser)
        if page == .browser {
            browser.setActive(shown: true, visible: true)
            try await DesignPreview.settle()
            if let select { browser.select(select) }
            if compose { browser.composeNew() }
            if let note { browser.say(note) }
        }
        try await DesignPreview.settle()
        try await DesignPreview.settle()
        try DesignPreview.write(window.contentView?.superview ?? window.contentView!, to: file)
        browser.stop()
        window.close()
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

    private static func makeWindow(model: AppModel, state: MainWindowState, page: MainPage, system: NSAppearance?,
                                   size: NSSize = size, open: DispatchRoute? = nil, browser: BrowserPageModel) -> (NSWindow, PageContainer) {
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
        let container = PageContainer(pages: [.dispatch: dispatch, .terminals: NSHostingView(rootView: TerminalPageStandIn()),
                                              .browser: BrowserPage.host(browser)])
        let host = NSHostingController(rootView: MainWindowRoot(state: state, head: head, model: model, content: container,
                                                                actions: MainBarActions()))
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
    var body: some View {
        HStack(spacing: 0) {
            Color.black.frame(width: 300)
                .overlay(alignment: .trailing) { Rectangle().fill(Color(nsColor: .barEdge)).frame(width: 1) }
            Text("Terminal Page · Not Loaded in Preview").mono(12).foregroundStyle(Color.inkDim)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.black)
    }
}
#endif
