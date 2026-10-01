import AgentSwitchMacCore
import AppKit
import OSLog
import SwiftUI

/// `log show --predicate 'subsystem == "com.agentswitch.mac" && category == "live"'`
private let liveLog = Logger(subsystem: "com.agentswitch.mac", category: "live")

/// The Mac's Live Activity (assistant-v0 §4, docs/design/visual-v1/mac-live.html), in the form macOS 26 gives an
/// iPhone's: a capsule among the menu bar's status items while something runs, waits or has just ended, and under it
/// the phone's lock screen card. A new request drops the card by itself (with the phone's "needs you" tones) and it
/// stays until answered; a result drops it for a few seconds. The card is a panel that never takes the focus: allowing
/// a command leaves you in the window you were typing in. A click on the capsule opens or closes the card, a double
/// click opens what it shows (the terminal, the task's page), a click elsewhere closes it. Asks `GET /live` every second
/// while the service answers; AgentSwitch's own menu bar item is left as it is.
@MainActor
@Observable
final class LiveActivity {
    /// 通用 › live activity.
    static let enabledKey = "liveActivity"
    static let soundKey = "liveActivitySound"
    static let interval: Duration = .seconds(1)

    private(set) var presenter = LivePresenter()
    /// Requests being answered: their buttons wait.
    private(set) var pending: Set<String> = []

    @ObservationIgnored private let model: AppModel
    @ObservationIgnored private let openTerminal: (String) -> Void
    @ObservationIgnored private var item: NSStatusItem?
    @ObservationIgnored private var panel: LivePanel?
    @ObservationIgnored private var host: LiveHostingView<LiveCardRoot>?
    @ObservationIgnored private var monitors: [Any] = []
    @ObservationIgnored private var poller: Task<Void, Never>?
    @ObservationIgnored private var drawn: String?
    /// The phone's tones: something needs you, a result, a failure (assistant-v0 §4).
    @ObservationIgnored private let tones: [LivePresenter.Cue: NSSound] = [
        .needsYou: NSSound(data: Tones.wav(Tones.needsYou)), .done: NSSound(data: Tones.wav(Tones.done)), .failed: NSSound(data: Tones.wav(Tones.failed)),
    ].compactMapValues { $0 }
    /// The terminal on screen in the terminal window in use.
    @ObservationIgnored private let watching: () -> String?
    @ObservationIgnored private let sleepGuard = SleepGuard()

    init(model: AppModel, openTerminal: @escaping (String) -> Void, watching: @escaping () -> String? = { nil }) {
        self.model = model
        self.openTerminal = openTerminal
        self.watching = watching
        UserDefaults.standard.register(defaults: [Self.enabledKey: true, Self.soundKey: true])
    }

    #if DEBUG
    /// `-liveDemo YES`: made-up work instead of the service (LiveDemo.swift).
    @ObservationIgnored private var demo: DaemonClient?

    /// `-liveDemoShots <dir>`: each new look of the capsule and the card written there, with where the card stands
    /// (checked without a screen); `-liveDemoScript YES`: the terminal allowed at 7 s and 删掉 picked at 23 s.
    @ObservationIgnored private var shots: URL?
    @ObservationIgnored private var shotCount = 0
    @ObservationIgnored private var lastShot = ""

