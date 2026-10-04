import AgentSwitchMacCore
import AppKit
import Observation
import OSLog

/// `log show --predicate 'subsystem == "com.agentswitch.mac" && category == "browser"'`
private let browserLog = Logger(subsystem: "com.agentswitch.mac", category: "browser")

/// The main window's Browser page (docs/browser-v0.md §1 Mac): the shared browser's tabs, one on the screen, driven from
/// this Mac. What the page shows and does, apart from the drawing:
///
/// - The tab list, polled (`GET /browser/tabs`; the daemon has no list stream yet) every 2 s while the page is on screen
///   and the window visible, every 6 s while the window is visible on another page (the bar's mark on `Browser`), not
///   at all while the window is hidden or closed. The bar hears its activity and the tab on screen (MainWindowState).
/// - The tab on screen, followed through its stream (frames to the screen view, every change into the list) only while
///   the page is on screen and the window visible.
/// - Input, in order, through one queue (BrowserInputQueue): only to a tab this Mac may drive — its own unheld tabs, or
///   one it holds; an agent's tab is taken over first. Holding a tab sets its size to the screen's and keeps it so as
///   the window changes; handing back lets the daemon put the default back. Another tab on screen, or the window
///   closing, hands back every tab this Mac holds.
/// - 尺寸有主 (2026-10-03, as the phone): your own tab on screen in a visible window is taken quietly while no other
///   screen holds it, so it has the browser area's size; its size is set again every minute while it is shown (the
///   daemon's two idle minutes would give it back). The stream asks for the display's device pixels
///   (BrowserScreenPolicy), again when the window moves to a display of another scale.
/// - The tab list's column (BrowserSide): its width and whether it is open, kept on this Mac; the bar's list button and
///   ⌘B toggle it.
/// - The page's zoom (BrowserPageModel+Zoom.swift): the status bar's `−` `100%` `+`, ⌘− ⌘+; a tab this Mac sizes has
///   the browser area ÷ its site's zoom, remembered on this Mac.
/// - New tabs (the address field, the recent addresses, the Mac's local servers), closing, navigation (a mouse's side
///   buttons too).
/// - Fill Ciphertext (BrowserFillSheet), on your own tabs only: a whole ciphertext, or one sealed here by this Mac's
///   gate, typed into the page's focused input field through the gate; the footer names what was filled and where.
@MainActor
@Observable
final class BrowserPageModel {
    // MARK: what the page shows

    private(set) var list = BrowserTabList.empty
    private(set) var selectedID: String?
    /// The first answer came (until then the page shows nothing rather than the empty state).
    private(set) var loaded = false
    /// Why the list cannot be read (the service is down, has no browser); nil while it can.
    private(set) var problem: String?
    /// A line in the footer for a few seconds: a refusal, a hold that ended, what cannot be done.
    private(set) var note: String?
    /// The screen has a frame of the tab on screen.
    private(set) var hasFrame = false

    /// The new tab box is open.
    var composing = false
    private(set) var opening = false
    /// Why the last address did not open (the daemon's words).
    private(set) var openError: String?
    private(set) var servers: [BrowserLocalServer] = []
    private(set) var serversLoading = false
    private(set) var serversNote: String?
    private(set) var recents: [String]
    /// Asks the address bar to take the keyboard (⌘L).
    private(set) var addressRequests = 0
    /// Fill Ciphertext's sheet is open, for this tab.
    var fillTarget: BrowserFillTarget?
    /// A fill, or the seal before it, is under way.
    private(set) var filling = false
    /// The tab list's column: its width and whether it is open, kept on this Mac (`browser.side`).
    var side: BrowserSide {
        didSet { if side != oldValue { defaults?.set(side.stored, forKey: BrowserSide.storeKey) } }
    }
    /// Each site's zoom, kept on this Mac (`browser.zoom`), and the steps the browser area can use now; what they make
    /// of the tab on screen is BrowserPageModel+Zoom.swift.
    var zoomMemory: BrowserZoomMemory {
        didSet { if zoomMemory != oldValue { defaults?.set(zoomMemory.stored, forKey: BrowserZoomMemory.storeKey) } }
    }
    private(set) var zoomSteps: [Int]

