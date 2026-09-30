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
    /// The native screen under the page (docs/terminal-v0.md §1 Mac).
    private var screen: TerminalScreenController?
    /// The terminal on screen in this window while it is the one in use: its turns need no telling (the Live Activity).
    var watching: String? { window?.isKeyWindow == true && window?.isVisible == true ? screen?.shown : nil }

    #if DEBUG
    /// TerminalProbe: the window opens behind the others and the app is not made active.
    static var probing = false
    var probeScreen: TerminalScreenController? { screen }
    var probeWeb: TerminalWebView? { webView }
    #endif

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
        // The page leaves the screen to the native view (terminal.js NATIVE).
        config.userContentController.addUserScript(WKUserScript(source: "window.agentswitchNativeScreen = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let web = TerminalWebView(frame: NSRect(origin: .zero, size: Self.contentSize), configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = Self.background

        // No toolbar (2026-09-30, user: 顶栏太宽了，像 iTerm 一样紧凑): the content runs under the title bar and the
        // bar's items sit in its one row beside the traffic lights, 32 pt instead of the unified toolbar's 66.
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: Self.contentSize),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "terminal"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = Self.background
        let model = self.model
        let screen = TerminalScreenController(client: { model.client })
        screen.evaluate = { [weak web] js in web?.evaluateJavaScript(js, completionHandler: nil) }
        self.screen = screen
        let stage = TerminalStage(web: web, screen: screen.view)
        let host = NSHostingController(rootView: TerminalWindowRoot(stage: stage, head: head,
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
            keyObservers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak web, weak screen] _ in
                MainActor.assumeIsolated {
                    web?.evaluateJavaScript("window.agentswitch?.active(\(on))", completionHandler: nil)
                    // Brought to the front: the size is this window's (another screen may have had it).
                    if on { screen?.userActed() }
                }
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
        #if DEBUG
        if Self.probing { window.orderBack(nil); return }
        #endif
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: toolbar

    /// The page's report: the terminal on screen, all the terminals' mark, where its screen is and what floats over it
    /// (the native screen), a line to show under the output, the keyboard to the screen.
    fileprivate func pageSaid(_ body: [String: Any]) {
        switch body["type"] as? String {
        case "head":
            head.name = body["name"] as? String ?? ""
            head.status = body["status"] as? String
        case "mark":
            head.mark = PixelArt.MarkState(page: body["state"] as? String)
            head.tag = body["tag"] as? String ?? ""
        case "screen":
            let rect = Self.rect(body["rect"])
            webView?.screenRect = rect
            screen?.place(Self.rect(body["area"]))
            screen?.show(rect == nil ? nil : body["id"] as? String)
            windowLog.debug("screen \(String(describing: rect), privacy: .public) id \(String(describing: body["id"]), privacy: .public)")
        case "overlays":
            webView?.overlays = (body["rects"] as? [Any] ?? []).compactMap(Self.rect)
        case "focus":
            screen?.focus()
        case "note":
            if let text = body["text"] as? String { screen?.note(text) }
        case "claim":
            // The placeholder clicked: the size is this window's again.
            screen?.claim()
        default:
            break
        }
    }

    /// `[x, y, width, height]` from the page.
    private static func rect(_ value: Any?) -> CGRect? {
        guard let r = value as? [Double], r.count == 4 else { return nil }
        return CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
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
        screen?.stop()
        screen = nil
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
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 160),
                                      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = background
        let host = NSHostingController(rootView: TerminalWindowRoot(stage: TerminalStage(web: web, screen: nil), head: head, toggleList: {}, newTerminal: {}))
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
            if let text = body["url"] as? String, let url = URL(string: text) { MainActor.assumeIsolated { LinkOpener.open(url) } }
        case "signIn":
            MainActor.assumeIsolated { owner?.signIn() }
        case "head", "mark", "screen", "overlays", "focus", "note", "claim":
            MainActor.assumeIsolated { owner?.pageSaid(body) }
        case "log":
            windowLog.notice("page: \(body["text"] as? String ?? "", privacy: .public)")
        default:
            break
        }
    }

}

/// A link ⌘-clicked in a terminal, by `LinkPolicy`: a web page in the browser, a folder in Finder, a document in its
/// app (as in iTerm); an app, a script or anything else that could run is only shown in Finder. Other schemes are ignored.
enum LinkOpener {
    #if DEBUG
    /// The probe sees what a click would open, instead of it opening.
    @MainActor static var probeOpened: ((URL) -> Void)?
    #endif

    @MainActor static func open(_ url: URL) {
        #if DEBUG
        if let probeOpened { probeOpened(url); return }
        #endif
        switch LinkPolicy.action(for: url) {
        case .browse(let target), .open(let target): NSWorkspace.shared.open(target)
        case .reveal(let target): NSWorkspace.shared.activateFileViewerSelecting([target])
        case .ignore: break
        }
    }
}

/// The page over the native screen: its own parts (the list, the panels, the bars, what floats over the screen) take
/// the mouse; the screen's area, where the page draws nothing, lets it through to the native view below.
final class TerminalStage: NSView {
    let web: TerminalWebView
    let screen: NSView?

    init(web: TerminalWebView, screen: NSView?) {
        self.web = web
        self.screen = screen
        super.init(frame: NSRect(origin: .zero, size: web.frame.size))
        if let screen { addSubview(screen) }
        addSubview(web)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    /// Top left origin, as the page's coordinates.
    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        web.frame = bounds
    }
}

/// A menu bar app has no Edit menu, so ⌘C / ⌘V / ⌘X / ⌘A / ⌘Z never reach the page on their own: send them here.
final class TerminalWebView: WKWebView {
    /// The terminal's screen in the page (its coordinates, top left origin), while one is shown.
    var screenRect: CGRect?
    /// What floats over it (permission requests, the composer, the loading line, a sheet).
    var overlays: [CGRect] = []

    /// Over the screen and nothing of the page's there: the native screen below takes it (nil lets the stage look
    /// further down).
    override func hitTest(_ point: NSPoint) -> NSView? {
        if let screen = screenRect, let superview {
            let local = convert(point, from: superview)
            let p = CGPoint(x: local.x, y: isFlipped ? local.y : bounds.height - local.y)
            if screen.contains(p), !overlays.contains(where: { $0.contains(p) }) { return nil }
        }
        return super.hitTest(point)
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
    let stage: TerminalStage
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
            StageHost(stage: stage)
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

/// The page and the native screen under it, as they are (the window keeps them; SwiftUI only places them).
private struct StageHost: NSViewRepresentable {
    let stage: TerminalStage
    func makeNSView(context: Context) -> TerminalStage { stage }
    func updateNSView(_ view: TerminalStage, context: Context) {}
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
