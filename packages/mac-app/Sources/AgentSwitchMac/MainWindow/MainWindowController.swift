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
    /// The terminals in windows of their own (docs/dispatch-v0.md §1 单独的窗口): one of them is not shown here too.
    var windows: TerminalWindows?
    private var terminals: (any TerminalsPage)?
    private var browser: BrowserPageModel?
    private var container: PageContainer?
    private var dispatchHost: NSView?
    private var observers: [NSObjectProtocol] = []
    private var responderObservation: NSKeyValueObservation?
    private var keyMonitor: Any?

    #if DEBUG
    /// TerminalProbe: the window opens behind the others and the app is not made active.
    static var probing = false
    var probeScreen: TerminalScreenController? { terminals?.probeScreen }
    var probeScreens: [Int: TerminalScreenController] { terminals?.probeScreens ?? [:] }
    var probeWeb: TerminalWebView? { terminals?.probeWeb ?? nil }
    /// The native Terminals page's model (nil while the web page is in use).
    var probeTerminals: TerminalsModel? { (terminals as? NativeTerminalsPage)?.model }
    /// The bar's switch, as its button calls it.
    func probeToggleView() { barActions.toggleView() }
    var probeBrowser: BrowserPageModel? { browser }
    var probeHead: TerminalHead? { terminals?.head }
    var probeClient: DaemonClient { model.client }
    /// The status bar's lock, as a click on it.
    func probeSeal() { barActions.seal() }
    #endif

    static let contentSize = NSSize(width: 1280, height: 820)
    /// Wider than the terminal page's narrow layout (760 pt, terminal.css) beside the rail (44 pt): its list stays on
    /// screen at the smallest size.
    static let minSize = NSSize(width: 850, height: 480)
    static let frameName = "AgentSwitchMain"
    /// Where the terminal window was before there was a main window: the main window opens there the first time.
    static let terminalFrameName = "AgentSwitchTerminal"

    init(model: AppModel) {
        self.model = model
        state = MainWindowState(page: MainPage.restored(UserDefaults.standard.string(forKey: MainPage.storeKey)),
                                railHidden: MainRailLayout.hidden(UserDefaults.standard.object(forKey: MainRailLayout.hiddenKey) as? Bool))
        super.init()
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
    func show(terminal id: String) {
        // In a window of its own: that one comes forward.
        if windows?.raise(id) == true { return }
        let watched = inUse
        if window == nil { open(terminal: id) } else { terminals?.show(terminal: id) }
        go(to: .terminals, animated: watched)
        bringForward()
    }

    /// One task's page on Dispatch (the Live Activity): the window asks the page to open it (`requestedTask`).
    func show(task id: String) {
        let watched = inUse
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

    /// The terminals on screen in the window in use (one a pane): the Live Activity says nothing of their turns.
    var watchingTerminals: Set<String> { terminals?.watching ?? [] }

    /// The task whose page is open in the window in use: the Live Activity says nothing of its result.
    var watchingTask: String? {
        guard let window, window.isKeyWindow, window.isVisible, state.page == .dispatch else { return nil }
        return state.openTask
    }

    /// What `GET /live` said (the Live Activity's poll): the pages' marks and Dispatch's counts.
    func liveChanged(_ snapshot: LiveSnapshot?) { state.liveChanged(snapshot) }

    /// The window is in front of the user: a page change there is one they see.
    private var inUse: Bool {
        guard let window else { return false }
        return NSApp.isActive && window.isKeyWindow && window.isVisible && !window.isMiniaturized
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
        // The Terminals page is native (2026-10-05); the daemon's page in a web view stays behind a hidden default for now.
        let terminals: any TerminalsPage = UserDefaults.standard.bool(forKey: "terminalsPageWeb")
            ? TerminalsPageController(model: model, size: Self.contentSize) : NativeTerminalsPage(model: model)
        terminals.window = window
        terminals.onTitle = { [weak self] in self?.updateTitle() }
        terminals.setDetached(windows?.ids ?? [])
        terminals.onDetach = { [weak self] id in self?.windows?.show(id) }
        terminals.onRaise = { [weak self] id in self?.windows?.raise(id) }
        // Taken back: its window closes (the page hears it is no longer out), then it is shown here.
        terminals.onAttach = { [weak self] id in
            self?.windows?.close(id)
            self?.terminals?.show(terminal: id)
        }
        let dispatch = NSHostingView(rootView: DispatchRoot(model: model, state: state))
        let browser = BrowserPageModel(service: { [model] in model.client }, state: state,
                                       sealer: { [model] request in try await model.gateCLI.seal(request) })
        browser.onTitle = { [weak self] in self?.updateTitle() }
        browser.activateBrowser = { [model] in
            model.browserFront.asked()
            // The browser on the page: the shared one, or the profile's own that was chosen (docs/profiles-v0.md §5.2).
            BrowserFront.activate(agentswitchHome: model.paths.agentswitchHome, browser: browser.browserKey)
        }
        let container = PageContainer(pages: [.dispatch: dispatch, .terminals: terminals.pageView, .browser: BrowserPage.host(browser),
                                              .clash: NSHostingView(rootView: ClashPage(state: state).environment(model))])
        let host = NSHostingController(rootView: MainWindowRoot(state: state, head: terminals.head, model: model,
                                                                content: container, actions: barActions, browser: browser))
        host.sizingOptions = []
        window.contentViewController = host
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
        if !window.setFrameUsingName(Self.frameName), !window.setFrameUsingName(Self.terminalFrameName) { window.center() }
        window.setFrameAutosaveName(Self.frameName)
        self.window = window
        self.terminals = terminals
        self.browser = browser
        self.container = container
        dispatchHost = dispatch
        // The terminal screen's own refresh (another terminal) gives way to the page's, drawn in over it.
        terminals.pageRefreshing = { [weak container] in container?.refresh.playing ?? false }
        observe(window)
        watchKeys()
        followRecord()
        // Signed in before it is shown: a window opened on Dispatch has its terminals ready behind it.
        terminals.load(terminal: id)
        swap(to: state.page)
        onVisibilityChange(true)
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
    }

    /// Mission Control and the Window menu: the terminal on screen on Terminals (the page names it), the tab on screen
    /// on Browser, else the app.
    private func updateTitle() {
        let page: String? = switch state.page {
        case .terminals: terminals?.title
        case .browser: browser?.current.map(BrowserTabText.title)
        case .dispatch, .clash: nil
        }
        window?.title = page.flatMap { $0.isEmpty ? nil : $0 } ?? "AgentSwitch"
    }

    /// Next time the window opens afresh (the daemon may have restarted and forgotten the terminal page's session).
    private func closed() {
        container?.refresh.cancel()
        state.windowClosed()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        responderObservation = nil
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
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
    /// left). The page already on screen: nothing (a refresh drawing it in plays on).
    private func go(to page: MainPage, animated: Bool) {
        guard page != state.page else { return }
        container?.refresh.cancel()
        swap(to: page)
        guard animated, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
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
            closeWindow: { [weak self] in self?.window?.performClose(nil) },
            exitFullScreen: { [weak self] in self?.window?.toggleFullScreen(nil) })
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
