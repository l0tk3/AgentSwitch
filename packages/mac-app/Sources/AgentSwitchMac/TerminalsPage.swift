import AgentSwitchMacCore
import AppKit
import OSLog
import SwiftUI
import WebKit

/// `log show --predicate 'subsystem == "com.agentswitch.mac" && category == "terminal-window"'`
private let windowLog = Logger(subsystem: "com.agentswitch.mac", category: "terminal-window")

/// The main window's Terminals page (docs/terminal-v0.md §1, Mac; docs/dispatch-v0.md §1): AgentSwitch's own
/// terminals — list, live screen, permission requests, sealed replies, full keyboard. The daemon's terminal page in a
/// web view signed in through a one-time console link, in a data store of its own (the page's remembered choices
/// survive; the session cookie is only good until the daemon restarts), over a native SwiftTerm screen where the page
/// leaves the screen's area clear. The bar's Terminals side (the list's button, the terminal on screen as the title, new
/// terminal and all the terminals' mark) is drawn by the window from what the page reports (`head`); the page says what
/// they show and does what they ask.
/// Split panes (docs/terminal-v0.md §1 分屏, 2026-10-03): the page lays the terminal area out in panes and says where
/// each pane's screen goes (`screens`); there is one native screen a pane, each following its own terminal with its own
/// screen id, so each pane holds its terminal's size. The pane in focus has the keyboard; the bar's title and the status
/// bar are its terminal's.
/// One per open window: the window closing stops it (the terminals keep running: the daemon holds them), the next
/// window signs in afresh.
@MainActor
final class TerminalsPageController: NSObject, WKNavigationDelegate, TerminalsPage {
    var pageView: NSView { stage }
    func windowVisible(_ visible: Bool) {}

    private let model: AppModel
    /// The main window, once the page is in it.
    weak var window: NSWindow?
    /// What the bar shows of the terminals, as the page reports it.
    let head = TerminalHead()
    let web: TerminalWebView
    /// The native screens under the page (docs/terminal-v0.md §1 Mac), one a pane, by the page's pane ids.
    private var screens: [Int: TerminalScreenController] = [:]
    /// The pane in focus: its screen has the keyboard, and the status bar says its terminal's size.
    private var focusedPane = 0
    /// What each pane's screen heard last of its terminal's grid and holder.
    private var said: [Int: (grid: [Int]?, away: String?)] = [:]
    /// The screen of the pane in focus (none before the page has said where the screens go).
    var screen: TerminalScreenController? { screens[focusedPane] ?? screens.values.first }
    /// The window's page is being drawn in (each screen's own refresh gives way to it).
    var pageRefreshing: () -> Bool = { false } {
        didSet { for screen in screens.values { screen.pageRefreshing = pageRefreshing } }
    }
    /// The page over the screens: what the window shows as its Terminals page.
    let stage: TerminalStage
    /// The page's title (the terminal on screen), for the window's (Mission Control, the Window menu).
    private(set) var title: String?
    var onTitle: () -> Void = {}
    private var titleObservation: NSKeyValueObservation?
    /// A sign-in link is being fetched: a second request waits for that one.
    private var loading = false
    /// The page was asked for (a sign-in link loaded).
    private var loaded = false
    /// The terminal page has loaded: it takes `show(id)`.
    private var pageReady = false
    /// A terminal to show once the page is there.
    private var pendingTerminal: String?
    /// When the page last signed in again (at most once every few seconds, so a broken service is not asked in a loop).
    private var lastSignIn = Date.distantPast
    /// The look and the accent the page was told last (TerminalsPage+Look.swift).
    var toldLook = InterfaceLook.current
    var toldAccent = TerminalsPageController.accentHex()
    var lookObservers: [NSObjectProtocol] = []
    /// The terminals out in windows of their own (docs/dispatch-v0.md §1 单独的窗口): the page shows none of them, and
    /// asks for one to be put out (`detach`), taken back (`attach`) or brought forward (`raise`).
    private(set) var detached: Set<String> = []
    var onDetach: (String) -> Void = { _ in }
    var onAttach: (String) -> Void = { _ in }
    var onRaise: (String) -> Void = { _ in }
    /// The Terminals page is the one on screen: it has the keyboard, the page hears it is in use, and the terminal it
    /// shows takes its size from it. Hidden under Dispatch, it keeps its stream but takes nothing.
    var onScreen = false {
        didSet { if onScreen != oldValue { onScreenChanged() } }
    }

