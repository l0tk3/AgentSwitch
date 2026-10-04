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
///
/// The size carries the page's zoom (browser-v0 §1 页面缩放, 2026-10-03; user: 然后我发现agentswitch的浏览器页没有放大缩小的
/// 选项，加上 用来调节大小): the screen area over the zoom this phone remembers for the tab's site (BrowserPageZoom), set
/// again when the zoom or the site changes. So only while this phone sizes the tab does the zoom key zoom the page;
/// while it only watches, the key steps the picture on the phone, as two fingers do.
@MainActor
@Observable
final class BrowserPageModel {
    let id: String
    private(set) var tab: BrowserTabInfo { didSet { if tab.site != oldValue.site { siteChanged() } } }
    /// The latest frame's size in pixels and its pixels per CSS pixel (nil before the first).
    private(set) var frameSize: CGSize?
    private(set) var frameScale: Double = 1
    /// The latest frame's page size in CSS pixels (a new one draws the picture in afresh; a new density does not).
    @ObservationIgnored private var pageSize: CGSize?
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
    /// The Browser tab's store, which keeps the page zoom this phone remembers by site (set by the page).
    var store: BrowserStore?

    enum Connection: Equatable { case connecting, live, reconnecting }

    let screenId = PhoneScreen.id
    @ObservationIgnored let screen = BrowserScreenView(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
    @ObservationIgnored private var api: AgentSwitchAPI?
    @ObservationIgnored private var options = BrowserStreamPolicy.local
    @ObservationIgnored private var follow: Task<Void, Never>?
    /// The stream that was followed before `follow` (`retune`): it goes on drawing until `follow` has brought its
    /// first event, so the picture does not pause and the Mac never sees the tab without a stream.
    @ObservationIgnored private var outgoing: Task<Void, Never>?
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
    /// Where the last touch fell, in the page's CSS pixels (what the keyboard must not cover; frames may change density).
    @ObservationIgnored private var touchedY: Double?
    /// Opened or back in front: your own tab is taken when the stream says nobody else holds it.
    @ObservationIgnored private var claimOnConnect = false
    /// The roomiest the screen area has stood at this width (whole points): what the page is sized for, and what the
    /// zoom's steps go by. Kept apart from the hold (review, 2026-10-03): while it was `sizeSent`, forgotten whenever
    /// the hold ended, a take with the zoom row, a note or the keyboard up sized the page for what they left and
    /// again as each went — and the keyboard moved the step in force. Seen by what shows the zoom.
    private var roomiest: CGSize?
    /// When the screen area last changed: an area is room the page has only if it stood (`noteRoom`).
    @ObservationIgnored private var areaSince = ContinuousClock.now
    /// The area this phone last sized the page for (whole points; the page's own size is that over the zoom), so a
    /// layout change sends a new one only when it differs; nil while no size of this phone's is in force (the hold
    /// ended).
    @ObservationIgnored private var sizeSent: CGSize?
    /// The zoom the page was last sized at (percent), so another site's, or the key's, sends the size again.
    @ObservationIgnored private var zoomSent: Int?
    /// The size request sent last (the next waits for it), and how many were asked for (one that is no longer the
    /// newest when its turn comes is not sent).
    @ObservationIgnored private var sizeRequest: Task<Void, Never>?
    @ObservationIgnored private var sizeAsks = 0

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
        // The page opens on the list's copy of the tab, read every 2 s: for that long after a page was left it may still
        // say this phone holds the tab it gave back on leaving. The stream's first word decides; until then the tab is
        // nobody's here, as after handBackQuietly (a zoom key pressed in that moment set a size the Mac refused).
        if mine { tab = tab.applying(.held(nil, reason: .handBack)) }
        claimOnConnect = true
        active = true
        connection = .connecting
        follow = openStream(api)
    }

