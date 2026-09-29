import AgentSwitchMacCore
import AppKit
import OSLog
import SwiftUI
import WebKit

/// `log show --predicate 'subsystem == "com.agentswitch.mac" && category == "terminal-window"'`
private let windowLog = Logger(subsystem: "com.agentswitch.mac", category: "terminal-window")

/// The terminal window (docs/terminal-v0.md §1, Mac): AgentSwitch's own terminals — list, live screen, permission
/// requests, sealed replies, full keyboard. v0 shows the daemon's terminal page in a web view signed in through a
/// one-time console link, in a data store of its own (the page's remembered choices survive; the session cookie is
/// only good until the daemon restarts); a native
/// SwiftTerm view comes later. One dark surface: the title bar's one row (32 pt, as iTerm's compact tabs) over the
/// page, in the page's black, beside the traffic lights — the list's button, the terminal on screen as the title, new
/// terminal and all the terminals' mark (docs/design/visual-v1/terminal.html); the page says what they show and does
/// what they ask.
/// Closing the window leaves the terminals running: the daemon holds them.
@MainActor
final class TerminalWindowController: NSObject, WKNavigationDelegate {
    private let model: AppModel
    private(set) var window: NSWindow?
    /// Told when the window opens (true) or closes (false), for the Dock icon.
    var onVisibilityChange: (Bool) -> Void = { _ in }
    private var closeObserver: NSObjectProtocol?
    /// The window becoming and ceasing to be the key window, told to the page (the screen in use sets the size).
    private var keyObservers: [NSObjectProtocol] = []
    private var titleObservation: NSKeyValueObservation?
    /// A sign-in link is being fetched: a second click waits for that window instead of making another.
    private var opening = false
    /// When the page last signed in again (at most once every few seconds, so a broken service is not asked in a loop).
    private var lastSignIn = Date.distantPast
    /// What the toolbar shows, as the page reports it.
    let head = TerminalHead()
    private weak var webView: TerminalWebView?

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
        open(page: Self.page)
    }

    /// One terminal on screen (the menu bar's Live Activity card): the open window switches to it, a new one opens on it.
    func show(terminal id: String) {
        if let window, let webView {
            let arg = (try? JSONEncoder().encode(id)).map { String(decoding: $0, as: UTF8.self) } ?? "null"
            webView.evaluateJavaScript("window.agentswitch?.show(\(arg))", completionHandler: nil)
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }
        open(page: "\(Self.page)?id=\(id)")
    }

    private func open(page: String) {
        guard !opening else { return }
        opening = true
        Task {
            defer { opening = false }
            do {
                let link = try await model.client.consoleLink(next: page)
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

        // No toolbar (2026-09-30, user: 顶栏太宽了，像 iTerm 一样紧凑): the content runs under the title bar and the
        // bar's items sit in its one row beside the traffic lights, 32 pt instead of the unified toolbar's 66.
        let window = TerminalNSWindow(contentRect: NSRect(origin: .zero, size: Self.contentSize),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "terminal"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = Self.background
        let host = NSHostingController(rootView: TerminalWindowRoot(web: web, head: head,
                                                                    toggleList: { [weak web] in web?.evaluateJavaScript("window.agentswitch?.toggleList()", completionHandler: nil) },
                                                                    newTerminal: { [weak web] in web?.evaluateJavaScript("window.agentswitch?.newTerminal()", completionHandler: nil) }))
        host.sizingOptions = []
        window.contentViewController = host
        window.setContentSize(Self.contentSize)
        // The title bar's height and where the traffic lights end, for the bar drawn in that row.
        head.barHeight = max(28, window.frame.height - window.contentLayoutRect.height)
        head.lightsEnd = window.standardWindowButton(.zoomButton)?.frame.maxX ?? 70
        webView = web
        for (name, on) in [(NSWindow.didBecomeKeyNotification, true), (NSWindow.didResignKeyNotification, false)] {
            keyObservers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak web] _ in
                MainActor.assumeIsolated { web?.evaluateJavaScript("window.agentswitch?.active(\(on))", completionHandler: nil) }
            })
        }
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

    // MARK: toolbar

    /// The page's report: the terminal on screen, all the terminals' mark, where its screen is (for the wheel).
    fileprivate func pageSaid(_ body: [String: Any]) {
        switch body["type"] as? String {
        case "head":
            head.name = body["name"] as? String ?? ""
            head.status = body["status"] as? String
        case "mark":
            head.mark = PixelArt.MarkState(page: body["state"] as? String)
            head.tag = body["tag"] as? String ?? ""
        case "screen":
            let r = body["rect"] as? [Double]
            webView?.screenRect = r.flatMap { $0.count == 4 ? CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
            if let cell = body["cell"] as? Double, cell > 0 { webView?.cellHeight = cell }
            windowLog.debug("screen \(String(describing: self.webView?.screenRect), privacy: .public) cell \(String(describing: body["cell"]), privacy: .public)")
        default:
            break
        }
    }

    /// Next time the window signs in afresh (the daemon may have restarted and forgotten the session).
    private func closed() {
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        closeObserver = nil
        for observer in keyObservers { NotificationCenter.default.removeObserver(observer) }
        keyObservers = []
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

    #if DEBUG
    /// `-designPreview`: the window's top as it opens — the bar in the title bar's row over a blank page, with a
    /// terminal named and busy — drawn to `file` without going on screen.
    static func previewBar(to file: URL) throws {
        let head = TerminalHead()
        head.name = "本地构建应用和手机连接"
        head.status = "working"
        head.mark = .busy
        head.tag = "busy"
        let web = TerminalWebView(frame: NSRect(origin: .zero, size: contentSize), configuration: WKWebViewConfiguration())
        web.setValue(false, forKey: "drawsBackground")
        let window = TerminalNSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 160),
                                      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = background
        let host = NSHostingController(rootView: TerminalWindowRoot(web: web, head: head, toggleList: {}, newTerminal: {}))
        host.sizingOptions = []
        window.contentViewController = host
        window.setContentSize(NSSize(width: 1000, height: 160))
        head.barHeight = max(28, window.frame.height - window.contentLayoutRect.height)
        head.lightsEnd = window.standardWindowButton(.zoomButton)?.frame.maxX ?? 70
        let frame = window.contentView?.superview ?? window.contentView!
        frame.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        frame.layoutSubtreeIfNeeded()
        guard let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return }
        frame.cacheDisplay(in: frame.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])?.write(to: file)
        window.close()
    }
    #endif

    /// The page loaded: keys go to it, and it learns whether this is the window in use.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let window else { return }
        window.makeFirstResponder(webView)
        webView.evaluateJavaScript("window.agentswitch?.active(\(window.isKeyWindow))", completionHandler: nil)
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
        case "head", "mark", "screen":
            MainActor.assumeIsolated { owner?.pageSaid(body) }
        case "log":
            windowLog.notice("page: \(body["text"] as? String ?? "", privacy: .public)")
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