    static let page = "/ui/terminal.html"
    /// This page's own website data: the page remembers the agent, folder and permission mode chosen last.
    static let storeID = UUID(uuidString: "6B0E5C2A-3F1D-4C7E-9A52-7D8E1F4B2C90")!
    /// Pages this web view shows: signing in, and the terminal page. Anything else of the console opens nowhere.
    static let allowedPaths: Set<String> = ["/ui/login", page]

    init(model: AppModel, size: NSSize) {
        self.model = model
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: Self.storeID)
        config.applicationNameForUserAgent = "AgentSwitchMac/1"   // the page hides what only a browser needs
        let bridge = ScriptBridge()
        config.userContentController.add(bridge, name: "agentswitch")
        // The page leaves the screen to the native view (terminal.js NATIVE), Encrypt & Send to the window's status bar
        // (STATUS_BAR, 2026-10-03), and lays the terminal area out in panes this window fills (PANES).
        // It is drawn in the window's look, with the system's accent (docs/ui-v0.md §8; TerminalsPage+Look.swift).
        Self.install(scripts: config.userContentController, look: toldLook, accent: toldAccent, detached: detached)
        web = TerminalWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = .black
        stage = TerminalStage(web: web)
        super.init()
        bridge.owner = self
        web.navigationDelegate = self
        followLook()
        // A drop goes to the screen of the pane it lands on.
        web.dropOnScreen = { [weak self] pasteboard, point in
            self?.screens.values.first { $0.shown != nil && $0.view.frame.contains(point) }?.drop(pasteboard) ?? false
        }
        // The page names the window after the terminal on screen.
        titleObservation = web.observe(\.title) { [weak self] web, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.title = web.title
                self.onTitle()
            }
        }
    }

    /// Signs in and loads the page (on terminal `id` when given), unless it is loaded or on its way (then `id` is shown
    /// once it is there).
    func load() { load(terminal: nil) }

    func load(terminal id: String?) {
        if let id { pendingTerminal = id }
        guard !loading, !loaded else { return }
        loading = true
        let next = pendingTerminal.map { "\(Self.page)?id=\($0)" } ?? Self.page
        pendingTerminal = nil
        Task {
            defer { loading = false }
            do {
                let link = try await model.client.consoleLink(next: next)
                loaded = true
                web.load(URLRequest(url: link))
            } catch {
                model.errorMessage = "无法打开终端页面：\(error.localizedDescription)"
            }
        }
    }

    /// One terminal on screen (the menu bar's Live Activity card): the page switches to it, or opens on it.
    func show(terminal id: String) {
        guard pageReady else { return load(terminal: id) }
        let arg = (try? JSONEncoder().encode(id)).map { String(decoding: $0, as: UTF8.self) } ?? "null"
        web.evaluateJavaScript("window.agentswitch?.show(\(arg))", completionHandler: nil)
    }

    /// Which terminals are out in windows of their own: told to the page open now, and to the next one loaded here.
    func setDetached(_ ids: Set<String>) {
        guard ids != detached else { return }
        detached = ids
        Self.install(scripts: web.configuration.userContentController, look: toldLook, accent: toldAccent, detached: ids)
        tellDetached()
    }

    private func tellDetached() {
        web.evaluateJavaScript("window.agentswitch?.detached?.(\(Self.json(detached)))", completionHandler: nil)
    }

    /// The bar's menu: the terminal of the pane in focus goes to a window of its own.
    func detachShown() {
        if let id = screen?.shown { onDetach(id) }
    }

    /// The bar's buttons and the window's shortcuts from Dispatch (⌘T, ⌘1–9); the status bar's lock (Encrypt & Send).
    func toggleList() { web.evaluateJavaScript("window.agentswitch?.toggleList()", completionHandler: nil) }
    func seal() { web.evaluateJavaScript("window.agentswitch?.seal()", completionHandler: nil) }
    /// The bar's split buttons: the pane in focus split to the `right` or `down`, the new half empty.
    func split(_ side: String) { web.evaluateJavaScript("window.agentswitch?.split(\"\(side)\")", completionHandler: nil) }
    /// A page change is drawn in over the screens: their next snapshot is not drawn in again.
    func pageDrawsIn() { for screen in screens.values { screen.pageDrawsIn() } }
    func newTerminal() { web.evaluateJavaScript("window.agentswitch?.newTerminal()", completionHandler: nil) }
    func shortcut(_ key: String) { web.evaluateJavaScript("window.agentswitch?.shortcut(\"\(key)\")", completionHandler: nil) }

    /// The terminals on screen (one a pane) while this page is the one in use: their turns need no telling (the Live
    /// Activity).
    var watching: Set<String> {
        guard onScreen, let window, window.isKeyWindow, window.isVisible else { return [] }
        return Set(screens.values.compactMap(\.shown))
    }

    /// The window became or stopped being the key window: told to the page (the screen in use sets the size).
    func windowKeyChanged(_ key: Bool) {
        web.evaluateJavaScript("window.agentswitch?.active(\(key && onScreen))", completionHandler: nil)
        // Brought to the front: each terminal's size is this window's when nobody else has it.
        if key && onScreen { for screen in screens.values { screen.windowBecameKey() } }
    }

    /// Shown (the keyboard to the screen or the page; the size, when nobody has it) or hidden under Dispatch.
    private func onScreenChanged() {
        let key = window?.isKeyWindow == true
        web.evaluateJavaScript("window.agentswitch?.active(\(key && onScreen))", completionHandler: nil)
        guard onScreen else { return }
        // The sign-in failed when the window opened (the service was starting): once more.
        if !loaded { load() }
        if key { for screen in screens.values { screen.windowBecameKey() } }
        focus()
    }

    /// The keyboard to the terminal on screen, else to the page (its new-terminal panel).
    func focus() {
        guard onScreen, let window else { return }
        window.makeFirstResponder(screen.flatMap { $0.shown != nil ? $0.view : nil } ?? web)
    }

    /// The page's sign-in is gone (the service restarted, maybe on another port) or its process ended: sign in again
    /// in place. The terminals themselves live in the service and are all still there.
    fileprivate func signIn() {
        guard window != nil, Date().timeIntervalSince(lastSignIn) > 5 else { return }
        lastSignIn = Date()
        pageReady = false
        Task {
            do {
                let link = try await model.client.consoleLink(next: Self.page)
                loaded = true
                web.load(URLRequest(url: link))
            } catch {
                model.errorMessage = "无法连接 AgentSwitch 服务：\(error.localizedDescription)"
            }
        }
    }

    /// The window closes: nothing more to show or watch.
    func stop() {
        titleObservation = nil
        for observer in lookObservers { NotificationCenter.default.removeObserver(observer) }
        lookObservers = []
        web.navigationDelegate = nil
        web.configuration.userContentController.removeScriptMessageHandler(forName: "agentswitch")
        for screen in screens.values { screen.stop() }
    }

    // MARK: the panes' screens

    /// A pane as the page says it: where its screen goes, the terminal it shows (none: an empty pane, or a terminal
    /// being made), the folder its agent works in, whether it has the focus.
    private struct PaneScreen {
        let pane: Int
        let id: String?
        let rect: CGRect
        let cwd: String?
        let focused: Bool
    }

    private func makeScreen(_ pane: Int) -> TerminalScreenController {
        let model = model
        let screen = TerminalScreenController(client: { model.client })
        screen.pane = pane
        screen.pageRefreshing = pageRefreshing
        screen.evaluate = { [weak web] js in web?.evaluateJavaScript(js, completionHandler: nil) }
        // The status bar's grid and holder, as the screen hears them from its stream.
        screen.onSize = { [weak self] grid, away in self?.screenSaid(pane, grid: grid.map { [$0.cols, $0.rows] }, away: away) }
        screen.onClick = { [weak self] in self?.clicked(pane) }
        // The terminal's own ground, for the bar and the status bar over and under it.
        screen.onGround = { [weak self] color in
            if self?.head.ground != color { self?.head.ground = color }
        }
        stage.add(screen: screen.view, refresh: screen.refresh)
        screens[pane] = screen
        return screen
    }

    /// The screens where the page has its panes now: each placed and showing its terminal, the ones of panes that are
    /// gone taken away (their streams end, and with them their hold on the size).
    private func place(_ panes: [PaneScreen]) {
        let before = focusedPane
        var shown: Set<Int> = []
        var rects: [CGRect] = []
        // A terminal out in a window of its own is not shown here too (the page knows; said again if it missed it).
        if panes.contains(where: { $0.id.map(detached.contains) ?? false }) { tellDetached() }
        for p in panes {
            shown.insert(p.pane)
            let screen = screens[p.pane] ?? makeScreen(p.pane)
            let id = p.id.flatMap { detached.contains($0) ? nil : $0 }
            screen.place(p.rect)
            // The keyboard goes where the page says (`focus`), not to whichever pane was shown last.
            screen.show(id, keyboard: false)
            screen.workdir = p.cwd
            if id != nil { rects.append(p.rect) }
            if p.focused { focusedPane = p.pane }
        }
        for (pane, screen) in screens where !shown.contains(pane) {
            screen.stop()
            screen.view.removeFromSuperview()
            screen.refresh.removeFromSuperview()
            screens[pane] = nil
            said[pane] = nil
        }
        web.screenRects = rects
        if focusedPane != before || screens[before] == nil {
            let last = said[focusedPane]
            head.screenSaid(grid: last?.grid ?? nil, away: last?.away ?? nil)
        }
    }

    private func screenSaid(_ pane: Int, grid: [Int]?, away: String?) {
        said[pane] = (grid, away)
        if pane == focusedPane { head.screenSaid(grid: grid, away: away) }
    }

    /// A click in a pane's screen: the page gives that pane the focus (its terminal becomes the bar's and the status
    /// bar's).
    private func clicked(_ pane: Int) {
        guard pane != focusedPane else { return }
        web.evaluateJavaScript("window.agentswitch?.focusPane(\(pane))", completionHandler: nil)
    }

    // MARK: the page's reports

    /// The terminal on screen, all the terminals' mark, where its screen is and what floats over it (the native
    /// screen), a line to show under the output, the keyboard to the screen.
    fileprivate func pageSaid(_ body: [String: Any]) {
        switch body["type"] as? String {
        case "head":
            head.name = body["name"] as? String ?? ""
            head.git = body["git"] as? String ?? ""
            head.help = [body["terminal"] as? String, body["path"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            head.status = body["status"] as? String
        case "mark":
            head.mark = PixelArt.MarkState(page: body["state"] as? String)
            head.tag = body["tag"] as? String ?? ""
        case "context":
            let context = TerminalContext(report: body)
            if head.context != context { head.context = context }
        case "side":
            let width = CGFloat((body["width"] as? NSNumber)?.doubleValue ?? 0)
            if head.sideWidth != width { head.sideWidth = width }
        case "screens":
            let panes = (body["panes"] as? [[String: Any]] ?? []).compactMap { p -> PaneScreen? in
                guard let pane = (p["pane"] as? NSNumber)?.intValue, let rect = Self.rect(p["rect"]) else { return nil }
                return PaneScreen(pane: pane, id: p["id"] as? String, rect: rect, cwd: p["cwd"] as? String, focused: p["focused"] as? Bool ?? false)
            }
            place(panes)
            windowLog.debug("screens \(panes.map { "\($0.pane):\($0.id ?? "-")" }.joined(separator: " "), privacy: .public)")
        case "screen":
            // A page that knows one screen (an older service's): one pane.
            guard let area = Self.rect(body["area"]) else { break }
            place([PaneScreen(pane: 0, id: Self.rect(body["rect"]) == nil ? nil : body["id"] as? String, rect: area, cwd: body["cwd"] as? String, focused: true)])
            if screen?.shown != nil, onScreen { screen?.focus() }
        case "overlays":
            web.overlays = (body["rects"] as? [Any] ?? []).compactMap(Self.rect)
        case "focus":
            if onScreen { screen?.focus() }
        case "focusPage":
            // A field on the page wants the keyboard (the list's search, ⌘F from the terminal).
            if onScreen { window?.makeFirstResponder(web) }
        case "note":
            if let text = body["text"] as? String { screen?.note(text) }
        case "claim":
            // A pane's placeholder clicked: its terminal's size is this window's again.
            ((body["pane"] as? NSNumber).flatMap { screens[$0.intValue] } ?? screen)?.claim()
        default:
            break
        }
    }

    /// `[x, y, width, height]` from the page.
    private static func rect(_ value: Any?) -> CGRect? {
        guard let r = value as? [Double], r.count == 4 else { return nil }
        return CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
    }

    /// The page asks for a folder: the system's open panel, as a sheet on the window.
    fileprivate func chooseFolder(startingAt path: String?) {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        if let path, !path.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
        }
        let web = web
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url,
                  let arg = try? JSONSerialization.data(withJSONObject: [url.path]), let json = String(data: arg, encoding: .utf8) else { return }
            MainActor.assumeIsolated {
                web.evaluateJavaScript("window.agentswitch?.folderChosen(...\(json))", completionHandler: nil)
            }
        }
    }

    // MARK: navigation

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { signIn() }

    /// The page loaded: keys go to it while it is on screen, it learns whether it is in use, and a terminal asked for
    /// meanwhile is shown.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let window else { return }
        if onScreen { window.makeFirstResponder(webView) }
        webView.evaluateJavaScript("window.agentswitch?.active(\(window.isKeyWindow && onScreen))", completionHandler: nil)
        guard webView.url?.path == Self.page else { return }
        pageReady = true
        if let id = pendingTerminal {
            pendingTerminal = nil
            show(terminal: id)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { signIn() }

    /// Only the daemon's terminal page (and signing in) loads here; web links open in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        if url.host == "127.0.0.1" {
            decisionHandler(!mainFrame || Self.allowedPaths.contains(url.path) ? .allow : .cancel)
            return
        }
        if url.scheme == "about" || url.scheme == "data" { return decisionHandler(.allow) }
        if url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    #if DEBUG
    var probeScreen: TerminalScreenController? { screen }
    var probeScreens: [Int: TerminalScreenController] { screens }
    var probeWeb: TerminalWebView? { web }
    #endif
}

