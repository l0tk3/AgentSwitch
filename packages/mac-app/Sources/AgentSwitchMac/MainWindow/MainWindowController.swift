import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The main window `AgentSwitch` (docs/dispatch-v0.md §1): one window, its pages — Dispatch (the phone's home on a desk,
/// `DispatchPage`), Terminals (the terminal window as it was, `TerminalsPageController`) and Browser (the shared
/// browser's screen, `BrowserPage`, docs/browser-v0.md §1 Mac) — chosen in the rail on the left (MainRail.swift), under
/// one row of bar that is the page's own (MainBar.swift), over one status bar across the window (MainStatusBar.swift;
/// proposal B, 2026-10-03, docs/design/implemented/window-bars.html). All pages are in
/// the window at once and only one is shown: the terminal page keeps its sign-in and its stream under the others, and
/// nothing of it takes the keyboard, draws or claims a terminal's size until it is shown; the Browser page follows its
/// tab only while it is shown (and polls its list slowly for the bar's mark while the window is visible).
/// A page change goes in at once; one the user makes is then drawn in from the top (PageContainer.swift, the refresh),
/// one the user did not watch (the window was not in use) or under Reduce Motion is not.
/// The window remembers its page and frame; it opens on the page shown last (Dispatch the first time). Closing it leaves
/// the tasks and the terminals running: the daemon holds them. The next window signs in to the terminal page afresh.
@MainActor
final class MainWindowController: NSObject {
    private let model: AppModel
    /// Lives as long as the app; the window's content reads and writes it.
    let state: MainWindowState
    private(set) var window: NSWindow?
    /// Told when the window opens (true) or closes (false), for the Dock icon.
    var onVisibilityChange: (Bool) -> Void = { _ in }
    /// The rail's settings and ⌘,.
    var openSettings: () -> Void = {}
    /// Settings › Nodes (the bar's node menu).
    var openNodes: () -> Void = {}
    /// The node menu's `Open in New Window`: that node's pages in a window of their own (MainWindows).
    var openWindow: (NodeStatus?) -> Void = { _ in }
    /// Another window already on this node (nil: this Mac) comes forward instead: true when there was one. A node is in
    /// one window at most (docs/mesh-v0.md §9 B 2, 2026-10-14).
    var elsewhere: (String?) -> Bool = { _ in false }
    /// Where the window's frame is kept: the main window's own, or the node's for a window opened on it.
    private let frameName: String
    /// Where a window opened on a node goes the first time: beside the window it was opened from.
    private let firstFrame: NSRect?
    /// What `GET /live` last said of this Mac: the rail's marks again once the window is back from another node.
    private var ownLive: LiveSnapshot?
    /// Another node's `GET /live`, asked while the window's pages are that node's.
    private var nodeWatch: Task<Void, Never>?
    /// The terminals in windows of their own (docs/dispatch-v0.md §1 单独的窗口): one of them is not shown here too.
    var windows: TerminalWindows?
    private var terminals: (any TerminalsPage)?
    private var browser: BrowserPageModel?
    private var container: PageContainer?
    private var dispatchHost: NSView?
    /// The window's Files column (docs/files-v0.md), the node's the window is on.
    private var files: FilesColumn?
    private var observers: [NSObjectProtocol] = []
    private var responderObservation: NSKeyValueObservation?
    private var keyMonitor: Any?

    #if DEBUG
    /// TerminalProbe: the window opens behind the others and the app is not made active.
    static var probing = false
    var probeScreen: TerminalScreenController? { terminals?.probeScreen }
    /// A page is being drawn in from the top right now (the probe's page change).
    var probeRefreshing: Bool { container?.refresh.playing ?? false }
    var probeScreens: [Int: TerminalScreenController] { terminals?.probeScreens ?? [:] }
    var probeWeb: TerminalWebView? { terminals?.probeWeb ?? nil }
    /// The native Terminals page's model (nil while the web page is in use).
    var probeTerminals: TerminalsModel? { (terminals as? NativeTerminalsPage)?.model }
    /// The bar's switch, as its button calls it.
    func probeToggleView() { barActions.toggleView() }
    var probeBrowser: BrowserPageModel? { browser }
    var probeHead: TerminalHead? { terminals?.head }
    var probeClient: DaemonClient { model.client(on: state.nodeId) }
    /// The status bar's lock, as a click on it.
    func probeSeal() { barActions.seal() }
    /// The node menu's `Use AgentSwitch On`, as its item calls it.
    func probeUseNode(_ node: NodeStatus?) { barActions.useNode(node) }
    /// The window's Files column, and the bar's icon as its button calls it.
    var probeFiles: FilesColumn? { files }
    func probeToggleFiles() { barActions.toggleFiles() }
    #endif

    static let contentSize = NSSize(width: 1280, height: 820)
    /// Wider than the terminal page's narrow layout (760 pt, terminal.css) beside the rail (44 pt): its list stays on
    /// screen at the smallest size.
    static let minSize = NSSize(width: 850, height: 480)
    static let frameName = "AgentSwitchMain"
    /// Where the terminal window was before there was a main window: the main window opens there the first time.
    static let terminalFrameName = "AgentSwitchTerminal"

    /// `node`: the node the window opens on (a window of its own for it, MainWindows); nil: the main window, on this Mac.
    init(model: AppModel, node: NodeStatus? = nil, frameName: String = MainWindowController.frameName, firstFrame: NSRect? = nil) {
        self.model = model
        self.frameName = frameName
        self.firstFrame = firstFrame
        state = MainWindowState(page: MainPage.restored(UserDefaults.standard.string(forKey: MainPage.storeKey)),
                                railHidden: MainRailLayout.hidden(UserDefaults.standard.object(forKey: MainRailLayout.hiddenKey) as? Bool))
        super.init()
        if let node { state.use(node: node) }
        // The rail put away stays put away the next time (docs/dispatch-v0.md §1 图标栏可以收起).
        state.onRailHidden = { hidden in
            #if DEBUG
            if Self.probing { return }   // a probe's rail is not the user's
            #endif
            UserDefaults.standard.set(hidden, forKey: MainRailLayout.hiddenKey)
        }
    }

    // MARK: opening

    /// The window, on the page it shows (or showed last), or on `page` (the menu's `Open Dispatch` / `Open Terminals`,
    /// ⌘⇧B).
    func show(_ page: MainPage? = nil) {
        let watched = inUse
        open()
        if let page { go(to: page, animated: watched) }
        bringForward()
    }

    /// One terminal on screen (the Live Activity, the probe): the Terminals page switches to it, or opens on it.
    /// `node`: the node it is on (the Live Activity lists other nodes' too: docs/mesh-v0.md §5.2); nil: this Mac.
    func show(terminal id: String, node: String? = nil) {
        // In a window of its own (this Mac's only): that one comes forward.
        if node == nil, windows?.raise(id) == true { return }
        // The window's pages become that node's; a node no longer listed is not gone to.
        if let node, model.nodes.node(node) == nil { return }
        use(node: node.flatMap { model.nodes.node($0) })
        let watched = inUse
        if window == nil { open(terminal: id) } else { terminals?.show(terminal: id) }
        go(to: .terminals, animated: watched)
        bringForward()
    }

    /// One task's page on Dispatch (the Live Activity): the window asks the page to open it (`requestedTask`).
    func show(task id: String, node: String? = nil) {
        if let node, model.nodes.node(node) == nil { return }
        let watched = inUse
        use(node: node.flatMap { model.nodes.node($0) })
        open()
        state.request(task: id)
        go(to: .dispatch, animated: watched)
        bringForward()
    }

    /// A new terminal's panel on the Terminals page (⌘T in a terminal's own window).
    func newTerminal() {
        show(.terminals)
        terminals?.newTerminal()
    }

    /// The terminals out in windows of their own changed: the page leaves them, or may show them again.
    func detachedChanged(_ ids: Set<String>) { terminals?.setDetached(ids) }

    /// The terminals on screen in the window in use (one a pane): the Live Activity says nothing of their turns. Named
    /// among every node's, the window may be on another node.
    var watchingTerminals: Set<String> { Set((terminals?.watching ?? []).map { LiveSnapshot.key($0, on: state.nodeId) }) }

    /// The task whose page is open in the window in use: the Live Activity says nothing of its result.
    var watchingTask: String? {
        guard let window, window.isKeyWindow, window.isVisible, state.page == .dispatch else { return nil }
        return state.openTask.map { LiveSnapshot.key($0, on: state.nodeId) }
    }

    /// What `GET /live` said (the Live Activity's poll): the pages' marks and Dispatch's counts — this Mac's, so not
    /// while the window's pages are another node's.
    func liveChanged(_ snapshot: LiveSnapshot?) {
        ownLive = snapshot
        if state.node == nil { state.liveChanged(snapshot) }
    }

    // MARK: the node

    /// The window's pages become another node's, or this Mac's again (the bar's node menu, the strip's way back;
    /// docs/mesh-v0.md §5.2). Every page is one node's — the terminals' streams, the browser's picture, Dispatch's
    /// record — so they are made anew for it, and drawn in as a page change is.
    func use(node: NodeStatus?) {
        guard node?.id != state.nodeId else { return }
        let watched = inUse
        container?.refresh.cancel()
        terminals?.stop()
        terminals = nil
        browser?.stop()
        browser = nil
        container = nil
        dispatchHost = nil
        files?.stop()
        files = nil
        state.use(node: node)
        watchNode()
        guard let window else { return }
        let frame = window.frame
        build(in: window, terminal: nil)
        window.setFrame(frame, display: true)
        // What the other node has is not known yet (its Clash page comes once it has said): from Clash, the window
        // opens on that node's terminals.
        let page = state.pages.contains(state.page) ? state.page : .terminals
        swap(to: page)
        windowChanged()
        updateTitle()
        if watched, ScanRefresh.playsNow {
            container?.drawIn(page)
            if page == .terminals { terminals?.pageDrawsIn() }
        }
    }

    /// While the pages are another node's: what goes on there for the rail's marks, asked of that node; and its line in
    /// this Mac's list of nodes kept fresh (the strip says how it is reached, or that it stopped answering).
    private func watchNode() {
        if nodeWatch != nil { model.nodes.watched -= 1 }
        nodeWatch?.cancel()
        nodeWatch = nil
        guard let id = state.nodeId, window != nil else {
            if state.node == nil { state.liveChanged(ownLive) }
            return
        }
        model.nodes.watched += 1
        nodeWatch = Task { [weak self] in
            // What the node has (its Clash page is offered only when it says so): asked until it has answered.
            var asked = false
            while !Task.isCancelled {
                guard let self else { return }
                if !asked, let info = try? await self.model.client(on: id).nodeInfo() {
                    guard !Task.isCancelled, self.state.nodeId == id else { return }
                    asked = true
                    self.state.nodeSaid(info)
                }
                let snapshot = try? await self.model.client(on: id).live()
                guard !Task.isCancelled, self.state.nodeId == id else { return }
                self.state.liveChanged(snapshot)
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// The window is in front of the user: a page change there is one they see.
    private var inUse: Bool {
        guard let window else { return false }
        return NSApp.isActive && window.isKeyWindow && window.isVisible && !window.isMiniaturized
    }

    /// The window open and in front, on the page it shows (another window was asked for this node).
    func raise() {
        open()
        bringForward()
    }

    private func bringForward() {
        guard let window else { return }
        // What the window's notifications will say anyway, at once (the Browser page starts following its tab).
        defer { windowChanged() }
        #if DEBUG
        if Self.probing { window.orderBack(nil); return }
        #endif
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: the window

    private func open(terminal id: String? = nil) {
        guard window == nil else { return }
        // No toolbar (2026-09-30, user: 顶栏太宽了，像 iTerm 一样紧凑): the content runs under the title bar and the
        // bar's items sit in its one row beside the traffic lights, 32 pt instead of the unified toolbar's 66.
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: Self.contentSize),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "AgentSwitch"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        build(in: window, terminal: id)
        window.setContentSize(Self.contentSize)
        // The title bar's height and where the traffic lights end, for the bar drawn in that row.
        state.barHeight = max(28, window.frame.height - window.contentLayoutRect.height)
        state.lightsStart = window.standardWindowButton(.closeButton)?.frame.minX ?? 20
        state.lightsEnd = window.standardWindowButton(.zoomButton)?.frame.maxX ?? 70
        window.minSize = Self.minSize
        // `minSize` alone does not hold: with a SwiftUI controller as the window's content it reads back as zero a
        // moment later (measured in the probe, 2026-10-07), which is how the window could be dragged down to nothing.
        // The delegate holds a drag at the least size whatever the window thinks its own is.
        window.delegate = leastSize
        window.isReleasedWhenClosed = false
        if !window.setFrameUsingName(frameName) {
            if let firstFrame { window.setFrame(firstFrame, display: false) }
            else if !window.setFrameUsingName(Self.terminalFrameName) { window.center() }
        }
        window.setFrameAutosaveName(frameName)
        self.window = window
        observe(window)
        watchKeys()
        // A window closed on another node opens on it again: its marks are asked of it.
        watchNode()
        swap(to: state.pages.contains(state.page) ? state.page : .terminals)
        onVisibilityChange(true)
    }

    /// The window's pages, for the node the window is on (this Mac, or another node through this Mac's service:
    /// docs/mesh-v0.md §5.2), as the window's content. `id`: the terminal the Terminals page opens on.
    private func build(in window: NSWindow, terminal id: String?) {
        let node = state.nodeId
        // The Terminals page is native (2026-10-05); the daemon's page in a web view stays behind a hidden default for now.
        let terminals: any TerminalsPage = node == nil && UserDefaults.standard.bool(forKey: "terminalsPageWeb")
            ? TerminalsPageController(model: model, size: Self.contentSize) : NativeTerminalsPage(model: model, node: node)
        terminals.window = window
        terminals.onTitle = { [weak self] in self?.updateTitle() }
        // Windows of their own are this Mac's terminals': another node's stay in this window.
        terminals.setDetached(node == nil ? windows?.ids ?? [] : [])
        terminals.onDetach = { [weak self] id in if node == nil { self?.windows?.show(id) } }
        terminals.onRaise = { [weak self] id in if node == nil { _ = self?.windows?.raise(id) } }
        // Taken back: its window closes (the page hears it is no longer out), then it is shown here.
        terminals.onAttach = { [weak self] id in
            self?.windows?.close(id)
            self?.terminals?.show(terminal: id)
        }
        let dispatch = NSHostingView(rootView: DispatchRoot(model: model, state: state))
        // Fill Ciphertext's `New…` seals with this Mac's gate, for this Mac's gate: not on another node's browser.
        let ownSealer: BrowserSealer = { [model] request in try await model.gateCLI.seal(request) }
        let sealer: BrowserSealer? = node == nil ? ownSealer : nil
        let kept: UserDefaults? = node == nil ? .standard : nil
        let browser = BrowserPageModel(service: { [model] in model.client(on: node) }, state: state, defaults: kept, sealer: sealer)
        if node != nil {
            browser.streamOnly = true
            browser.screenID = TerminalSizeHolder.screen(onNodeAs: model.client(on: node).screenOwner, unique: "main")
        }
        browser.onTitle = { [weak self] in self?.updateTitle() }
        browser.activateBrowser = { [model] in
            guard node == nil else { return }
            model.browserFront.asked()
            // The browser on the page: the shared one, or the profile's own that was chosen (docs/profiles-v0.md §5.2).
            BrowserFront.activate(agentswitchHome: model.paths.agentswitchHome, browser: browser.browserKey)
        }
        let container = PageContainer(pages: [.dispatch: dispatch, .terminals: terminals.pageView, .browser: BrowserPage.host(browser),
                                              .clash: NSHostingView(rootView: ClashPage(state: state).environment(model))])
        // The Files column (docs/files-v0.md): the node's own files, remembered by node.
        let files = FilesColumn(node: node, nodeName: state.node?.name ?? "这台 Mac", client: { [model] in model.client(on: node) }, defaults: Self.filesDefaults)
        files.target = { [weak self] in self?.filesTarget() }
        files.paneFolder = { [weak self] in self?.terminals?.paneFolder }
        files.newTerminal = { [weak self] folder in
            self?.switchPage(to: .terminals)
            self?.terminals?.newTerminal(in: folder)
        }
        files.focusPage = { [weak self] in self?.focusPage() }
        terminals.files = files
        self.files?.stop()
        self.files = files
        let host = NSHostingController(rootView: MainWindowRoot(state: state, head: terminals.head, model: model,
                                                                content: container, actions: barActions, browser: browser, files: files))
        host.sizingOptions = []
        window.contentViewController = host
        self.terminals = terminals
        self.browser = browser
        self.container = container
        dispatchHost = dispatch
        // The terminal screen's own refresh (another terminal) gives way to the page's, drawn in over it.
        terminals.pageRefreshing = { [weak container] in container?.refresh.playing ?? false }
        followRecord()
        // Signed in before it is shown: a window opened on Dispatch has its terminals ready behind it.
        terminals.load(terminal: id)
    }

    private func observe(_ window: NSWindow) {
        let center = NotificationCenter.default
        // Dragging stops at the least size by itself; a size set from outside (a window manager, the system's tiling)
        // does not, and the pages are not laid out for less — they ran over each other (2026-10-07, user: 缩小到极限之后
        // 再往后排版就全乱了，建议加一个缩小的限制). So a frame that ends up smaller is put back to the least size.
        observers.append(center.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.keepLeastSize() }
        })
        observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.closed() }
        })
        for (name, key) in [(NSWindow.didBecomeKeyNotification, true), (NSWindow.didResignKeyNotification, false)] {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.terminals?.windowKeyChanged(key)
                    self?.windowChanged()
                }
            })
        }
        // Full screen: the system's traffic lights go as it starts and come back once it has ended; the bar's own stand in
        // their place meanwhile (2026-10-03, user: 全屏做的有点智障了，红绿灯直接常驻这里不就好了).
        for (name, full) in [(NSWindow.willEnterFullScreenNotification, true), (NSWindow.didExitFullScreenNotification, false)] {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.state.fullScreen = full }
            })
        }
        for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification] {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.windowChanged() }
            })
        }
        // Text being typed: an editable text view or a field's editor has the keyboard (a selectable text does not).
        responderObservation = window.observe(\.firstResponder, options: [.initial, .new]) { [weak self] window, _ in
            MainActor.assumeIsolated {
                self?.state.editingChanged((window.firstResponder as? NSText)?.isEditable == true)
            }
        }
    }

    private let leastSize = LeastSize(MainWindowController.minSize)

    /// A window's drag stopped at its least size.
    private final class LeastSize: NSObject, NSWindowDelegate {
        let size: NSSize
        init(_ size: NSSize) { self.size = size }

        func windowWillResize(_ sender: NSWindow, to frameSize: NSSize) -> NSSize {
            NSSize(width: max(frameSize.width, size.width), height: max(frameSize.height, size.height))
        }
    }

    /// The window's frame brought back up to its least size, its top left where it was.
    private func keepLeastSize() {
        guard let window, !window.styleMask.contains(.fullScreen), !window.inLiveResize else { return }
        let frame = window.frame
        let size = NSSize(width: max(frame.width, Self.minSize.width), height: max(frame.height, Self.minSize.height))
        guard size != frame.size else { return }
        window.setFrame(NSRect(x: frame.minX, y: frame.maxY - size.height, width: size.width, height: size.height), display: true)
    }

    private func windowChanged() {
        guard let window else { return state.windowChanged(key: false, visible: false) }
        var visible = window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
        #if DEBUG
        if Self.probing { visible = true }   // behind every other window on purpose
        #endif
        state.windowChanged(key: window.isKeyWindow, visible: visible)
        terminals?.windowVisible(state.windowVisible)
        browser?.setActive(shown: state.page == .browser, visible: state.windowVisible)
        files?.setActive(state.windowVisible)
    }

    // MARK: the Files column

    /// What the column remembers is the user's; a probe's remembers nothing.
    private static var filesDefaults: UserDefaults? {
        #if DEBUG
        if probing { return nil }
        #endif
        return .standard
    }

    /// The bar's folder icon, ⇧⌘F: the column at the folder of the pane in focus on Terminals (where it was on the
    /// other pages), or closed when it shows that already.
    private func toggleFiles() {
        files?.toggle(at: state.page == .terminals ? terminals?.paneFolder : nil)
    }

    /// Where `Add to Reply` lands (docs/files-v0.md §4): the pane in focus on Terminals; Dispatch's input (its files are
    /// read from this Mac's disk: this Mac's own pages only, and no folder); nothing on Browser and Clash.
    private func filesTarget() -> FilesTarget? {
        switch state.page {
        case .terminals:
            return terminals?.filesTarget()
        case .dispatch:
            guard state.node == nil else { return nil }
            return FilesTarget(name: "Dispatch") { [weak self] picks in
                self?.state.give(files: picks.filter { !$0.folder }.map { URL(fileURLWithPath: $0.path) })
            }
        case .browser, .clash:
            return nil
        }
    }

    /// esc in the column beside the page: the keyboard back to the page.
    private func focusPage() {
        if state.page == .terminals { terminals?.focus() } else { window?.makeFirstResponder(nil) }
    }

    /// Mission Control and the Window menu: the terminal on screen on Terminals (the page names it), the tab on screen
    /// on Browser, else the app.
    private func updateTitle() {
        let page: String? = switch state.page {
        case .terminals: terminals?.title
        case .browser: browser?.current.map(BrowserTabText.title)
        case .dispatch, .clash: nil
        }
        let title = page.flatMap { $0.isEmpty ? nil : $0 } ?? "AgentSwitch"
        // Another node's pages: its name too, for the Dock's list of windows and Mission Control.
        window?.title = state.node.map { "\(title) — \($0.name)" } ?? title
    }

    /// Next time the window opens afresh (the daemon may have restarted and forgotten the terminal page's session).
    private func closed() {
        container?.refresh.cancel()
        files?.stop()
        files = nil
        state.windowClosed()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        responderObservation = nil
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        if nodeWatch != nil { model.nodes.watched -= 1 }
        nodeWatch?.cancel()
        nodeWatch = nil
        terminals?.stop()
        terminals = nil
        browser?.stop()
        browser = nil
        container = nil
        dispatchHost = nil
        window = nil
        onVisibilityChange(false)
    }

    // MARK: pages

    /// The user changes pages (the rail, ⌘0, ⌘⇧B, ⌃⇥, ⌘1–9 or ⌘T from Dispatch, ⌘N from another page): drawn in.
    func switchPage(to page: MainPage) { go(to: page, animated: true) }

    /// The rail: another page; the current Dispatch on a task's page goes back (as the bar's word did).
    private func clicked(_ page: MainPage) {
        guard page != state.page else {
            if page == .dispatch, state.showsBack { state.requestBack() }
            return
        }
        switchPage(to: page)
    }

    /// The page goes in at once, then is drawn in from the top; a refresh under way gives way to it (nothing of it
    /// left). The page already on screen: nothing (a refresh drawing it in plays on). In the classic look and under
    /// Reduce Motion the page goes in and that is all (`ScanRefresh.plays`).
    private func go(to page: MainPage, animated: Bool) {
        // A page the node on screen does not have (Clash on another node): not gone to.
        guard page != state.page, state.pages.contains(page) else { return }
        container?.refresh.cancel()
        swap(to: page)
        guard animated, ScanRefresh.playsNow else { return }
        container?.drawIn(page)
        if page == .terminals { terminals?.pageDrawsIn() }
    }

    /// The page goes in: shown, its look on the window, the keyboard to it, remembered.
    private func swap(to page: MainPage) {
        state.show(page)
        UserDefaults.standard.set(page.rawValue, forKey: MainPage.storeKey)
        guard let window, let container else { return }
        Self.dress(window, for: page, record: terminals?.head.light ?? false)
        container.show(page)
        terminals?.onScreen = page == .terminals
        browser?.setActive(shown: page == .browser, visible: state.windowVisible)
        // The keyboard off the hidden pages: to the Dispatch page (its input takes it on `focusRequests`), to the
        // browser's screen.
        switch page {
        case .dispatch:
            if let dispatchHost, !window.makeFirstResponder(dispatchHost) { window.makeFirstResponder(nil) }
        case .browser:
            if let browser, !window.makeFirstResponder(browser.screen) { window.makeFirstResponder(nil) }
        case .terminals:
            break
        case .clash:
            window.makeFirstResponder(nil)
        }
        updateTitle()
    }

    /// Terminals is the terminal window's dark block (ui-v0 §3b), Browser the screen's dark ground; Dispatch takes the
    /// system's light or dark (`system`: the design preview's choice instead).
    /// The window dressed again whenever the pane in focus changes between a terminal and its record: dark for the one,
    /// the system's light or dark for the other.
    private func followRecord() {
        withObservationTracking { _ = terminals?.head.light } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, let window = self.window, self.terminals != nil else { return }
                if self.state.page == .terminals { Self.dress(window, for: .terminals, record: self.terminals?.head.light ?? false) }
                self.followRecord()
            }
        }
    }

    static func dress(_ window: NSWindow, for page: MainPage, system: NSAppearance? = nil, record: Bool = false) {
        // A terminal's record in the pane in focus (the simple view, docs/simple-view-v0.md §5.2): the system's light or
        // dark, the whole window with it — the list, the bars, the rail.
        let follows = page == .terminals && record
        window.appearance = page.alwaysDark && !follows ? NSAppearance(named: .darkAqua) : system
        window.backgroundColor = follows ? .dispatchGround : page.ground
    }

    private var barActions: MainBarActions {
        MainBarActions(
            switchPage: { [weak self] page in self?.clicked(page) },
            back: { [weak self] in self?.state.requestBack() },
            toggleList: { [weak self] in
                guard let self else { return }
                if self.state.page == .browser { self.browser?.toggleList() } else { self.terminals?.toggleList() }
            },
            newTerminal: { [weak self] in self?.terminals?.newTerminal() },
            newTab: { [weak self] in self?.browser?.composeNew() },
            settings: { [weak self] in self?.openSettings() },
            seal: { [weak self] in self?.terminals?.seal() },
            split: { [weak self] side in self?.terminals?.split(side) },
            detach: { [weak self] in self?.terminals?.detachShown() },
            toggleView: { [weak self] in self?.terminals?.toggleView() },
            openInEditor: { [weak self] in self?.terminals?.openInEditor() },
            openYazi: { [weak self] in self?.terminals?.openYazi() },
            closeWindow: { [weak self] in self?.window?.performClose(nil) },
            exitFullScreen: { [weak self] in self?.window?.toggleFullScreen(nil) },
            useNode: { [weak self] node in
                guard let self, !self.elsewhere(node?.id) else { return }
                self.use(node: node)
            },
            openWindow: { [weak self] node in self?.openWindow(node) },
            openNodes: { [weak self] in self?.openNodes() },
            toggleFiles: { [weak self] in self?.toggleFiles() })
    }

    // MARK: keys

    /// The window's own keys (MainShortcut), taken before the page in focus sees them; on Dispatch the edit keys too, and
    /// on Browser while its address is edited (the screen itself sends ⌘V as typing, ⌘A ⌘Z to the page).
    private func watchKeys() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            nonisolated(unsafe) let key = event
            let taken = MainActor.assumeIsolated { self?.handle(key) ?? false }
            return taken ? nil : event
        }
    }

    private func handle(_ event: NSEvent) -> Bool {
        guard let window, let target = event.window else { return false }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let press = MainShortcut.Press(key: event.charactersIgnoringModifiers?.lowercased() ?? "", keyCode: event.keyCode,
                                       command: flags.contains(.command), control: flags.contains(.control),
                                       option: flags.contains(.option), shift: flags.contains(.shift))
        // A sheet on the window (New Ciphertext, a file's source, Rename Topic, a folder to choose): the edit keys only,
        // as the settings window does.
        if target !== window { return target.sheetParent === window && edit(press, in: target) }
        guard window.attachedSheet == nil else { return false }
        let composing = (window.firstResponder as? NSTextInputClient)?.hasMarkedText() ?? false
        if let action = MainShortcut.action(for: press, on: state.page, canGoBack: state.showsBack, composing: composing) {
            perform(action)
            return true
        }
        return (state.dispatchShown || (state.page == .browser && state.editingText)) && edit(press, in: window)
    }

    private func perform(_ action: MainShortcut) {
        switch action {
        case .page(let page):
            switchPage(to: page)
        case .nextPage:
            switchPage(to: state.page.next)
        case .previousPage:
            switchPage(to: state.page.previous)
        case .terminal(let n):
            switchPage(to: .terminals)
            terminals?.shortcut(String(n))
        case .newTask:
            switchPage(to: .dispatch)
            state.requestFocus()
        case .newTerminal:
            switchPage(to: .terminals)
            terminals?.newTerminal()
        case .back:
            state.requestBack()
        case .settings:
            openSettings()
        case .toggleRail:
            state.toggleRail()
        case .files:
            toggleFiles()
        case .browser(let key):
            guard let browser else { return }
            switch key {
            case .newTab: browser.composeNew()
            case .address: browser.focusAddress()
            case .reload: Task { await browser.history(.reload) }
            case .back: Task { await browser.history(.back) }
            case .forward: Task { await browser.history(.forward) }
            case .toggleList: browser.toggleList()
            case .hold: Task { await browser.hold() }
            case .zoomIn: browser.zoomIn()
            case .zoomOut: browser.zoomOut()
            }
        }
    }

    /// ⌘C ⌘V ⌘X ⌘A ⌘Z ⇧⌘Z on Dispatch and in the window's sheets, to the field in focus: a menu bar app has no Edit
    /// menu to send them (the terminal page has its own, TerminalWebView).
    private func edit(_ press: MainShortcut.Press, in target: NSWindow) -> Bool {
        guard press.command, !press.control, !press.option else { return false }
        let action: Selector? = switch (press.key, press.shift) {
        case ("c", false): #selector(NSText.copy(_:))
        case ("v", false): #selector(NSText.paste(_:))
        case ("x", false): #selector(NSText.cut(_:))
        case ("a", false): #selector(NSText.selectAll(_:))
        case ("z", false): Selector(("undo:"))
        case ("z", true): Selector(("redo:"))
        default: nil
        }
        guard let action else { return false }
        return NSApp.sendAction(action, to: nil, from: target)
    }
}

/// The Dispatch page with what it reads: the app's model and the window's state.
struct DispatchRoot: View {
    let model: AppModel
    let state: MainWindowState

    var body: some View {
        DispatchPage()
            .environment(model)
            .environment(state)
            .tint(.brand)
            // Its spinners and clocks stop while another page is shown or the window is not seen (ui-v0 §7.4).
            .followsWindow()
    }
}
