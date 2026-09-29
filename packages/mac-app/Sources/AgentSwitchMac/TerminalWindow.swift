import AgentSwitchMacCore
import AppKit
import WebKit

/// The terminal window (docs/terminal-v0.md §1, Mac): AgentSwitch's own terminals — list, live screen, permission
/// requests, sealed replies, full keyboard. v0 shows the daemon's terminal page in a web view signed in through a
/// one-time console link, in a data store of its own (the page's remembered choices survive; the session cookie is
/// only good until the daemon restarts); a native
/// SwiftTerm view comes later. One dark surface: the titlebar is transparent and the page runs under it, so the
/// traffic lights sit on the page's sidebar. Closing the window leaves the terminals running: the daemon holds them.
@MainActor
final class TerminalWindowController: NSObject, WKNavigationDelegate {
    private let model: AppModel
    private(set) var window: NSWindow?
    /// Told when the window opens (true) or closes (false), for the Dock icon.
    var onVisibilityChange: (Bool) -> Void = { _ in }
    private var closeObserver: NSObjectProtocol?
    private var titleObservation: NSKeyValueObservation?
    /// A sign-in link is being fetched: a second click waits for that window instead of making another.
    private var opening = false
    /// When the page last signed in again (at most once every few seconds, so a broken service is not asked in a loop).
    private var lastSignIn = Date.distantPast

    static let page = "/ui/terminal.html"
    /// This window's own website data: the page remembers the agent, folder and permission mode chosen last.
    static let storeID = UUID(uuidString: "6B0E5C2A-3F1D-4C7E-9A52-7D8E1F4B2C90")!
    static let contentSize = NSSize(width: 1280, height: 820)
    /// The page's one surface over a black screen (terminal.css --term, sidebar included; ui-v0 §7): no flash before
    /// it paints.
    static let background = NSColor.black
    /// Pages this window shows: signing in, and the terminal page. Anything else of the console opens nowhere.
    static let allowedPaths: Set<String> = ["/ui/login", page]

    init(model: AppModel) {
        self.model = model
    }

    func show() {
        if let window {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }
        guard !opening else { return }
        opening = true
        Task {
            defer { opening = false }
            do {
                let link = try await model.client.consoleLink(next: Self.page)
                open(link)
            } catch {
                model.errorMessage = "无法打开终端窗口：\(error.localizedDescription)"
            }
        }
    }

    /// The page's sign-in is gone (the service restarted, maybe on another port) or its process ended: sign in again
    /// in place. The terminals themselves live in the service and are all still there.
    fileprivate func signIn() {
        guard window != nil, Date().timeIntervalSince(lastSignIn) > 5 else { return }
        lastSignIn = Date()
        Task {
            do {
                let link = try await model.client.consoleLink(next: Self.page)
                webView?.load(URLRequest(url: link))
            } catch {
                model.errorMessage = "无法连接 AgentSwitch 服务：\(error.localizedDescription)"
            }
        }
    }

    private func open(_ link: URL) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: Self.storeID)
        config.applicationNameForUserAgent = "AgentSwitchMac/1"   // the page hides what only a browser needs
        config.userContentController.add(ScriptBridge(self), name: "agentswitch")
        let web = TerminalWebView(frame: NSRect(origin: .zero, size: Self.contentSize), configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = Self.background

        let window = NSWindow(contentRect: NSRect(origin: .zero, size: Self.contentSize),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "terminal"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = Self.background
        window.contentView = Self.container(web)
        // Wider than the page's narrow layout (760 pt, terminal.css): the sidebar stays on screen at the smallest size.
        window.minSize = NSSize(width: 800, height: 480)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("AgentSwitchTerminal")
        if !window.setFrameUsingName("AgentSwitchTerminal") { window.center() }
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.closed() }
        }
        // The page names the window after the terminal on screen (Mission Control, the Window menu).
        titleObservation = web.observe(\.title) { [weak window] web, _ in
            MainActor.assumeIsolated {
                if let title = web.title, !title.isEmpty { window?.title = title }
            }
        }
        self.window = window
        web.load(URLRequest(url: link))
        onVisibilityChange(true)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// The web view under the transparent titlebar, with a drag strip over the page's top band: the band holds no
    /// controls (terminal.css), so the strip takes its clicks and moves the window, as a titlebar would.
    private static func container(_ web: WKWebView) -> NSView {
        let root = NSView(frame: web.frame)
        let strip = DragStrip()
        for view in [web, strip] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(view)
        }
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: root.topAnchor),
            web.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            strip.topAnchor.constraint(equalTo: root.topAnchor),
            strip.heightAnchor.constraint(equalToConstant: DragStrip.height),
            strip.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        ])
        return root
    }

    private var webView: WKWebView? {
        window?.contentView?.subviews.compactMap { $0 as? WKWebView }.first
    }

    /// Next time the window signs in afresh (the daemon may have restarted and forgotten the session).
    private func closed() {
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        closeObserver = nil
        titleObservation = nil
        if let web = webView {
            web.navigationDelegate = nil
            web.configuration.userContentController.removeScriptMessageHandler(forName: "agentswitch")
        }
        window = nil
        onVisibilityChange(false)
    }

    /// The page asks for a folder: the system's open panel, as a sheet on this window.
    fileprivate func chooseFolder(startingAt path: String?) {
        guard let window, let web = webView else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "choose"
        if let path, !path.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
        }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url,
                  let arg = try? JSONSerialization.data(withJSONObject: [url.path]), let json = String(data: arg, encoding: .utf8) else { return }
            MainActor.assumeIsolated {
                web.evaluateJavaScript("window.agentswitch?.folderChosen(...\(json))", completionHandler: nil)
            }
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { signIn() }

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
}