/// The page's `window.webkit.messageHandlers.agentswitch`; weak, so the web view does not keep the controller alive.
private final class ScriptBridge: NSObject, WKScriptMessageHandler {
    weak var owner: TerminalsPageController?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        switch body["type"] as? String {
        case "chooseFolder":
            let path = body["path"] as? String
            MainActor.assumeIsolated { owner?.chooseFolder(startingAt: path) }
        case "openURL":
            if let text = body["url"] as? String, let url = URL(string: text) { MainActor.assumeIsolated { LinkOpener.open(url) } }
        case "signIn":
            MainActor.assumeIsolated { owner?.signIn() }
        case "detach", "attach", "raise":
            guard let id = body["id"] as? String, !id.isEmpty else { break }
            let kind = body["type"] as? String
            MainActor.assumeIsolated {
                guard let owner else { return }
                switch kind {
                case "detach": owner.onDetach(id)
                case "attach": owner.onAttach(id)
                default: owner.onRaise(id)
                }
            }
        case "head", "mark", "context", "side", "screen", "screens", "overlays", "focus", "focusPage", "note", "claim":
            MainActor.assumeIsolated { owner?.pageSaid(body) }
        case "log":
            windowLog.notice("page: \(body["text"] as? String ?? "", privacy: .public)")
        default:
            break
        }
    }
}