/// The terminal window: it sees every scroll event first and lets the web view take the ones over the terminal screen
/// (WebKit's own subviews would otherwise get them and give the page nothing).
final class TerminalNSWindow: NSWindow {
    override func sendEvent(_ event: NSEvent) {
        if event.type == .scrollWheel, let web = contentView.flatMap(Self.web(in:)), web.takeWheel(event) { return }
        super.sendEvent(event)
    }

    private static func web(in view: NSView) -> TerminalWebView? {
        if let web = view as? TerminalWebView { return web }
        for sub in view.subviews { if let web = web(in: sub) { return web } }
        return nil
    }
}

/// A menu bar app has no Edit menu, so ⌘C / ⌘V / ⌘X / ⌘A / ⌘Z never reach the page on their own: send them here.
final class TerminalWebView: WKWebView {
    /// The terminal's screen in the page (its coordinates, top left origin), while one is shown; its line height.
    var screenRect: CGRect?
    var cellHeight: CGFloat = 16
    private var notches = WheelNotches()

    /// WebKit gives the page no scroll events in this window (a titled one; a borderless one does get them), so over
    /// the terminal the window hands the wheel here (TerminalNSWindow, before any of WebKit's own views sees it) and it
    /// goes to the page as notches — the page sends them to a program that scrolls itself or scrolls its own history
    /// (docs/terminal-v0.md). Elsewhere (the list) it scrolls as usual. True when taken.
    func takeWheel(_ event: NSEvent) -> Bool {
        let local = convert(event.locationInWindow, from: nil)
        guard bounds.contains(local) else { return false }
        let point = CGPoint(x: local.x, y: isFlipped ? local.y : bounds.height - local.y)
        guard let screen = screenRect, screen.contains(point) else {
            windowLog.debug("wheel at \(point.x, privacy: .public),\(point.y, privacy: .public) outside the screen \(String(describing: self.screenRect), privacy: .public)")
            return false
        }
        let n = notches.add(deltaY: Double(event.scrollingDeltaY), precise: event.hasPreciseScrollingDeltas,
                            began: event.phase == .began, lineHeight: Double(cellHeight))
        windowLog.debug("wheel \(event.scrollingDeltaY, privacy: .public) precise \(event.hasPreciseScrollingDeltas, privacy: .public) → \(n, privacy: .public) notches")
        if n != 0 {
            evaluateJavaScript("window.agentswitch?.wheel(\(n))") { result, error in
                if let error { windowLog.error("wheel to the page failed: \(error.localizedDescription, privacy: .public)") }
            }
        }
        return true
    }

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

/// The window's content: the bar in the title bar's row, then the page. The bar, flat on the window's black as iTerm's
/// compact tabs: the list's button beside the traffic lights, the terminal on screen centred, new terminal and all the
/// terminals' mark at the end; its empty part moves the window and a double click zooms, as a title bar does.
private struct TerminalWindowRoot: View {
    let web: TerminalWebView
    let head: TerminalHead
    let toggleList: () -> Void
    let newTerminal: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                WindowDragArea()
                HStack(spacing: 4) {
                    ToolbarPixelButton(rows: PixelArt.toolbarList, help: "list ⌘B", action: toggleList)
                    Spacer(minLength: 0)
                    ToolbarPixelButton(rows: PixelArt.toolbarNew, help: "new terminal ⌘T", action: newTerminal)
                    TerminalMarkView(head: head)
                }
                .padding(.leading, head.lightsEnd + 10)
                .padding(.trailing, 8)
                TerminalTitleView(head: head).allowsHitTesting(false)
            }
            .frame(height: head.barHeight)
            WebViewHost(web: web)
        }
        .background(Color.black)
        .ignoresSafeArea(.container, edges: .top)
    }
}

