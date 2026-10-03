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
/// One per open window: the window closing stops it (the terminals keep running: the daemon holds them), the next
/// window signs in afresh.
@MainActor
final class TerminalsPageController: NSObject, WKNavigationDelegate {
    private let model: AppModel
    /// The main window, once the page is in it.
    weak var window: NSWindow?
    /// What the bar shows of the terminals, as the page reports it.
    let head = TerminalHead()
    let web: TerminalWebView
    /// The native screen under the page (docs/terminal-v0.md §1 Mac).
    let screen: TerminalScreenController
    /// The page over the screen: what the window shows as its Terminals page.
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
        // The page leaves the screen to the native view (terminal.js NATIVE).
        config.userContentController.addUserScript(WKUserScript(source: "window.agentswitchNativeScreen = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = TerminalWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = .black
        screen = TerminalScreenController(client: { model.client })
        stage = TerminalStage(web: web, screen: screen.view)
        // The screen's refresh over it, under the page.
        stage.addSubview(screen.refresh, positioned: .above, relativeTo: screen.view)
        super.init()
        bridge.owner = self
        web.navigationDelegate = self
        screen.evaluate = { [weak web] js in web?.evaluateJavaScript(js, completionHandler: nil) }
        web.dropOnScreen = { [weak screen] pasteboard in screen?.drop(pasteboard) ?? false }
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
    func load(terminal id: String? = nil) {
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

    /// The bar's buttons and the window's shortcuts from Dispatch (⌘T, ⌘1–9).
    func toggleList() { web.evaluateJavaScript("window.agentswitch?.toggleList()", completionHandler: nil) }
    func newTerminal() { web.evaluateJavaScript("window.agentswitch?.newTerminal()", completionHandler: nil) }
    func shortcut(_ key: String) { web.evaluateJavaScript("window.agentswitch?.shortcut(\"\(key)\")", completionHandler: nil) }

    /// The terminal on screen while this page is the one in use: its turns need no telling (the Live Activity).
    var watching: String? {
        guard onScreen, let window, window.isKeyWindow, window.isVisible else { return nil }
        return screen.shown
    }

    /// The window became or stopped being the key window: told to the page (the screen in use sets the size).
    func windowKeyChanged(_ key: Bool) {
        web.evaluateJavaScript("window.agentswitch?.active(\(key && onScreen))", completionHandler: nil)
        // Brought to the front: the size is this window's when nobody else has it.
        if key && onScreen { screen.windowBecameKey() }
    }

    /// Shown (the keyboard to the screen or the page; the size, when nobody has it) or hidden under Dispatch.
    private func onScreenChanged() {
        let key = window?.isKeyWindow == true
        web.evaluateJavaScript("window.agentswitch?.active(\(key && onScreen))", completionHandler: nil)
        guard onScreen else { return }
        // The sign-in failed when the window opened (the service was starting): once more.
        if !loaded { load() }
        if key { screen.windowBecameKey() }
        focus()
    }

    /// The keyboard to the terminal on screen, else to the page (its new-terminal panel).
    func focus() {
        guard onScreen, let window else { return }
        window.makeFirstResponder(screen.shown != nil ? screen.view : web)
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
        web.navigationDelegate = nil
        web.configuration.userContentController.removeScriptMessageHandler(forName: "agentswitch")
        screen.stop()
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
        case "screen":
            let rect = Self.rect(body["rect"])
            web.screenRect = rect
            screen.place(Self.rect(body["area"]))
            screen.show(rect == nil ? nil : body["id"] as? String)
            screen.workdir = body["cwd"] as? String
            windowLog.debug("screen \(String(describing: rect), privacy: .public) id \(String(describing: body["id"]), privacy: .public)")
        case "overlays":
            web.overlays = (body["rects"] as? [Any] ?? []).compactMap(Self.rect)
        case "focus":
            if onScreen { screen.focus() }
        case "focusPage":
            // A field on the page wants the keyboard (the list's search, ⌘F from the terminal).
            if onScreen { window?.makeFirstResponder(web) }
        case "note":
            if let text = body["text"] as? String { screen.note(text) }
        case "claim":
            // The placeholder clicked: the size is this window's again.
            screen.claim()
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
    var probeScreen: TerminalScreenController { screen }
    var probeWeb: TerminalWebView { web }
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
        case "head", "mark", "screen", "overlays", "focus", "focusPage", "note", "claim":
            MainActor.assumeIsolated { owner?.pageSaid(body) }
        case "log":
            windowLog.notice("page: \(body["text"] as? String ?? "", privacy: .public)")
        default:
            break
        }
    }
}

/// What the bar shows of the terminals, from the page: the terminal on screen (none while one is being made) and all
/// the terminals' state.
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