    func startDemo() {
        demo = DaemonClient(port: 1, transport: LiveDemoTransport())
        shots = UserDefaults.standard.string(forKey: "liveDemoShots").map { URL(fileURLWithPath: $0) }
        if let shots { try? FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true) }
        if UserDefaults.standard.bool(forKey: "liveDemoScript") {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(7))
                if let self, let row = self.presenter.snapshot?.rows.first(where: { $0.id == "k1" }) { self.cardActions.decide(row, true) }
                try? await Task.sleep(for: .seconds(16))
                if let self, let row = self.presenter.snapshot?.rows.first(where: { $0.id == "t7" }) { self.cardActions.pick(row, "删掉") }
            }
        }
        start()
    }

    private func shoot() {
        guard let shots, let button = item?.button else { return }
        let open = panel?.isVisible == true && presenter.isOpen
        let key = "\(drawn ?? "")|\(open)|\(presenter.cardRows.map(\.id))|\(presenter.cardEnds.map(\.key))|\(pending)"
        guard key != lastShot else { return }
        lastShot = key
        shotCount += 1
        let name = String(format: "%02d", shotCount)
        if let image = button.image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: shots.appendingPathComponent("\(name)-capsule.png"))
        }
        var line = "\(name) t=\(Int(Date().timeIntervalSince(started))) open=\(open) opener=\(String(describing: presenter.opener)) look=\(presenter.look) rows=\(presenter.cardRows.map(\.id)) end=\(presenter.shownEnd?.key ?? "-") item=\(NSStringFromRect(button.window?.frame ?? .zero))"
        if open, let panel, let host {
            line += " card=\(NSStringFromRect(panel.frame)) alpha=\(panel.alphaValue)"
            if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: shots.appendingPathComponent("\(name)-card.png"))
            }
        }
        try? (line + "\n").appendLine(to: shots.appendingPathComponent("log.txt"))
    }
    @ObservationIgnored private let started = Date()

    private var client: DaemonClient { demo ?? model.client }
    private var ready: Bool { demo != nil || (model.daemonReady && !model.updating) }
    #else
    private var client: DaemonClient { model.client }
    private var ready: Bool { model.daemonReady && !model.updating }
    #endif

    func start() {
        guard poller == nil else { return }
        poller = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(for: LiveActivity.interval)
            }
        }
    }

    private var enabled: Bool { UserDefaults.standard.bool(forKey: Self.enabledKey) }

    private func poll() async {
        var next: LiveSnapshot?
        if ready {
            do { next = try await client.live() } catch { liveLog.debug("live: \(error.localizedDescription, privacy: .public)") }
        }
        // Work under way, a phone connected or a terminal open: the Mac stays awake (SleepGuard), whether the capsule
        // shows or not.
        #if DEBUG
        if demo == nil { sleepGuard.update(next, phoneOnline: (model.remote?.onlineDevices ?? 0) > 0) }
        #else
        sleepGuard.update(next, phoneOnline: (model.remote?.onlineDevices ?? 0) > 0)
        #endif
        if !enabled { next = nil }
        let now = Date()
        if let cue = presenter.receive(next, at: now, watching: watching()), UserDefaults.standard.bool(forKey: Self.soundKey) {
            for tone in tones.values { tone.stop() }
            tones[cue]?.play()
        }
        sync()
    }

    // MARK: what the user does

    private func toggle() {
        presenter.toggle()
        sync()
    }

    private func close() {
        guard presenter.isOpen else { return }
        presenter.close()
        sync()
    }

    /// The thing a row names: its terminal in the terminal window, or its task on the web console's page.
    private func open(_ row: LiveSnapshot.Row) {
        close()
        switch row.kind {
        case .terminal: openTerminal(row.id)
        case .task: openTask(row.id)
        }
    }

    private func openTask(_ id: String) {
        close()
        Task {
            do {
                NSWorkspace.shared.open(try await client.consoleLink(next: "/ui?task=\(id)"))
            } catch {
                model.errorMessage = "无法打开任务：\(error.localizedDescription)"
            }
        }
    }

    /// Double click: the first thing the card shows.
    private func openFirst() {
        if let end = presenter.shownEnd { openEnd(end) } else if let row = presenter.cardRows.first { open(row) }
    }

    /// A result's task or terminal; a failure opened is a failure seen.
    private func openEnd(_ end: LiveSnapshot.End) {
        presenter.opened(end)
        switch end.kind {
        case .terminal:
            close()
            openTerminal(end.id)
            sync()
        case .task: openTask(end.id)
        }
    }

    private func answer(_ row: LiveSnapshot.Row, _ send: @escaping @Sendable (DaemonClient) async throws -> Void) {
        let key = row.ask?.id ?? row.id
        guard !pending.contains(key) else { return }
        pending.insert(key)
        let client = client
        Task {
            do { try await send(client) } catch { liveLog.error("answer: \(error.localizedDescription, privacy: .public)") }
            pending.remove(key)
            await poll()
        }
    }

    private var actions: LiveCardActions {
        LiveCardActions(
            open: { [weak self] row in self?.open(row) },
            openEnd: { [weak self] end in self?.openEnd(end) },
            decide: { [weak self] row, allow in self?.answer(row) { try await $0.decide(row, allow: allow) } },
            pick: { [weak self] row, option in self?.answer(row) { try await $0.answer(row, option: option) } })
    }

    // MARK: the menu bar and the card

    private func sync() {
        let visible = presenter.visible
        if visible && item == nil { makeItem() }
        item?.isVisible = visible
        guard let item, let button = item.button else { return }
        if visible { drawCapsule(button) }
        button.highlight(presenter.isOpen)
        if presenter.isOpen && visible { showCard(under: button) } else { hideCard() }
        #if DEBUG
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.shoot() }
        #endif
    }

    private func makeItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.autosaveName = "AgentSwitchLive"
        let target = LiveActivityTarget(self)
        item.button?.target = target
        item.button?.action = #selector(LiveActivityTarget.clicked(_:))
        item.button?.sendAction(on: [.leftMouseUp])
        item.button?.imagePosition = .imageOnly
        item.button?.setAccessibilityLabel("AgentSwitch Live Activity")
        self.target = target
        self.item = item
        // The bar lays the capsule out again after its image changes (a wider clock, the tally): the card follows.
        if let window = item.button?.window {
            for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
                barObservers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.refit() }
                })
            }
        }
    }

    @ObservationIgnored private var target: LiveActivityTarget?
    @ObservationIgnored private var barObservers: [NSObjectProtocol] = []

    fileprivate func buttonClicked() {
        if NSApp.currentEvent?.clickCount ?? 1 >= 2 { openFirst() } else { toggle() }
    }

    /// The capsule as the button's image, drawn again when what it says changes (the clock: once a second).
    private func drawCapsule(_ button: NSStatusBarButton) {
        let now = Date()
        let capsule = LiveCapsule(look: presenter.look, trail: presenter.trail, now: now)
        var clock = ""
        if case .clock(let since, _)? = presenter.trail { clock = LiveLook.clock(since: since, now: now) }
        let key = "\(presenter.look)|\(String(describing: presenter.trail))|\(clock)"
        guard key != drawn else { return }
        let renderer = ImageRenderer(content: capsule)
        renderer.scale = button.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        guard let image = renderer.nsImage else { return }
        image.isTemplate = false
        button.image = image
        drawn = key
    }

    private func showCard(under button: NSStatusBarButton) {
        let appearing = panel?.isVisible != true
        if panel == nil {
            let host = LiveHostingView(rootView: LiveCardRoot(activity: self))
            host.wantsLayer = true
            let panel = LivePanel(content: host)
            self.host = host
            self.panel = panel
        }
        guard let panel, let host else { return }
        host.layoutSubtreeIfNeeded()
        panel.setFrame(frame(of: host.fittingSize, under: button), display: true)
        panel.invalidateShadow()
        // The card's height follows its rows (SwiftUI lays out after this run of the loop) and the capsule's new width
        // moves it on the bar only then: placed again once both have happened.
        DispatchQueue.main.async { [weak self] in self?.refit() }
        guard appearing else { return }
        // The fade is the layer's: the window is at full opacity at once, so a card that drops while the display
        // sleeps is there when it wakes (a window's own alpha animation stalls with the display).
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.18
        host.layer?.add(fade, forKey: "appear")
        watchClicksElsewhere()
    }

    /// Height and place again (a row came or went).
    private func refit() {
        guard let panel, panel.isVisible, let host, let button = item?.button else { return }
        host.layoutSubtreeIfNeeded()
        panel.setFrame(frame(of: host.fittingSize, under: button), display: true)
        panel.invalidateShadow()
    }

    /// Under the capsule, centred on it and kept on its screen; the screen's top right when the menu bar is hidden (a
    /// full-screen app).
    private func frame(of size: NSSize, under button: NSStatusBarButton) -> NSRect {
        let screen = button.window?.screen ?? NSScreen.main
        let bounds = screen?.frame ?? .zero
        if let window = button.window, window.occlusionState.contains(.visible) {
            let anchor = window.frame
            let x = min(max(anchor.midX - size.width / 2, bounds.minX + 8), bounds.maxX - size.width - 8)
            return NSRect(x: x, y: anchor.minY - 6 - size.height, width: size.width, height: size.height)
        }
        return NSRect(x: bounds.maxX - size.width - 12, y: bounds.maxY - 6 - size.height, width: size.width, height: size.height)
    }

    private func hideCard() {
        stopWatchingClicks()
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
    }

    /// A click in another app, or in one of ours outside the card and the capsule, closes the card.
    private func watchClicksElsewhere() {
        guard monitors.isEmpty else { return }
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }) { monitors.append(global) }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            MainActor.assumeIsolated {
                guard let self else { return }
                if event.window !== self.panel && event.window !== self.item?.button?.window { self.close() }
            }
            return event
        }) { monitors.append(local) }
    }

    private func stopWatchingClicks() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
    }

    fileprivate var cardActions: LiveCardActions { actions }
}

/// The status button's target (an NSObject; the activity is an observable Swift class).
private final class LiveActivityTarget: NSObject {
    weak var activity: LiveActivity?

    init(_ activity: LiveActivity) { self.activity = activity }

    @MainActor @objc func clicked(_ sender: Any?) { activity?.buttonClicked() }
}

/// The card, redrawn as the activity changes; nothing while it is closed (its spinners stop with it).
struct LiveCardRoot: View {
    let activity: LiveActivity

    var body: some View {
        if activity.presenter.isOpen {
            LiveCard(presenter: activity.presenter, actions: activity.cardActions, pending: activity.pending)
                .fixedSize()
        }
    }
}

/// A panel that floats over every space (full-screen apps too) and never takes the focus: its buttons act on the first
/// click without making AgentSwitch the active app.
final class LivePanel: NSPanel {
    init(content: NSView) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 360, height: 120), styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        hidesOnDeactivate = false
        isMovable = false
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = true
        contentView = content
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Clicks reach the card's buttons at once, in a panel that is not key.
final class LiveHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

#if DEBUG
private extension String {
    func appendLine(to file: URL) throws {
        if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: Data(utf8))
        } else {
            try write(to: file, atomically: true, encoding: .utf8)
        }
    }
}
#endif