/// The page's `window.webkit.messageHandlers.agentswitch`; weak, so the web view does not keep the controller alive.
private final class ScriptBridge: NSObject, WKScriptMessageHandler {
    weak var owner: TerminalWindowController?

    init(_ owner: TerminalWindowController) {
        self.owner = owner
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        switch body["type"] as? String {
        case "chooseFolder":
            let path = body["path"] as? String
            MainActor.assumeIsolated { owner?.chooseFolder(startingAt: path) }
        case "openURL":
            if let text = body["url"] as? String, let url = URL(string: text) { MainActor.assumeIsolated { Self.open(url) } }
        case "signIn":
            MainActor.assumeIsolated { owner?.signIn() }
        default:
            break
        }
    }

    /// A link ⌘-clicked in a terminal: web links open in the browser; a folder link opens in Finder; a file link is only
    /// shown in Finder, never opened (the link comes from an agent's output, and opening a file can run it). Other
    /// schemes are ignored.
    @MainActor static func open(_ url: URL) {
        switch url.scheme?.lowercased() {
        case "http", "https": NSWorkspace.shared.open(url)
        case "file":
            // A plain folder opens in Finder (nothing runs). A package is a folder too, but opening an app launches it:
            // it, a file, and anything a link points through are only shown there.
            let real = url.resolvingSymlinksInPath()
            var isFolder: ObjCBool = false
            if FileManager.default.fileExists(atPath: real.path, isDirectory: &isFolder), isFolder.boolValue,
               !NSWorkspace.shared.isFilePackage(atPath: real.path) {
                NSWorkspace.shared.open(real)
            } else {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
        default: break
        }
    }
}

/// The window's top strip (the page's band, which holds no controls): drag to move the window; a double click does
/// what the user chose in System Settings (zoom, minimize or nothing), as on a titlebar.
final class DragStrip: NSView {
    static let height: CGFloat = 30

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
            return
        }
        window.performDrag(with: event)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// A menu bar app has no Edit menu, so ⌘C / ⌘V / ⌘X / ⌘A / ⌘Z never reach the page on their own: send them here.
final class TerminalWebView: WKWebView {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command, let key = event.charactersIgnoringModifiers else {
            return super.performKeyEquivalent(with: event)
        }
        // The page's own shortcuts: ⌘W closes the terminal on screen (not the window), ⌘T opens a new one, ⌘B hides or
        // shows the list, ⌘1–9 switch.
        if key == "w" || key == "t" || key == "b" || (key.count == 1 && ("1"..."9").contains(key)) {
            evaluateJavaScript("window.agentswitch?.shortcut(\"\(key)\")", completionHandler: nil)
            return true
        }
        // ⌘A: the page picks (the terminal's own selection, or the text field in focus).
        if key == "a" {
            evaluateJavaScript("window.agentswitch?.selectAll()", completionHandler: nil)
            return true
        }
        let action: Selector? = switch key {
        case "c": #selector(NSText.copy(_:))
        case "v": #selector(NSText.paste(_:))
        case "x": #selector(NSText.cut(_:))
        case "z": Selector(("undo:"))
        default: nil
        }
        if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        return super.performKeyEquivalent(with: event)
    }
}
