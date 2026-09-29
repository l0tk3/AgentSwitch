import AgentSwitchMacCore
import AppKit
import SwiftUI
import WebKit

/// The terminal window (docs/terminal-v0.md §1, Mac): AgentSwitch's own terminals — list, live screen, permission
/// requests, sealed replies, full keyboard. v0 shows the daemon's terminal page in a web view signed in through a
/// one-time console link, in a data store of its own (the page's remembered choices survive; the session cookie is
/// only good until the daemon restarts); a native
/// SwiftTerm view comes later. One dark surface: a native toolbar (52 pt, the traffic lights centred in it) over the
/// page, in the page's black — the list's button, the terminal on screen as the title, new terminal and all the
/// terminals' mark (docs/design/visual-v1/terminal.html); the page says what they show and does what they ask.
/// Closing the window leaves the terminals running: the daemon holds them.
@MainActor
final class TerminalWindowController: NSObject, WKNavigationDelegate, NSToolbarDelegate {
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
    /// What the toolbar shows, as the page reports it.
    let head = TerminalHead()

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
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "terminal"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = Self.background
        let toolbar = NSToolbar(identifier: "AgentSwitchTerminal")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        toolbar.centeredItemIdentifiers = [.terminalTitle]
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        window.contentView = web
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

    private var webView: TerminalWebView? { window?.contentView as? TerminalWebView }

    // MARK: toolbar

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.terminalList, .flexibleSpace, .terminalTitle, .flexibleSpace, .terminalNew, .terminalMark]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(toolbar) }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: id)
        switch id {
        case .terminalList:
            item.image = PixelImage.template(PixelArt.toolbarList)
            item.label = "list"
            item.toolTip = "list ⌘B"
            item.action = #selector(toggleList)
        case .terminalNew:
            item.image = PixelImage.template(PixelArt.toolbarNew)
            item.label = "new"
            item.toolTip = "new terminal ⌘T"
            item.action = #selector(newTerminal)
        case .terminalTitle:
            item.view = NSHostingView(rootView: TerminalTitleView(head: head))
            item.label = "terminal"
        case .terminalMark:
            item.view = NSHostingView(rootView: TerminalMarkView(head: head))
            item.label = "status"
        default:
            return nil
        }
        item.target = self
        return item
    }

    @objc private func toggleList() { webView?.evaluateJavaScript("window.agentswitch?.toggleList()", completionHandler: nil) }
    @objc private func newTerminal() { webView?.evaluateJavaScript("window.agentswitch?.newTerminal()", completionHandler: nil) }

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
        default:
            break
        }
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
        case "head", "mark", "screen":
            MainActor.assumeIsolated { owner?.pageSaid(body) }
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

/// A menu bar app has no Edit menu, so ⌘C / ⌘V / ⌘X / ⌘A / ⌘Z never reach the page on their own: send them here.
final class TerminalWebView: WKWebView {
    /// The terminal's screen in the page (its coordinates, top left origin), while one is shown; its line height.
    var screenRect: CGRect?
    var cellHeight: CGFloat = 16
    private var notches = WheelNotches()

    /// WebKit gives the page no scroll events in this window (a titled one; a borderless one does get them), so over
    /// the terminal the wheel is taken here and handed to the page as notches — the page sends them to a program that
    /// scrolls itself or scrolls its own history (docs/terminal-v0.md). Elsewhere (the list) it scrolls as usual.
    override func scrollWheel(with event: NSEvent) {
        let local = convert(event.locationInWindow, from: nil)
        let point = CGPoint(x: local.x, y: isFlipped ? local.y : bounds.height - local.y)
        guard let screen = screenRect, screen.contains(point) else { return super.scrollWheel(with: event) }
        let n = notches.add(deltaY: Double(event.scrollingDeltaY), precise: event.hasPreciseScrollingDeltas,
                            began: event.phase == .began, lineHeight: Double(cellHeight))
        if n != 0 { evaluateJavaScript("window.agentswitch?.wheel(\(n))", completionHandler: nil) }
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

extension NSToolbarItem.Identifier {
    static let terminalList = NSToolbarItem.Identifier("terminal.list")
    static let terminalTitle = NSToolbarItem.Identifier("terminal.title")
    static let terminalNew = NSToolbarItem.Identifier("terminal.new")
    static let terminalMark = NSToolbarItem.Identifier("terminal.mark")
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
        .frame(maxWidth: 420)
    }
}

/// All the terminals' state at the toolbar's end: the word (`1 waiting`, `busy`) and the app's mark.
private struct TerminalMarkView: View {
    let head: TerminalHead

    var body: some View {
        HStack(spacing: 8) {
            if !head.tag.isEmpty { Text(head.tag).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary) }
            PixelMarkView(state: head.mark, pixel: 2, depth: true)
        }
        .padding(.horizontal, 4)
    }
}

/// A pixel sprite as a template image (the toolbar tints it; 1 pt cells stay whole pixels on any screen).
enum PixelImage {
    static func template(_ rows: [String], cell: CGFloat = 1) -> NSImage {
        let size = NSSize(width: CGFloat(rows.first?.count ?? 0) * cell, height: CGFloat(rows.count) * cell)
        let image = NSImage(size: size, flipped: true) { _ in
            NSColor.black.setFill()
            for p in PixelArt.sprite(rows) { NSRect(x: CGFloat(p.x) * cell, y: CGFloat(p.y) * cell, width: cell, height: cell).fill() }
            return true
        }
        image.isTemplate = true
        return image
    }
}