    var current: BrowserTab? { list.tab(selectedID) }
    var screenID: String { BrowserDefaults.screen }

    /// This Mac holds the tab on screen.
    var holding: Bool { current.map { BrowserTabText.holder($0, screen: screenID) == .thisMac } ?? false }

    /// The tab on screen takes input from this Mac now.
    var canDrive: Bool {
        guard let tab = current else { return false }
        switch BrowserTabText.holder(tab, screen: screenID) {
        case .thisMac: return true
        case .elsewhere: return false
        case nil: return tab.owner.kind == .you
        }
    }

    /// `[ Fill Ciphertext ]` is offered: this Mac drives the tab on screen, one of your own, on an http(s) page (an
    /// agent's tab never: the daemon refuses it even while held, as the agent sees the page after the hand-back).
    var canFill: Bool { canDrive && current.map(BrowserFillText.offered(on:)) ?? false }
    /// `New…` in Fill Ciphertext: this Mac's gate seals here.
    var canSeal: Bool { sealer != nil }

    // MARK: plumbing

    @ObservationIgnored let screen = BrowserScreenView(frame: NSRect(x: 0, y: 0, width: 960, height: 640))
    @ObservationIgnored private let service: () -> any BrowserService
    /// Seals a value with this Mac's gate (`GateCLI.seal`, the value on stdin); nil where sealing is not offered.
    @ObservationIgnored private let sealer: BrowserSealer?
    /// The fill under way; nil once its sheet is closed (a token still being sealed then fills nothing).
    @ObservationIgnored private var fillAttempt: UUID?
    @ObservationIgnored private weak var state: MainWindowState?
    @ObservationIgnored private let defaults: UserDefaults?
    /// The window's title follows the tab on screen.
    @ObservationIgnored var onTitle: () -> Void = {}
    @ObservationIgnored private var shown = false
    @ObservationIgnored private var visible = false
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var streamingID: String?
    @ObservationIgnored private var inputTask: Task<Void, Never>?
    @ObservationIgnored private var queue = BrowserInputQueue()
    @ObservationIgnored private var inputRun = 0
    @ObservationIgnored private var resizeTask: Task<Void, Never>?
    @ObservationIgnored private var noteTask: Task<Void, Never>?
    @ObservationIgnored private var lastTitle: String?
    /// A refused stream is followed again backing off, its reason said once.
    @ObservationIgnored private var streamRetry = BrowserStreamRetry()
    /// Agents' tabs whose take-over notice was said (once a tab while the window is open).
    @ObservationIgnored private var noticed: Set<String> = []
    /// Your own tab on screen being taken (尺寸有主), and the last try, so a refusal is not asked again at every poll.
    @ObservationIgnored private var claiming = false
    @ObservationIgnored private var lastClaim: (id: String, at: ContinuousClock.Instant)?
    /// When this Mac last set the size of the tab on screen (renewed every minute while shown).
    @ObservationIgnored private var lastSized = ContinuousClock.now
    /// What the stream on screen asked for. It follows again when it should ask for something else: the window on a
    /// display of another scale or of other pixels, a step of the zoom that changes the frame pixels asked for, and,
    /// zoomed out past the display's pixels, another size of the browser area (BrowserScreenPolicy.stream).
    @ObservationIgnored private var streamAsked: BrowserStreamOptions?
    /// The page's zoom this Mac last sized the tab on screen with; nil until it has sized it.
    @ObservationIgnored private var sizedZoom: Double?

    /// A claim is tried again after this long when it did not hold (another screen took the tab meanwhile).
    private static let claimRetry: Duration = .seconds(5)

