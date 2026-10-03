import AgentSwitchKit
import Foundation
import Observation
import UIKit

/// One tab on the phone (docs/browser-v0.md §1): its stream drawn into the screen, who holds it, and what the phone
/// sends. A tab has one size and one holder ("尺寸有主", as the terminals): your own tab is this phone's while its page is
/// open here and no other screen holds it; an agent's tab is only watched until `[ Take Over ]`. Holding a tab, the
/// phone sets the page to its own screen area (a phone's layout); handing it back, leaving the page or going to the
/// background gives it back, and the Mac puts its own size back — a take still on its way then is given back as it
/// lands, its size never set. The stream stops whenever the page is not seen. Frames are decoded off the main thread,
/// only the newest (BrowserFrameDecoder).
@MainActor
@Observable
final class BrowserPageModel {
    let id: String
    private(set) var tab: BrowserTabInfo
    /// The latest frame's size in pixels and its pixels per CSS pixel (nil before the first).
    private(set) var frameSize: CGSize?
    private(set) var frameScale: Double = 1
    /// Pictures drawn afresh (the first after connecting, the first at a new size): each comes in top down.
    private(set) var refreshes = 0
    private(set) var connection: Connection = .connecting
    private(set) var closed: BrowserClosedReason?
    /// A take-over or a hand-back on its way.
    private(set) var holding = false
    var error: String?
    /// A passing word about what just happened (a hold that ended, a refusal), gone after a few seconds.
    private(set) var note: String?
    /// The screen area in points (set by the page).
    var area: CGSize = .zero { didSet { if area != oldValue { areaChanged(from: oldValue) } } }
    /// The keyboard is up (the hidden field has it).
    var typing = false { didSet { if typing != oldValue { relift() } } }
    /// The phone's own zoom of the picture.
    private(set) var zoom = BrowserZoom.none
    /// How far the picture is lifted so what was touched stays above the keyboard.
    private(set) var lift: Double = 0

    enum Connection: Equatable { case connecting, live, reconnecting }