/// What the bar and the status bar show of the terminals, from the page: the terminal on screen (none while one is being
/// made), all the terminals' state, and the terminal on screen's agent, mode and size (`context`).
@MainActor
@Observable
final class TerminalHead {
    /// The folder the agent works in now (its name), and that folder's git (`main ±5 ↑2`).
    var name = ""
    var git = ""
    /// The terminal's own name and the folder's path, under the pointer.
    var help = ""
    var status: String?
    var mark: PixelArt.MarkState = .off
    var tag = ""
    var context: TerminalContext?
    /// The list's column on the page, in points; nothing while it is closed. The window's bars draw their lines only
    /// as far as its edge (MainWindowRoot).
    var sideWidth: CGFloat = 0
    /// The terminal's own ground (its theme's): the bar's and the status bar's over and under the terminal.
    var ground: NSColor?
    /// The pane in focus shows its terminal's record (the simple view): the window takes the system's light or dark,
    /// its bars with it, and the bar's switch says the other view.
    var simple = false
    /// The native screen's word on the terminal on screen: its grid as the service has it (`[cols, rows]`, nil before the
    /// stream says it) and where it is in use when not here.
    private(set) var grid: [Int]?
    private(set) var away: String?

    func screenSaid(grid: [Int]?, away: String?) {
        if self.grid != grid { self.grid = grid }
        if self.away != away { self.away = away }
    }

    /// The status bar's terminal: the page's report, with the grid and the holder the screen heard last.
    var shown: TerminalContext? {
        context.map { $0.seen(cols: grid?.first, rows: grid?.last, away: away) }
    }
}

extension PixelArt.MarkState {
    /// The page's word for it (terminal.js markState).
    init(page: String?) {
        switch page {
        case "busy": self = .busy
        case "waiting": self = .waiting
        case "idle": self = .idle
        default: self = .off
        }
    }
}