    /// `defaults`: where the recent addresses, the list's column and the sites' zoom are kept (nil: not kept, the design
    /// preview). `sealer`: this Mac's gate, for `New…` in Fill Ciphertext.
    init(service: @escaping () -> any BrowserService, state: MainWindowState?, defaults: UserDefaults? = .standard, recents: [String]? = nil,
         sealer: BrowserSealer? = nil) {
        self.service = service
        self.sealer = sealer
        self.state = state
        self.defaults = defaults
        self.recents = recents ?? defaults?.stringArray(forKey: BrowserRecents.storeKey) ?? []
        side = BrowserSide.restored(defaults?.string(forKey: BrowserSide.storeKey))
        zoomMemory = BrowserZoomMemory.restored(defaults?.string(forKey: BrowserZoomMemory.storeKey))
        zoomSteps = BrowserPageZoom.usable(in: screen.bounds.size)
        screen.onInput = { [weak self] event in self?.input(event) }
        screen.onPaste = { [weak self] in self?.paste() }
        screen.onCopy = { [weak self] in self?.say("画面中的内容无法复制。") }
        screen.onResize = { [weak self] in self?.screenResized() }
        screen.onHistory = { [weak self] action in self?.sideButton(action) }
        screen.onDisplayChange = { [weak self] in self?.displayChanged() }
    }

    // MARK: the tab list's column

    /// The bar's list button and ⌘B.
    func toggleList() { side = side.toggled() }

    // MARK: on screen or not

    /// The page is the one on screen (`shown`) in a window that is visible (`visible`): polls and the stream follow.
    func setActive(shown: Bool, visible: Bool) {
        guard shown != self.shown || visible != self.visible || (visible && pollTask == nil) else { return }
        let polling = shown != self.shown || visible != self.visible || pollTask == nil
        self.shown = shown
        self.visible = visible
        if polling { restartPolling() }
        updateStream()
        claimIfOwn()
    }

    /// The window closed: everything stops; every tab this Mac holds is handed back (its size goes back to the default).
    func stop() {
        let held = list.tabs.filter { $0.heldBy == screenID }.map(\.id)
        if !held.isEmpty {
            let service = service(), screen = screenID
            Task { for id in held { _ = try? await service.handBack(tabId: id, screen: screen) } }
        }
        shown = false
        visible = false
        fillTarget = nil
        fillAttempt = nil
        for task in [pollTask, streamTask, inputTask, resizeTask, noteTask] { task?.cancel() }
        pollTask = nil
        streamTask = nil
        streamingID = nil
        inputTask = nil
        queue.removeAll()
        screen.clear()
    }