    let screenId = PhoneScreen.id
    @ObservationIgnored let screen = BrowserScreenView(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
    @ObservationIgnored private var api: AgentSwitchAPI?
    @ObservationIgnored private var options = BrowserStreamPolicy.local
    @ObservationIgnored private var follow: Task<Void, Never>?
    /// Which `start` the stream task is (an old one's failure does not touch a newer one).
    @ObservationIgnored private var streamRun = 0
    /// The page is seen (from `start` to `stop`): a take that lands outside it is handed back at once.
    @ObservationIgnored private var active = false
    /// The hand-back sent on leaving; a take on coming back waits for it, so the two never cross.
    @ObservationIgnored private var leaving: Task<Void, Never>?
    /// The take-over notice was said (once a visit to the tab).
    @ObservationIgnored private var noticed = false
    @ObservationIgnored private let frames = BrowserFrameDecoder()
    @ObservationIgnored private var queue = BrowserInputQueue()
    @ObservationIgnored private var sending: Task<Void, Never>?
    @ObservationIgnored private var sizing: Task<Void, Never>?
    @ObservationIgnored private var noteHides: Task<Void, Never>?
    /// The frame the picture shows now: input is aimed at it.
    @ObservationIgnored private var seq: Int?
    /// Where the last touch fell, in frame pixels (what the keyboard must not cover).
    @ObservationIgnored private var touchedY: Double?
    /// Opened or back in front: your own tab is taken when the stream says nobody else holds it.
    @ObservationIgnored private var claimOnConnect = false
    /// The size this phone last set, so a layout change sends a new one only when it differs.
    @ObservationIgnored private var sizeSent: CGSize?

    init(tab: BrowserTabInfo) {
        id = tab.id
        self.tab = tab
        agentName = tab.owner.agentName()
        frames.onFrame = { [weak self] decoded in self?.present(decoded) }
    }

    // MARK: who holds it

    /// This phone holds it.
    var mine: Bool { tab.heldBy == screenId }
    /// This phone may click, type and navigate.
    var canDrive: Bool { tab.drivable(by: screenId) }
    /// Another screen holds it.
    var heldElsewhere: BrowserHolder? { tab.heldBy.flatMap { $0 == screenId ? nil : BrowserHolder($0) } }
    /// The page is at this phone's size.
    var phoneSized: Bool { tab.viewport.by == screenId }
    /// `Fill Ciphertext` is offered: this phone drives one of your own tabs (never an agent's, even taken over: the
    /// agent sees the page again after the hand-back, and the Mac refuses it).
    var canFill: Bool { canDrive && !tab.owner.isAgent }

    var layout: BrowserLayout? {
        guard let frameSize, area.width > 0, area.height > 0 else { return nil }
        return BrowserLayout(frame: frameSize, area: area, fillWidth: phoneSized, lift: lift, zoom: zoom)
    }

    // MARK: the stream

    func start(_ api: AgentSwitchAPI?, options: BrowserStreamOptions) {
        guard follow == nil, closed == nil else { return }
        self.api = api
        self.options = options
        guard let api else {
            #if DEBUG
            showDemo()
            #endif
            return
        }
        claimOnConnect = true
        active = true
        connection = .connecting
        let id = id
        streamRun += 1
        let run = streamRun
        follow = Task { [weak self] in
            do {
                for try await event in api.browserEvents(id, options: options) {
                    guard let self, !Task.isCancelled else { return }
                    self.handle(event)
                }
            } catch {
                // The stream gave up (an answer that is no stream): said, and `resume()` starts it again.
                guard let self, self.streamRun == run else { return }
                self.error = error.localizedDescription
                self.follow = nil
            }
        }
    }

    /// The page is not seen (left, another tab, the background): the stream ends and the tab goes back.
    func stop() {
        active = false
        follow?.cancel()
        follow = nil
        frames.reset()
        sizing?.cancel()
        typing = false
        if mine { handBackQuietly() }
    }

    /// Back in sight: the stream again; your own tab is taken again when nobody holds it.
    func resume() {
        guard follow == nil, closed == nil else { return }
        start(api, options: options)
    }

    func handle(_ event: BrowserEvent) {
        switch event {
        case .tab(let fresh):
            tab = fresh
            if connection == .reconnecting { connection = .live }
            if claimOnConnect {
                claimOnConnect = false
                if !fresh.owner.isAgent, fresh.heldBy == nil || fresh.heldBy == screenId { claim() }
            }
        case .frame(let frame):
            // Decoded off the main thread; shown by `present`.
            frames.take(frame)
        case .held(let holder, let reason):
            let had = mine
            tab = tab.applying(event)
            if had, holder != screenId {
                typing = false
                sizeSent = nil
                if reason == .idle { say(BrowserNotice.idleHandBack) }
                else if let holder { say(BrowserHolder(holder).said) }
            }
        case .viewport:
            tab = tab.applying(event)
        case .closed(let reason):
            closed = reason
            typing = false
            follow?.cancel()
            follow = nil
        case .dropped:
            connection = .reconnecting
            // The hold may have ended meanwhile; what the stream says on connecting decides.
            claimOnConnect = !tab.owner.isAgent
        default:
            tab = tab.applying(event)
        }
        screen.action = actionShown
    }

    /// A decoded frame on the screen: input is aimed at it from now on.
    private func present(_ decoded: BrowserDecodedFrame) {
        let frame = decoded.frame
        seq = frame.seq
        screen.show(UIImage(cgImage: decoded.image))
        let size = frame.size
        if frameSize != size {
            // The first picture, or one at a new size (the page took the phone's size, or gave it back).
            frameSize = size
            refreshes += 1
            relift()
        }
        if frameScale != frame.scale { frameScale = frame.scale }
        if connection != .live { connection = .live }
        screen.layout = layout
        screen.action = actionShown
    }

    /// The agent's last action, while it is the agent's turn (not over your own hands).
    private var actionShown: (box: BrowserBox, frameScale: Double, said: String)? {
        guard tab.owner.isAgent, !mine, let action = tab.action, let box = action.box else { return nil }
        return (box, frameScale, action.said(by: agentName))
    }

    /// The agent behind the tab as people call it (`Codex`, `Claude Code`; the page sets it from the terminal or the
    /// task), for the outline's label and the holder line.
    var agentName: String { didSet { screen.action = actionShown } }

    // MARK: holding

    /// `[ Take Over ]`: this phone holds the tab (from the agent, or from another screen) at its own size. An agent's
    /// tab says once that it will see what is typed, and where passwords go.
    func takeOver() async {
        guard let api, !holding else { return }
        holding = true
        defer { holding = false }
        await leaving?.value
        do {
            let fresh = try await api.takeBrowserTab(id, screen: screenId)
            guard landed(fresh) else { return }
            if fresh.owner.isAgent, !noticed {
                noticed = true
                say(BrowserNotice.takeOver, for: .seconds(10))
            }
            await sendSize(force: true)
        } catch {
            self.error = error.localizedDescription
        }
        screen.action = actionShown
    }

    /// `[ Hand Back ]`: the agent goes on; the page gets the Mac's size again.
    func handBack() async {
        guard let api, !holding else { return }
        holding = true
        defer { holding = false }
        typing = false
        do {
            tab = try await api.releaseBrowserTab(id, screen: screenId)
            sizeSent = nil
        } catch {
            self.error = error.localizedDescription
        }
        screen.action = actionShown
    }

    /// Your own tab, nobody else holding it: this phone's, quietly.
    private func claim() {
        guard let api, !holding else { return }
        holding = true
        Task { [weak self] in
            defer { self?.holding = false }
            guard let self else { return }
            await self.leaving?.value
            do {
                let fresh = try await api.takeBrowserTab(self.id, screen: self.screenId)
                guard self.landed(fresh) else { return }
                await self.sendSize(force: true)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// A take's answer: the tab while the page is seen; after `stop()` (the page left, the app in the background) the
    /// hold is given back at once and no size is set (true: go on).
    private func landed(_ fresh: BrowserTabInfo) -> Bool {
        guard active else {
            if fresh.heldBy == screenId { handBackQuietly() }
            return false
        }
        tab = fresh
        return true
    }

    /// Leaving: given back whether or not anyone waits for the answer.
    private func handBackQuietly() {
        guard let api else { return }
        let id = id, me = screenId
        sizeSent = nil
        leaving = Task { _ = try? await api.releaseBrowserTab(id, screen: me) }
    }

    /// The page at this phone's screen area (points, its pixel ratio, a phone's layout). A keyboard (the page's or the
    /// address bar's) does not shrink it: the picture is lifted instead, as a phone's browser keeps its layout under
    /// the keyboard; so after the first, only a new width (the phone turned) or more height is sent.
    private func sendSize(force: Bool = false) async {
        guard let api, active, mine, area.width >= 100, area.height >= 100 else { return }
        let size = CGSize(width: area.width.rounded(), height: area.height.rounded())
        let grown = sizeSent.map { size.width != $0.width || size.height > $0.height } ?? true
        guard force || grown else { return }
        sizeSent = size
        do {
            tab = try await api.setBrowserViewport(id, width: Int(size.width), height: Int(size.height), scale: Double(max(screen.traitCollection.displayScale, 1)),
                                                   mobile: true, screen: screenId)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func areaChanged(from old: CGSize) {
        screen.layout = layout
        relift()
        zoom = zoom.clamped(to: area)
        // Turned, or more room: the page follows, once things settle (never for a keyboard; sendSize).
        guard mine, old != .zero else { return }
        sizing?.cancel()
        sizing = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.sendSize()
        }
    }

    /// While the keyboard is up, what was last touched stays in sight; down, the picture sits at the top again.
    private func relift() {
        guard let frameSize, phoneSized, typing, let y = touchedY else {
            if lift != 0 { lift = 0 }
            screen.layout = layout
            return
        }
        lift = BrowserLayout.lift(toShow: y, frame: frameSize, areaWidth: area.width, visible: area.height)
        screen.layout = layout
    }

    // MARK: input

    /// A tap clicks there; on your own tab nobody holds, the phone takes it as it acts.
    func tap(at point: CGPoint) {
        guard let at = aim(point) else { return }
        touchedY = at.y
        send(.click(x: at.x, y: at.y, seq: seq))
    }

    /// A long press is the right button (the page's own menu).
    func longPress(at point: CGPoint) {
        guard let at = aim(point) else { return }
        send(.click(x: at.x, y: at.y, button: .right, seq: seq))
    }

    /// A drag scrolls the page under the finger.
    func drag(_ delta: CGSize, at point: CGPoint) {
        guard let layout, let at = aim(point, quiet: true) else { return }
        let wheel = layout.wheelDelta(forDrag: delta)
        send(.wheel(x: at.x, y: at.y, deltaX: wheel.width, deltaY: wheel.height, seq: seq))
    }

    func pinch(_ scale: CGFloat, at point: CGPoint) {
        zoom = zoom.pinched(to: zoom.scale * scale, around: point, area: area)
        screen.layout = layout
    }

    func pan(_ delta: CGSize) {
        guard zoom.isZoomed else { return }
        zoom = zoom.panned(by: delta, area: area)
        screen.layout = layout
    }

    func resetZoom() {
        zoom = .none
        screen.layout = layout
    }

    func type(_ text: String) { if canDrive { send(.text(text)) } else { refuse() } }

    func press(_ key: BrowserKey) { if canDrive { send(.key(key)) } else { refuse() } }

    /// The frame pixel under a point, when this phone may act there; else nothing is sent (and why is said once).
    private func aim(_ point: CGPoint, quiet: Bool = false) -> CGPoint? {
        guard canDrive else {
            if !quiet { refuse() }
            return nil
        }
        return layout?.framePoint(at: point)
    }

    private func refuse() {
        if let holder = heldElsewhere { say(holder.said + "接手后才能操作。") }
        else { say("此标签由 agent 使用。接手后才能操作。") }
    }

    /// In order, one request at a time; a drag's turns that pile up meanwhile go as one.
    private func send(_ event: BrowserInput) {
        guard let api else { return }
        queue.append(event)
        if !mine && !tab.owner.isAgent && tab.heldBy == nil { claim() }
        guard sending == nil else { return }
        let id = id, me = screenId
        sending = Task { [weak self] in
            while let self, !self.queue.isEmpty, !Task.isCancelled {
                let batch = self.queue.next()
                do {
                    try await api.sendBrowserInput(id, batch, screen: me)
                } catch {
                    self.queue.removeAll()
                    self.error = error.localizedDescription
                }
            }
            self?.sending = nil
        }
    }

    // MARK: going places

    func navigate(_ typed: String) async {
        guard let api, let target = BrowserAddress.target(for: typed) else { return }
        guard canDrive else { refuse(); return }
        do { tab = try await api.navigateBrowserTab(id, to: target, screen: screenId) } catch { self.error = error.localizedDescription }
    }

    func history(_ action: BrowserHistoryAction) async {
        guard let api else { return }
        guard canDrive else { refuse(); return }
        do { tab = try await api.browserHistory(id, action, screen: screenId) } catch { self.error = error.localizedDescription }
    }

    /// A saved ciphertext into the focused field, checked by the gate against the page's site; your own tabs only, and
    /// only a password or one-time-code field (the Mac's refusal is shown as it is). False: the Mac cannot do it yet.
    func fill(_ token: String) async -> Bool {
        guard let api else { return true }
        guard canDrive else { refuse(); return true }
        guard canFill else { error = BrowserNotice.fillOwnTabsOnly; return true }
        do {
            guard try await api.fillBrowserTab(id, token: token, screen: screenId) else {
                error = "此 Mac 上的 AgentSwitch 版本尚不支持填入密文，请先更新。"
                return false
            }
            say("已填入密文。")
        } catch {
            self.error = error.localizedDescription
        }
        return true
    }

    func close() async -> Bool {
        guard let api else { return true }
        do {
            try await api.closeBrowserTab(id)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    private func say(_ words: String, for duration: Duration = .seconds(4)) {
        note = words
        noteHides?.cancel()
        noteHides = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled else { return }
            self?.note = nil
        }
    }

    #if DEBUG
    /// The demo screens: a picture drawn on the phone in place of the Mac's (a tab at this phone's size, at the size of
    /// its screen area, once that is known).
    private func showDemo() {
        if phoneSized && area == .zero {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.showDemo() }
            return
        }
        guard let frame = DemoBrowser.frame(for: tab, size: phoneSized ? area : nil) else { return }
        handle(.frame(frame))
        connection = .live
        if UserDefaults.standard.string(forKey: "uiDemoScreen") == "browsertook" {
            touchedY = 210   // the password field of the mock login page
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.typing = true }
        }
    }
    #endif
}
