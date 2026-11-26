import AgentSwitchMacCore
import AppKit
import SwiftUI

// The side pane's `Browser` (docs/simple-view-v0.md §5.2 右侧栏, user #600): the tabs this terminal's agent has in the
// shared browser (or its profile's own), the one it is busy in or acted on last first — a small live picture of that
// one, then each tab's title and address. A click opens the tab on the Browser page. Not there while the agent has no
// tab; the picture's stream runs only while the block is seen.

/// What the side pane knows of one terminal's tabs: read every few seconds while its pane is on screen, and the first
/// tab's picture as a stream of a few small frames a second while the block is seen.
@MainActor @Observable
final class RecordBrowserWatch {
    private(set) var tabs = TerminalBrowserTabs.none
    /// The first tab's latest frame, and which tab it is of.
    private(set) var picture: NSImage?
    private(set) var pictureOf: String?

    @ObservationIgnored private var client: (() -> DaemonClient)?
    @ObservationIgnored private var terminal: String?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var streaming: (tab: String, browser: String?, options: BrowserStreamOptions)?
    @ObservationIgnored private var pictureWanted: BrowserStreamOptions?

    static let pollInterval = Duration.seconds(3)

    var top: BrowserTab? { tabs.tabs.first }

    /// Reads the terminal's tabs while `on` (its pane is on screen); stops, the stream too, when not.
    func follow(terminal: String?, client: @escaping () -> DaemonClient, on: Bool) {
        let same = terminal == self.terminal && pollTask != nil
        self.client = client
        if terminal != self.terminal { self.terminal = terminal; apply(.none) }
        #if DEBUG
        if terminal != nil, let staged = Self.previewTabs { apply(staged); picture = Self.previewPicture; pictureOf = staged.tabs.first?.id; return }
        #endif
        guard on, let terminal else { stop(); return }
        if same { return }
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let fresh = (try? await client().terminalBrowser(id: terminal)) ?? .none
                guard !Task.isCancelled else { return }
                self.apply(fresh)
                try? await Task.sleep(for: Self.pollInterval)
            }
        }
    }

    /// The block is seen (`options`: the stream it wants) or not (nil): the first tab's picture follows, or stops.
    func showPicture(_ options: BrowserStreamOptions?) {
        pictureWanted = options
        restream()
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        pictureWanted = nil
        restream()
    }

    private func apply(_ fresh: TerminalBrowserTabs) {
        if fresh != tabs { tabs = fresh }
        if pictureOf != nil, pictureOf != top?.id { picture = nil; pictureOf = nil }
        restream()
    }

    /// The stream for the first tab as wanted now; the one under way kept when it is that already.
    private func restream() {
        #if DEBUG
        if Self.previewTabs != nil { return }
        #endif
        let want = pictureWanted.flatMap { options in top.map { (tab: $0.id, browser: tabs.browser, options: options) } }
        if let want, let now = streaming, now.tab == want.tab, now.browser == want.browser, now.options == want.options { return }
        streamTask?.cancel()
        streamTask = nil
        streaming = want
        guard let want, let client else { return }
        let service = client().forBrowser(want.browser)
        streamTask = Task { [weak self] in
            do {
                for try await event in service.tabStream(id: want.tab, options: want.options) {
                    guard !Task.isCancelled, let self else { return }
                    self.handle(event, of: want.tab)
                }
            } catch {}
        }
    }

    private func handle(_ event: BrowserStreamEvent, of id: String) {
        switch event {
        case .frame(let frame):
            guard let data = Data(base64Encoded: frame.data), let image = NSImage(data: data) else { return }
            picture = image
            pictureOf = id
        case .closed:
            tabs = TerminalBrowserTabs(browser: tabs.browser, tabs: tabs.tabs.filter { $0.id != id })
            picture = nil
            pictureOf = nil
            restream()
        default:
            // Title, address, status: at once, not at the next read.
            guard let index = tabs.tabs.firstIndex(where: { $0.id == id }) else { return }
            let next = event.applied(to: tabs.tabs[index])
            if next != tabs.tabs[index] {
                var all = tabs.tabs
                all[index] = next
                tabs = TerminalBrowserTabs(browser: tabs.browser, tabs: all)
            }
        }
    }

    #if DEBUG
    /// The design preview's: every watch shows these tabs and this picture, as if the service had sent them.
    static var previewTabs: TerminalBrowserTabs?
    static var previewPicture: NSImage?
    #endif
}