    private func restartPolling() {
        pollTask?.cancel()
        pollTask = nil
        guard visible else { return }
        let interval = shown ? BrowserDefaults.pollInterval : BrowserDefaults.backgroundPollInterval
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: interval)
            }
        }
    }

    /// One read of the list.
    func refresh() async {
        do {
            let fresh = try await service().browserTabs()
            guard !Task.isCancelled else { return }
            apply(fresh)
            if problem != nil { problem = nil }
            renewIfDue()
        } catch is CancellationError {
            return
        } catch {
            let text = Self.describe(error)
            if problem != text { problem = text }
        }
        if !loaded { loaded = true }
    }

    /// A newer list: the tab on screen kept while it is there, else its neighbour.
    private func apply(_ fresh: BrowserTabList) {
        let previous = list
        if fresh != list { list = fresh }
        let next = fresh.selection(keeping: selectedID, previous: previous)
        if next != selectedID {
            select(next)
        } else {
            updateStream()
            publish()
        }
    }

    /// What the bar shows of the page, and the window's title.
    private func publish() {
        let tab = current
        state?.browserChanged(activity: .of(list), title: tab.map { BarTitle(BrowserTabText.title($0), mark: Self.mark($0.status)) })
        screen.setAction(tab?.action, owner: tab?.owner ?? .you)
        let title = tab.map(BrowserTabText.title)
        if title != lastTitle {
            lastTitle = title
            onTitle()
        }
        // Before a tab is taken and sized: the size asked for is at its site's zoom.
        followZoom()
        claimIfOwn()
    }

    static func mark(_ status: BrowserTabStatus) -> BarTitle.Mark {
        switch status {
        case .busy: .busy
        case .waiting: .waiting
        case .idle: .off
        }
    }

    // MARK: the tab on screen

    /// Another tab on screen: its stream instead, the screen cleared, its input queue emptied; the tabs this Mac held
    /// handed back (only the one on screen is seen to be held).
    func select(_ id: String?) {
        guard id != selectedID else { return }
        selectedID = id
        sizedZoom = nil
        handBackHeld(keeping: id)
        queue.removeAll()
        inputTask?.cancel()
        inputTask = nil
        resizeTask?.cancel()
        screen.clear()
        hasFrame = false
        streamRetry.reset()
        updateStream(restart: true)
        publish()
    }

    /// Every tab this Mac holds but `keeping`, given back: its agent goes on, its size goes back to the default.
    private func handBackHeld(keeping: String?) {
        let held = list.tabs.filter { $0.heldBy == screenID && $0.id != keeping }.map(\.id)
        guard !held.isEmpty else { return }
        let service = service(), screen = screenID
        Task { [weak self] in
            for id in held {
                guard let fresh = try? await service.handBack(tabId: id, screen: screen) else { continue }
                self?.replace(fresh)
            }
        }
    }

    private func updateStream(restart: Bool = false) {
        var wanted = shown && visible ? selectedID : nil
        // A refused stream waits out its backoff (the polls keep asking).
        if let id = wanted, id != streamingID, !streamRetry.allows(id, at: .now) { wanted = nil }
        if !restart, wanted == streamingID { return }
        streamTask?.cancel()
        streamTask = nil
        streamingID = nil
        streamAsked = nil
        guard let id = wanted else { return }
        streamingID = id
        // What it asks is settled here, not once the task runs: a change of the zoom meanwhile is seen as one.
        let options = streamOptions()
        streamAsked = options
        streamTask = Task { [weak self] in await self?.follow(id, options) }
    }

    /// The stream at the display's device pixels (the window's scale, at most the display's pixels), times the page's
    /// zoom where this Mac sizes the tab on screen.
    private func streamOptions() -> BrowserStreamOptions {
        let window = screen.window
        let scale = Double(window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2)
        return BrowserScreenPolicy.stream(backingScale: scale, displayPoints: (window?.screen ?? NSScreen.main)?.frame.size,
                                          zoom: zoom?.factor ?? 1, area: screen.bounds.size)
    }

    /// The stream follows again when what it should ask for is no longer what it asked.
    private func askAgain() {
        guard streamingID != nil, let asked = streamAsked, streamOptions() != asked else { return }
        updateStream(restart: true)
    }

    /// The window went to another display: the stream asks for its pixels — another scale, or the same scale and more
    /// or fewer of them (a window moved from a 1512 × 982 display to a larger one of the same scale kept the smaller
    /// one's bound, its picture enlarged from too few pixels; review, 2026-10-03) —, and a tab this Mac holds takes
    /// the display's pixel ratio (the same size again is only a renewal of the hold).
    private func displayChanged() {
        askAgain()
        screenResized()
    }

    /// The zoom in force for the tab on screen (BrowserPageModel+Zoom.swift) put to work, after every change of that
    /// tab (another site, held or let go), of what is remembered and of the area: the screen draws and sizes with it;
    /// a tab this Mac holds and sized with another zoom is sized again at once (the area did not change: nothing to
    /// wait for) — `sizing`: also one it has not sized yet, after `−` `+` —; and the stream asks again when the frame
    /// pixels it asks for are others (another step, unless both are at a limit), as for a display of another scale.
    /// Not here for another bound alone (the area's pixels, zoomed out past the display's): that waits until a resize
    /// has settled (`screenResized`), or the stream would begin again at every step of a drag.
    func followZoom(sizing: Bool = false) {
        let factor = zoom?.factor ?? 1
        if screen.zoom != factor { screen.zoom = factor }
        if shown, visible, holding, let id = selectedID, sizedZoom != factor, sizing || sizedZoom != nil {
            sizedZoom = factor
            Task { [weak self] in await self?.fitViewport(id) }
        }
        guard streamingID != nil, let asked = streamAsked, streamOptions().scale != asked.scale else { return }
        updateStream(restart: true)
    }

    private func follow(_ id: String, _ options: BrowserStreamOptions) async {
        // Replaced before it began (another step of the zoom at once): nothing to connect.
        guard !Task.isCancelled else { return }
        let stream = service().tabStream(id: id, options: options)
        do {
            var heard = false
            for try await event in stream {
                guard !Task.isCancelled, streamingID == id else { return }
                if !heard {
                    heard = true
                    streamRetry.succeeded(id)
                }
                handle(event, of: id)
            }
        } catch is CancellationError {
            return
        } catch DaemonError.http(status: 404, _) {
            // Closed while the stream was away.
            gone(id)
            return
        } catch {
            browserLog.error("browser stream \(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            // A later poll follows the tab again, backing off (a dropped connection is reconnected inside the stream;
            // this is a refusal or a service that answered strangely); the reason is said the first time.
            if streamRetry.failed(id, at: .now) { say(Self.describe(error)) }
            if streamingID == id { streamingID = nil }
        }
    }

    private func handle(_ event: BrowserStreamEvent, of id: String) {
        switch event {
        case .frame(let frame):
            screen.show(frame)
            if !hasFrame { hasFrame = true }
        case .closed:
            gone(id)
        default:
            guard let tab = list.tab(id) else { return }
            let was = tab
            let next = event.applied(to: tab)
            if next != tab { list = list.replacing(next) }
            if case .held(let heldBy, let reason) = event, was.heldBy == screenID, heldBy != screenID,
               let said = BrowserScreenPolicy.holdEnded(was, reason: reason, heldBy: heldBy) {
                say(said)
            }
            publish()
        }
    }

    /// The tab closed: out of the list, its neighbour on screen.
    private func gone(_ id: String) {
        guard list.tab(id) != nil else { return }
        let previous = list
        list = list.removing(id)
        if selectedID == id { select(list.selection(keeping: id, previous: previous)) } else { publish() }
        Task { await refresh() }
    }

    // MARK: input

    #if DEBUG
    /// BrowserProbe: every input event as it came and every request's outcome.
    @ObservationIgnored var probeTrace: [String] = []
    private func trace(_ line: String) { probeTrace.append(line) }
    #else
    private func trace(_ line: @autoclosure () -> String) {}
    #endif

    func input(_ event: BrowserInputEvent) {
        trace("input \(event) drive \(canDrive)")
        guard let tab = current else { return }
        guard canDrive else {
            // Hovering says nothing; a press, a key or a scroll says why nothing happens.
            if case .mouse(.move, _, _, _, _, _, _) = event { return }
            say(Self.blocked(tab, screen: screenID))
            return
        }
        queue.append(event)
        pump(tab.id)
    }

    /// Why this Mac may not drive the tab, as the daemon says it.
    static func blocked(_ tab: BrowserTab, screen: String) -> String {
        if case .elsewhere? = BrowserTabText.holder(tab, screen: screen) { return "此标签已由其他屏幕接手。" }
        return "此标签由 agent 使用，请先接手。"
    }

    /// Sends what is queued, a request at a time; moves and the wheel no more often than the motion interval.
    private func pump(_ id: String) {
        guard inputTask == nil else { return }
        inputRun += 1
        let run = inputRun
        inputTask = Task { [weak self] in
            let clock = ContinuousClock()
            var last = clock.now.advanced(by: .seconds(-1))
            while let self, !Task.isCancelled, self.selectedID == id, !self.queue.isEmpty {
                if self.queue.onlyMotion {
                    let due = last.advanced(by: BrowserDefaults.motionInterval)
                    if clock.now < due { try? await Task.sleep(until: due, clock: clock) }
                    if Task.isCancelled { break }
                }
                let batch = self.queue.take()
                last = clock.now
                do {
                    try await self.service().sendInput(tabId: id, events: batch, screen: self.screenID)
                    self.trace("sent \(batch.count)")
                } catch is CancellationError {
                    break
                } catch {
                    self.queue.removeAll()
                    self.trace("failed \(error)")
                    self.say(Self.describe(error))
                    await self.refresh()
                    break
                }
            }
            // Another tab's queue may have started since (`select` let this one go).
            if let self, self.inputRun == run { self.inputTask = nil }
        }
    }

    /// A mouse's back or forward button on the screen: the tab's history, as a browser's (only where this Mac may drive).
    private func sideButton(_ action: BrowserHistoryAction) {
        guard let tab = current else { return }
        guard canDrive else { return say(Self.blocked(tab, screen: screenID)) }
        Task { await history(action) }
    }

    /// ⌘V on the screen: the Mac's clipboard typed into the page as text.
    func paste() {
        guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else { return }
        guard text.utf16.count <= BrowserKeys.pasteLimit else { return say("剪贴板内容过长，未粘贴。") }
        for event in BrowserInputEvent.texts(text) { input(event) }
    }

    // MARK: holding

    /// `[ Take Over ]`: this Mac holds the tab, at the screen's size. An agent's tab says once that it will see what
    /// is typed, and where passwords go.
    func takeOver() async {
        guard let id = selectedID else { return }
        do {
            let tab = try await service().takeOver(tabId: id, screen: screenID)
            replace(tab)
            if tab.owner.isAgent, noticed.insert(tab.id).inserted { say(BrowserTabText.takeOverNotice, for: .seconds(10)) }
            await fitViewport(id)
            screen.window?.makeFirstResponder(screen)
        } catch {
            say(Self.describe(error))
        }
    }

    /// `[ Hand Back ]`: the agent goes on; the daemon puts the default size back.
    func handBack() async {
        guard let id = selectedID else { return }
        resizeTask?.cancel()
        do {
            replace(try await service().handBack(tabId: id, screen: screenID))
        } catch {
            say(Self.describe(error))
        }
    }

    /// ⌘⇧T (2026-10-03): what the status bar's hold button does — `[ Hand Back ]` while this Mac holds the tab,
    /// `[ Take Over ]` for an agent's tab or one held elsewhere; nothing for your own tab on this screen.
    func hold() async {
        guard let tab = current else { return }
        switch BrowserScreenPolicy.footerHolder(tab, screen: screenID) {
        case .thisMac?: await handBack()
        case .elsewhere?: await takeOver()
        case nil where tab.owner.isAgent: await takeOver()
        case nil: break
        }
    }

    /// The tab on screen, held by this Mac, takes the screen's size at the page's zoom (the screen's own request).
    private func fitViewport(_ id: String) async {
        guard holding, selectedID == id, let size = screen.viewportRequest else { return }
        lastSized = .now
        sizedZoom = screen.zoom
        do {
            replace(try await service().setViewport(tabId: id, size, screen: screenID))
        } catch {
            say(Self.describe(error))
        }
    }

    /// 尺寸有主 (docs/browser-v0.md §1 Mac, 2026-10-03): your own tab on screen in a visible window, nobody holding it,
    /// is taken quietly and given the browser area's size. A take that lands after the page left, the window hid or
    /// another tab came on screen is given back at once, its size never set.
    private func claimIfOwn() {
        guard shown, visible, !claiming, let tab = current, BrowserScreenPolicy.claims(tab) else { return }
        if let last = lastClaim, last.id == tab.id, ContinuousClock.now - last.at < Self.claimRetry { return }
        claiming = true
        lastClaim = (tab.id, .now)
        let id = tab.id, service = service(), me = screenID
        Task { [weak self] in
            do {
                let fresh = try await service.takeOver(tabId: id, screen: me)
                self?.claiming = false
                // The window closed (no page left), the page left or another tab is on screen: given back at once.
                guard let self, self.shown, self.visible, self.selectedID == id else {
                    if fresh.heldBy == me { _ = try? await service.handBack(tabId: id, screen: me) }
                    return
                }
                self.replace(fresh)
                await self.fitViewport(id)
            } catch {
                self?.claiming = false
                browserLog.error("browser claim \(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// While your own tab is shown and held here, its size is set again each minute: the daemon takes the same size as
    /// a renewal of the hold (two idle minutes would give it back and put the default size in its place).
    private func renewIfDue() {
        guard shown, visible, let tab = current, BrowserScreenPolicy.renews(tab, screen: screenID),
              ContinuousClock.now - lastSized >= BrowserScreenPolicy.renewal else { return }
        let id = tab.id
        Task { [weak self] in await self?.fitViewport(id) }
    }

    /// The screen changed size: the zoom's steps are those the new area can use, and a held tab follows once it settles.
    private func screenResized() {
        let steps = BrowserPageZoom.usable(in: screen.bounds.size)
        if steps != zoomSteps { zoomSteps = steps }
        followZoom()
        guard holding, let id = selectedID else { return }
        resizeTask?.cancel()
        resizeTask = Task { [weak self] in
            try? await Task.sleep(for: BrowserDefaults.resizeDelay)
            guard !Task.isCancelled else { return }
            await self?.fitViewport(id)
            // Zoomed out past the display's pixels the stream's bound is the area's: another area, another bound.
            self?.askAgain()
        }
    }

    private func replace(_ tab: BrowserTab) {
        guard list.tab(tab.id) != nil else { return }
        list = list.replacing(tab)
        publish()
    }

    // MARK: addresses

    /// The address bar's ↩: the tab on screen goes there; without one, a new tab opens.
    func go(_ text: String) async {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return }
        guard let id = selectedID else {
            _ = await open(.typed(typed))
            return
        }
        do {
            replace(try await service().navigate(tabId: id, to: .typed(typed), screen: screenID))
            remember(current?.url)
            screen.window?.makeFirstResponder(screen)
        } catch {
            say(Self.describe(error))
        }
    }

    func history(_ action: BrowserHistoryAction) async {
        guard let id = selectedID else { return }
        do {
            replace(try await service().history(tabId: id, action, screen: screenID))
        } catch {
            say(Self.describe(error))
        }
    }

    /// A new tab (the box's field, a recent address, a local server): on screen once it opens.
    @discardableResult
    func open(_ target: BrowserTarget) async -> Bool {
        guard !opening else { return false }
        opening = true
        openError = nil
        defer { opening = false }
        do {
            let tab = try await service().openTab(target)
            remember(tab.url)
            composing = false
            await refresh()
            if list.tab(tab.id) == nil {
                // Not in the list yet (a poll that crossed it): put it at the end of yours.
                list = BrowserTabList(running: true, groups: list.groups + [BrowserTabGroup(owner: tab.owner, tabs: [tab])])
            }
            select(tab.id)
            screen.window?.makeFirstResponder(screen)
            return true
        } catch {
            openError = Self.describe(error)
            return false
        }
    }

    func close(_ id: String) async {
        do {
            try await service().closeTab(id: id)
            gone(id)
        } catch {
            say(Self.describe(error))
        }
    }

    /// The new tab box: open, with the local servers read afresh.
    func composeNew() {
        openError = nil
        composing = true
        Task { await loadServers() }
    }

    func focusAddress() { addressRequests += 1 }

    func loadServers() async {
        serversLoading = true
        defer { serversLoading = false }
        do {
            servers = try await service().localServers()
            serversNote = nil
        } catch {
            servers = []
            serversNote = Self.describe(error)
        }
    }

    private func remember(_ url: String?) {
        guard let url, let entry = BrowserRecents.entry(for: url) else { return }
        recents = BrowserRecents.adding(entry, to: recents)
        defaults?.set(recents, forKey: BrowserRecents.storeKey)
    }

    // MARK: Fill Ciphertext

    /// `[ Fill Ciphertext ]`: the sheet, for the tab on screen (the fill goes to that tab even if another comes on
    /// screen meanwhile), with the page's site for a new ciphertext.
    func openFill() {
        guard canFill, let tab = current else { return }
        fillTarget = BrowserFillTarget(tabId: tab.id, site: GateSealRequest.host(of: tab.url))
    }

    /// A pasted ciphertext into the tab's focused input field. Nil when it was filled (the footer names what and
    /// where); the reason otherwise, for the sheet.
    func fill(_ token: String, into tabId: String) async -> String? {
        let attempt = beginFill()
        defer { endFill(attempt) }
        return await send(token, into: tabId)
    }

    /// `New…`: the value sealed by this Mac's gate for the sites given (`GateSealRequest`, as the Dispatch page's New
    /// Ciphertext), then filled at once, unless the sheet was closed meanwhile (nothing is typed then). The token comes
    /// back for the sheet to keep when the fill fails (a ciphertext, not the value; the value is kept nowhere).
    func sealAndFill(_ request: GateSealRequest, into tabId: String) async -> (token: String?, failure: String?) {
        guard let sealer else { return (nil, "此处无法生成密文。") }
        let attempt = beginFill()
        defer { endFill(attempt) }
        let token: String
        do {
            token = try await sealer(request)
        } catch {
            return (nil, error.localizedDescription)
        }
        guard fillAttempt == attempt else { return (token, nil) }
        return (token, await send(token, into: tabId))
    }

    /// The sheet is closed: a seal still under way fills nothing.
    func cancelFill() { fillAttempt = nil }

    private func beginFill() -> UUID {
        let attempt = UUID()
        fillAttempt = attempt
        filling = true
        return attempt
    }

    /// A newer attempt may be under way: only it says when filling is over.
    private func endFill(_ attempt: UUID) {
        if fillAttempt == nil || fillAttempt == attempt { filling = false }
    }

    private func send(_ token: String, into tabId: String) async -> String? {
        if let problem = BrowserFillText.problem(token) { return problem }
        guard let tab = list.tab(tabId) else { return "此标签已关闭。" }
        guard tab.owner.kind == .you else { return "只能在你自己的标签中填入密文。" }
        guard BrowserFillText.offered(on: tab.url) else { return "只能在 http(s) 页面中填入密文。" }
        do {
            let result = try await service().fill(tabId: tabId, token: token.trimmingCharacters(in: .whitespacesAndNewlines),
                                                  screen: screenID)
            if let fresh = result.tab { replace(fresh) }
            say(BrowserFillText.done(result))
            screen.window?.makeFirstResponder(screen)
            return nil
        } catch {
            return BrowserFillText.reason(error)
        }
    }

    // MARK: notes

    /// A line in the footer for a few seconds (four, unless said otherwise).
    func say(_ text: String, for duration: Duration = .seconds(4)) {
        note = text
        noteTask?.cancel()
        noteTask = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled else { return }
            self?.note = nil
        }
    }

    /// An error in the user's words: the daemon's reason for a refusal; a daemon without the browser said plainly.
    static func describe(_ error: Error) -> String {
        if case DaemonError.notSupported = error { return "当前服务未提供浏览器。" }
        if let error = error as? DaemonError { return error.reason }
        return error.localizedDescription
    }
}

/// Seals one value with this Mac's gate and gives the ciphertext (`GateCLI.seal`).
typealias BrowserSealer = @MainActor (GateSealRequest) async throws -> String

/// Fill Ciphertext's sheet: the tab it fills (the one on screen when it opened) and that page's site, prefilled as the
/// sites a new ciphertext may be used on.
struct BrowserFillTarget: Identifiable, Equatable {
    let tabId: String
    let site: String
    var id: String { tabId }
}