/// The bar's empty part: it moves the window, and a double click does what the system's title bars do (zoom, minimise
/// or nothing, System Settings › Desktop & Dock).
private struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ view: NSView, context: Context) {}

    final class DragView: NSView {
        override func mouseDown(with event: NSEvent) {
            guard event.clickCount == 2 else { window?.performDrag(with: event); return }
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window?.performMiniaturize(nil)
            case "None": break
            default: window?.performZoom(nil)
            }
        }
    }
}

/// The page's web view, as it is (the window keeps it; SwiftUI only places it).
private struct WebViewHost: NSViewRepresentable {
    let web: TerminalWebView
    func makeNSView(context: Context) -> TerminalWebView { web }
    func updateNSView(_ view: TerminalWebView, context: Context) {}
}

/// A toolbar button as a pixel icon (1 pt cells) on the black: secondary ink, brighter with a faint square behind it
/// under the pointer, as the demo page's.
private struct ToolbarPixelButton: View {
    let rows: [String]
    let help: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            PixelSprite(rows: rows, pixel: 1, color: hovering ? .primary : .secondary)
                .frame(width: 28, height: 24)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(hovering ? 0.08 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

/// What the toolbar shows, from the page: the terminal on screen (none while one is being made) and all the terminals'
/// state.
@MainActor
@Observable
final class TerminalHead {
    var name = ""
    var status: String?
    var mark: PixelArt.MarkState = .off
    var tag = ""
    /// The title bar's height (the bar fills that row) and where the traffic lights end.
    var barHeight: CGFloat = 32
    var lightsEnd: CGFloat = 70
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

/// The window's title: the terminal on screen with its status mark (the spinner while busy, amber while it waits,
/// hollow once ended).
private struct TerminalTitleView: View {
    let head: TerminalHead

    var body: some View {
        HStack(spacing: 7) {
            if !head.name.isEmpty {
                switch head.status {
                case "working": BrailleSpinner()
                case "waiting": PixelSprite(rows: PixelArt.square, pixel: 2, color: .waiting)
                case "exited": PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .inkDim)
                default: PixelSprite(rows: PixelArt.square, pixel: 2, color: .ok)
                }
                Text(head.name).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.tail)
            }
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: 460)
    }
}

/// All the terminals' state at the toolbar's end: the word (`1 waiting`, `busy`) and the app's mark.
private struct TerminalMarkView: View {
    let head: TerminalHead

    var body: some View {
        HStack(spacing: 8) {
            if !head.tag.isEmpty { Text(head.tag).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary) }
            PixelMarkView(state: head.mark, pixel: 1.5, depth: true)
        }
        .padding(.horizontal, 4)
    }
}