struct RecordBrowserBlock: View {
    let watch: RecordBrowserWatch
    /// Opens a tab on the Browser page: its browser (nil the shared one) and its id.
    let open: (String?, String) -> Void
    @Environment(\.interfaceLook) private var look
    @Environment(\.onScreen) private var onScreen
    @Environment(\.displayScale) private var displayScale
    @State private var width: Double = 320
    @State private var seen = false

    var body: some View {
        let all = watch.tabs.tabs
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Browser").mono(Look.size(11.5, look), weight: .semibold).foregroundStyle(Look.ink)
                Spacer(minLength: 4)
                Text(all.count == 1 ? "1 tab" : "\(all.count) tabs").mono(Look.size(11, look)).foregroundStyle(Look.faint)
            }
            if let top = all.first {
                BrowserTabButton(action: { open(watch.tabs.browser, top.id) }) {
                    VStack(alignment: .leading, spacing: 6) {
                        picture(top)
                        row(top)
                    }
                }
                .help(top.url)
            }
            ForEach(all.dropFirst()) { tab in
                BrowserTabButton(action: { open(watch.tabs.browser, tab.id) }) { row(tab) }
                    .help(tab.url)
            }
        }
        .background(GeometryReader { g in Color.clear.onAppear { width = g.size.width }.onChange(of: g.size.width) { _, w in width = w } })
        .onAppear { seen = true; streamFollows() }
        .onDisappear { seen = false; watch.showPicture(nil) }
        .onChange(of: onScreen) { streamFollows() }
        .onChange(of: width) { streamFollows() }
    }

    private func streamFollows() {
        watch.showPicture(seen && onScreen ? TerminalBrowserTabs.stream(width: width, backingScale: displayScale) : nil)
    }

    /// The page as it is now, in the shape of its view; a spinner until the first frame.
    private func picture(_ tab: BrowserTab) -> some View {
        let shape = tab.viewport.width > 0 && tab.viewport.height > 0 ? Double(tab.viewport.width) / Double(tab.viewport.height) : 1.6
        let radius = look.isClassic ? Look.controlRadius : 0
        return ZStack {
            Rectangle().fill(Look.code)
            if let image = watch.pictureOf == tab.id ? watch.picture : nil {
                Image(nsImage: image).resizable().interpolation(.medium).aspectRatio(contentMode: .fit)
            } else {
                BrailleSpinner().foregroundStyle(Look.faint)
            }
        }
        .aspectRatio(shape, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .framed(Look.line, radius: radius)
    }

    /// Its state (busy, waiting, idle), its title, and where it is.
    private func row(_ tab: BrowserTab) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            StatusMark(level: tab.status == .busy ? .busy : tab.status == .waiting ? .warning : .off)
                .frame(width: 10)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            VStack(alignment: .leading, spacing: 1) {
                Text(BrowserTabText.title(tab)).mono(Look.size(12, look), weight: .medium).foregroundStyle(Look.ink).lineLimit(1)
                Text(BrowserTabText.waiting(tab) ?? BrowserTabText.place(tab))
                    .font(.system(size: Look.size(11, look), design: .monospaced))
                    .foregroundStyle(tab.status == .waiting ? Color.waiting : Look.faint).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
    }
}

/// A tab in the block: the whole of it is the button, `Look.hover` under the pointer.
private struct BrowserTabButton<Label: View>: View {
    let action: () -> Void
    @ViewBuilder let label: () -> Label
    @Environment(\.interfaceLook) private var look
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            label()
                .padding(4)
                .background(RoundedRectangle(cornerRadius: look.isClassic ? Look.controlRadius : 0, style: .continuous).fill(hovering ? Look.hover : Color.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(-4)
        .onHover { hovering = $0 }
    }
}