    /// The stream as `options` asks; a failure is said unless a newer stream took over. With its first event, and
    /// whenever it ends, the stream it takes over from ends (`endOutgoing`).
    private func openStream(_ api: AgentSwitchAPI) -> Task<Void, Never> {
        let id = id
        let options = options
        streamRun += 1
        let run = streamRun
        return Task { [weak self] in
            defer { self?.endOutgoing(after: run) }
            var heard = false
            do {
                for try await event in api.browserEvents(id, options: options) {
                    guard let self, !Task.isCancelled else { return }
                    if !heard {
                        heard = true
                        self.endOutgoing(after: run)
                    }
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

    /// Another picture for the same tab: the link was measured (browser-v0 §1 iPhone) and allows more, or less, or
    /// the page's zoom changed what the stream asks (§1 页面缩放, 2026-10-03). The stream again with `options`, the new
    /// one opened before the old one ends so the picture does not pause; the tab kept (nothing handed back or taken)
    /// and, the page the same, not drawn in afresh. Not streaming: the next start asks for them.
    ///
    /// The old stream stays, drawing, until the new one has brought its first event (review, 2026-10-03: ended at
    /// once, before the new request had left, it left the tab without a stream for a moment at every step — the Mac
    /// drew the view at the CSS size for nobody, and again for the new stream). It also ends when the new one ends.
    /// A new one replaced in its turn before it has brought anything (two steps within the time a stream takes to
    /// connect) ends at once, and the one still drawing stays for the newest to take over from: never more than one
    /// stream beside the one followed.
    func retune(_ options: BrowserStreamOptions) {
        guard options != self.options, closed == nil else { return }
        self.options = options
        guard let old = follow, let api else { return }
        if outgoing == nil { outgoing = old } else { old.cancel() }
        follow = openStream(api)
    }

    /// Stream `run` has brought its first event, or has ended: the stream it took over from ends. Not when `run` was
    /// replaced itself meanwhile: the outgoing stream is then the newer one's to end.
    private func endOutgoing(after run: Int) {
        guard streamRun == run else { return }
        outgoing?.cancel()
        outgoing = nil
    }

    /// No stream from here on: the one followed and, where it had not taken over yet, the one still drawing.
    private func endStreams() {
        follow?.cancel()
        follow = nil
        outgoing?.cancel()
        outgoing = nil
    }

    /// The page is not seen (left, another tab, the background): the stream ends and the tab goes back.
    func stop() {
        active = false
        endStreams()
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
            endStreams()
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
        if frameScale != frame.scale { frameScale = frame.scale }
        // The first picture, or the page at a new size (it took the phone's size, or gave it back, or was zoomed) comes
        // in top down; the same page at another density (drawn at the phone's pixels, or at the CSS size while an agent
        // clicks) just replaces it. By the page's size alone: a zoom step lays the page out afresh and mostly leaves
        // the frame the screen's pixels as it was (review, 2026-10-03: decided only where the frame's size changed,
        // the refresh played at some steps and not at others).
        if pageSize != frame.pageSize {
            refreshes += 1
            pageSize = frame.pageSize
        }
        if frameSize != size {
            frameSize = size
            relift()
        }
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

    /// Leaving: given back whether or not anyone waits for the answer, and said here at once rather than left for the
    /// next stream to say: from now the tab is nobody's. So back on the page, before that stream's first word, your
    /// own tab is taken as the phone acts on it and an agent's is only watched. (Counted as this phone's until then,
    /// a press on the zoom key — browser-v0 §1 页面缩放, 2026-10-03 — set a size the Mac refused, and on an agent's tab
    /// remembered a zoom for a page it had not zoomed.)
    private func handBackQuietly() {
        guard let api else { return }
        let id = id, me = screenId
        sizeSent = nil
        tab = tab.applying(.held(nil, reason: .handBack))
        leaving = Task { _ = try? await api.releaseBrowserTab(id, screen: me) }
    }

    /// The page at this phone's screen area over the page zoom (BrowserPageZoom: points over the factor, the pixel
    /// ratio times it, a phone's layout). A keyboard (the page's or the address bar's) does not shrink it: the picture
    /// is lifted instead, as a phone's browser keeps its layout under the keyboard; so after the first, only another
    /// area to size the page for (`sizedArea`: the phone turned, more room than there has been, or the first sent
    /// while the page was still being laid out) or another zoom is sent. The requests go one at a time, in the order
    /// asked, and of those waiting only the newest (the zoom key pressed again and again): a later size landing before
    /// an earlier one would leave the page at an older zoom.
    private func sendSize(force: Bool = false) async {
        guard let api, active, mine, area.width >= 100, area.height >= 100 else { return }
        let size = sizedArea
        let percent = pageZoom
        guard force || sizeSent != size || zoomSent != percent else { return }
        sizeSent = size
        zoomSent = percent
        let page = BrowserPageZoom.viewport(area: size, screenScale: Double(max(screen.traitCollection.displayScale, 1)), percent: percent)
        sizeAsks += 1
        let ask = sizeAsks, earlier = sizeRequest
        let request = Task { [weak self] in
            await earlier?.value
            // A newer size was asked for while this one waited, or the tab went back meanwhile (`sizeSent` is forgotten
            // then): nothing to set. Not by `mine`: a zoom step on your own tab that nobody holds sends the take and
            // asks the stream again together, and that stream's first word may still say nobody holds the tab —
            // handled between the take's answer and this turn, it dropped the size while `sizeSent` said it was set
            // (review, 2026-10-03).
            guard let self, self.sizeAsks == ask, self.active, self.sizeSent != nil else { return }
            do {
                self.tab = try await api.setBrowserViewport(self.id, width: Int(page.width), height: Int(page.height), scale: page.scale,
                                                            mobile: page.mobile, screen: self.screenId)
            } catch {
                self.error = error.localizedDescription
            }
        }
        sizeRequest = request
        await request.value
    }

    /// The area the page is sized for, in whole points: the screen area as it is, and no lower than it has stood at
    /// this width — what a keyboard, a note or the zoom row takes of its height still counts (none of them shrinks
    /// the page; BrowserPageZoom.sizedArea), whoever holds the tab just then.
    private var sizedArea: CGSize { BrowserPageZoom.sizedArea(now: area, sent: roomiest) }

    /// The tab is on another site: while this phone holds it, the page at that site's zoom (browser-v0 §1 页面缩放) —
    /// the size again when the zoom differs from the one last set.
    private func siteChanged() {
        guard mine, sizeSent != nil else { return }
        Task { [weak self] in await self?.sendSize() }
    }

    private func areaChanged(from old: CGSize) {
        noteRoom(old)
        screen.layout = layout
        relift()
        zoom = zoom.clamped(to: area)
        // Turned, or more room: the page follows, once things settle (never for a keyboard; sendSize).
        guard mine, old != .zero else { return }
        sizing?.cancel()
        sizing = Task { [weak self] in
            try? await Task.sleep(for: BrowserPageZoom.settle)
            guard !Task.isCancelled else { return }
            await self?.sendSize()
        }
    }

    /// The area just replaced is room the page has if it stood (BrowserPageZoom.roomiest: not the passing ones of a
    /// page being laid out as it opens): the roomiest of those is what the page is sized for when a keyboard, a note
    /// or the zoom row takes part of the area.
    private func noteRoom(_ replaced: CGSize) {
        let now = ContinuousClock.now
        let roomy = BrowserPageZoom.roomiest(roomiest, after: replaced, stood: areaSince.duration(to: now))
        if roomiest != roomy { roomiest = roomy }
        areaSince = now
    }

    /// While the keyboard is up, what was last touched stays in sight; down, the picture sits at the top again.
    private func relift() {
        guard let frameSize, phoneSized, typing, let y = touchedY else {
            if lift != 0 { lift = 0 }
            screen.layout = layout
            return
        }
        lift = BrowserLayout.lift(toShow: y * frameScale, frame: frameSize, areaWidth: area.width, visible: area.height)
        screen.layout = layout
    }

    // MARK: input

    /// A tap clicks there; on your own tab nobody holds, the phone takes it as it acts.
    func tap(at point: CGPoint) {
        guard let at = aim(point) else { return }
        touchedY = at.y / frameScale
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

    // MARK: the zoom key

    /// This phone sizes the tab: it holds it, or the tab is yours and nobody's for now (the phone takes it as it
    /// acts). Then the zoom key zooms the page (browser-v0 §1 页面缩放: only the screen that sizes a tab can); otherwise —
    /// an agent's tab not taken over, a tab held elsewhere — only the picture on the phone.
    var zoomsPage: Bool { canDrive }

    /// The page zoom in force (percent): what this phone remembers for the tab's site, as far as the area it sizes the
    /// page for allows; 100 for a site not zoomed and on a blank tab.
    var pageZoom: Int { BrowserPageZoom.inForce(remembered: store?.zoomMemory.percent(for: tab.site), area: sizedArea) }

    /// What the key says: the page's percent while this phone sizes the tab, the picture's while it only watches.
    var zoomPercent: Int { zoomsPage ? pageZoom : zoom.percent }

    /// What the stream's scale is multiplied by (BrowserStreamPolicy): the factor of the zoom this phone sets the page
    /// at, 1 while it only watches. The page asks the stream again when it changes.
    var streamZoom: Double { zoomsPage ? BrowserPageZoom.factor(pageZoom) : 1 }

    /// A step further in, or out, is there: at the end of the range its cap is off.
    var canZoomIn: Bool { zoomsPage ? pageStepIn != nil : zoom.stepIn != nil }
    var canZoomOut: Bool { zoomsPage ? pageStepOut != nil : zoom.stepOut != nil }

    func zoomIn() {
        if zoomsPage {
            if let next = pageStepIn { setPageZoom(next) }
        } else if let next = zoom.stepIn {
            stepPicture(to: next)
        }
    }

    func zoomOut() {
        if zoomsPage {
            if let next = pageStepOut { setPageZoom(next) }
        } else if let next = zoom.stepOut {
            stepPicture(to: next)
        }
    }

    /// The percent cap: back to 100% — the site's zoom forgotten, or the whole picture again.
    func zoomToStandard() {
        if zoomsPage { setPageZoom(BrowserPageZoom.standard) } else { resetZoom() }
    }

    /// The page's next step in and out; none at the end of what the area allows, nor on a blank tab (always 100%).
    private var pageStepIn: Int? { BrowserPageZoom.stepIn(from: pageZoom, site: tab.site, area: sizedArea) }
    private var pageStepOut: Int? { BrowserPageZoom.stepOut(from: pageZoom, site: tab.site, area: sizedArea) }

    /// The site's pages at `percent` from now on (remembered on this phone; 100% forgets it): the size again at once —
    /// the area did not change — and the phone's own zoom of the picture put back, since the page is laid out afresh
    /// and what was touched is no longer where it was. The stream is asked again by the page when its scale differs
    /// (streamZoom). Your own tab that nobody holds is taken, as when the phone acts on it.
    private func setPageZoom(_ percent: Int) {
        guard let store else { return }
        do { try store.rememberZoom(percent, for: tab.site) } catch { self.error = error.localizedDescription }
        zoom = .none
        touchedY = nil
        relift()
        #if DEBUG
        if api == nil { drawDemo() }
        #endif
        if mine { Task { [weak self] in await self?.sendSize() } } else { claim() }
    }

    /// While only watching: the picture on the phone at `scale`, as two fingers would leave it (not remembered).
    private func stepPicture(to scale: Double) {
        guard let picture = layout?.picture else { return }
        zoom = zoom.stepped(to: scale, picture: picture, area: area)
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
        guard drawDemo() else { return }
        connection = .live
        if UserDefaults.standard.string(forKey: "uiDemoScreen") == "browsertook" {
            touchedY = 210   // the password field of the mock login page
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.typing = true }
        }
    }

    /// The mock page as the Mac would send it now: a tab at this phone's size is its screen area over the page zoom
    /// (drawn again when the zoom key changes it). False: no mock page for this tab.
    @discardableResult
    private func drawDemo() -> Bool {
        let page = BrowserPageZoom.viewport(area: area, screenScale: 1, percent: pageZoom)
        guard let frame = DemoBrowser.frame(for: tab, size: phoneSized ? CGSize(width: page.width, height: page.height) : nil) else { return false }
        handle(.frame(frame))
        return true
    }
    #endif
}
