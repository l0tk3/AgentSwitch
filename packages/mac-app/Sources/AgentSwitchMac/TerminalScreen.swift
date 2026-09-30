import AgentSwitchMacCore
import AppKit
import OSLog
import SwiftTerm

/// `log show --predicate 'subsystem == "com.agentswitch.mac" && category == "terminal-screen"'`
private let screenLog = Logger(subsystem: "com.agentswitch.mac", category: "terminal-screen")

/// The terminal window's screen (docs/terminal-v0.md §1 Mac): SwiftTerm's own view, under the page, where the page
/// leaves the screen's area clear. It takes the keyboard as a Mac terminal does — the input method (Pinyin's candidates,
/// punctuation, Shift symbols), the kitty keyboard protocol, Option as Meta —, the mouse and the wheel (reported to a
/// program that tracks them, else its own scrollback), selection and copy, links. It reads the terminal's stream
/// itself and sends what it types in order; Shift+Enter goes by name, the service encoding it as the program asked.
final class NativeTerminalView: TerminalView {
    weak var owner: TerminalScreenController?

    /// A menu bar app has no Edit menu: ⌘C / ⌘V / ⌘A act here, the page's own shortcuts (⌘T, ⌘W, ⌘B, ⌘1–9, ⌘⇧V, ⌘↩ and
    /// ⌘⌫ on a request) go to the page.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self else { return super.performKeyEquivalent(with: event) }
        let mods = event.modifierFlags.intersection([.shift, .control, .option, .command])
        guard mods.contains(.command), !mods.contains(.control), !mods.contains(.option), let key = event.charactersIgnoringModifiers?.lowercased() else {
            return super.performKeyEquivalent(with: event)
        }
        let shift = mods.contains(.shift)
        if !shift {
            switch key {
            case "c": copy(self); return true
            case "v": paste(self); return true
            case "a": selectAll(self); return true
            default: break
            }
        }
        let name = event.keyCode == 36 ? "Enter" : event.keyCode == 51 ? "Backspace" : key
        let page = shift ? ["v"] : ["t", "w", "b", "Enter", "Backspace", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
        guard page.contains(name) else { return super.performKeyEquivalent(with: event) }
        owner?.pageShortcut(name, shift: shift)
        return true
    }

    override func mouseDown(with event: NSEvent) {
        owner?.userActed()
        super.mouseDown(with: event)
    }
}

/// Owns the native screen: which terminal it shows, its stream, what it sends, its size and look.
@MainActor
final class TerminalScreenController: NSObject {
    let view: NativeTerminalView
    /// The page (its shortcuts, the grid it starts terminals with).
    var evaluate: (String) -> Void = { _ in }
    private let client: () -> DaemonClient
    private var id: String?
    private var lastSeq = 0
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var parser = SSEParser()
    private var reconnect: DispatchWorkItem?
    /// Bytes typed since the last send, sent a few milliseconds later together, one request after another.
    private var pending: [UInt8] = []
    private var flushScheduled = false
    private var sending: Task<Void, Never>?
    private var resizeWork: DispatchWorkItem?
    /// The user's look, put back after every reset (a reset takes the terminal's colours back to its defaults).
    private var style: TerminalStyle = .fallback
    private var keyMonitor: Any?

    init(client: @escaping () -> DaemonClient) {
        self.client = client
        view = NativeTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 500), font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular))
        super.init()
        view.owner = self
        // Layer-backed from the start: SwiftTerm paints the default background as the layer's colour.
        view.wantsLayer = true
        view.terminalDelegate = self
        view.optionAsMetaKey = true
        view.allowMouseReporting = true
        view.nativeBackgroundColor = .black
        view.nativeForegroundColor = NSColor(white: 0.9, alpha: 1)
        view.isHidden = true
        // SwiftTerm's keyDown cannot be overridden from here: the keys it should not see are taken before it does.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            nonisolated(unsafe) let key = event
            let taken = MainActor.assumeIsolated { self?.takes(key) ?? false }
            return taken ? nil : event
        }
        loadStyle()
    }

    /// The window closes: nothing more to show or watch.
    func stop() {
        show(nil)
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
    }

    /// A key for this screen: Shift+Enter is a new line by name (the service encodes it as the program asked), taken
    /// from SwiftTerm; any key makes this window the one that sets the size.
    private func takes(_ event: NSEvent) -> Bool {
        guard let window = view.window, event.window === window, window.firstResponder === view else { return false }
        userActed()
        let mods = event.modifierFlags.intersection([.shift, .control, .option, .command])
        // Return with Shift alone, not while an input method composes (its Return picks the candidate).
        guard event.keyCode == 36, mods == .shift, !view.hasMarkedText() else { return false }
        namedKey("shift-enter")
        return true
    }

    #if DEBUG
    var probeShown: String? { id }
    var probeSeq: Int { lastSeq }
    #endif

    // MARK: what it shows

    /// Where the screen is in the page (its coordinates, top left origin); its grid follows from it. Also while no
    /// terminal is shown, so a new one starts at this size.
    func place(_ rect: CGRect?) {
        guard let rect, rect.width > 20, rect.height > 20 else { return }
        if view.frame != rect { view.frame = rect }
        let t = view.getTerminal()
        evaluate("window.agentswitch?.grid(\(t.cols), \(t.rows))")
    }

    /// Show terminal `id` (nil: none, the page shows its new-terminal panel there).
    func show(_ id: String?) {
        guard id != self.id else {
            view.isHidden = id == nil
            return
        }
        disconnect()
        self.id = id
        view.isHidden = id == nil
        guard let id else { return }
        clear()
        lastSeq = 0
        connect(id, after: nil)
        focus()
    }

    func focus() {
        guard id != nil, let window = view.window, window.isKeyWindow else { return }
        window.makeFirstResponder(view)
    }

    /// A line of the page's own under the program's output ("1 secret sealed").
    func note(_ text: String) { view.feed(text: "\r\n\u{1b}[2m[\(text)]\u{1b}[0m\r\n") }

    /// The window became the one in use, or the user typed or clicked here: this window sets the size again.
    func userActed() { reclaim() }

    func reclaim() {
        guard id != nil, view.window?.isKeyWindow == true else { return }
        // SwiftTerm fits its grid to the frame when the frame is set: after following another screen's size, setting the
        // same frame brings the grid back to this one (and sizeChanged tells the service).
        view.setFrameSize(view.frame.size)
    }

    // MARK: the stream

    private func connect(_ id: String, after: Int?) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60 * 60 * 24
        config.timeoutIntervalForResource = 60 * 60 * 24 * 7
        let session = URLSession(configuration: config, delegate: StreamDelegate(self), delegateQueue: .main)
        self.session = session
        parser = SSEParser()
        let task = session.dataTask(with: client().terminalStreamRequest(id: id, after: after))
        self.task = task
        task.resume()
    }

    private func disconnect() {
        reconnect?.cancel()
        reconnect = nil
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    fileprivate func received(_ data: Data, from task: URLSessionDataTask) {
        guard task === self.task else { return }
        for message in parser.feed(data) {
            guard let event = TerminalStreamEvent.decode(event: message.event, data: message.data) else { continue }
            handle(event)
        }
    }

    fileprivate func ended(_ task: URLSessionTask, error: Error?) {
        guard task === self.task, let id else { return }
        screenLog.notice("stream of \(id, privacy: .public) ended: \(error?.localizedDescription ?? "closed", privacy: .public)")
        // The service restarted or the connection dropped: again, from what this screen already has.
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.id == id else { return }
            self.connect(id, after: self.lastSeq > 0 ? self.lastSeq : nil)
        }
        reconnect = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
    }

    private func handle(_ event: TerminalStreamEvent) {
        let terminal = view.getTerminal()
        switch event {
        case .snapshot(let seq, let cols, let rows, let data):
            clear()
            follow(cols: cols, rows: rows)
            view.feed(text: data)
            lastSeq = seq
            // Drawn at the size it had; now this window's size when it is the one in use, else a fresh drawing (a
            // snapshot drops what the agent drew as links).
            let before = (terminal.cols, terminal.rows)
            reclaim()
            if let id, (terminal.cols, terminal.rows) == before {
                let c = client()
                Task { try? await c.redrawTerminal(id: id) }
            }
        case .output(let seq, let data):
            guard seq > lastSeq else { return }
            view.feed(text: data)
            lastSeq = seq
        case .resize(let cols, let rows):
            follow(cols: cols, rows: rows)
        case .exit(let code):
            view.feed(text: "\r\n\u{1b}[2m[exited · code \(code.map(String.init) ?? "?")]\u{1b}[0m\r\n")
        case .removed:
            disconnect()
        case .status:
            break
        }
    }

    /// Another screen's size (or the one the snapshot was drawn at): the buffer takes it, the view stays.
    private func follow(cols: Int, rows: Int) {
        let terminal = view.getTerminal()
        guard cols != terminal.cols || rows != terminal.rows else { return }
        terminal.resize(cols: cols, rows: rows)
        view.needsDisplay = true
    }

    // MARK: what it sends

    fileprivate func typed(_ bytes: ArraySlice<UInt8>) {
        guard id != nil else { return }
        pending.append(contentsOf: bytes)
        guard !flushScheduled else { return }
        flushScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.004) { [weak self] in self?.flush() }
    }

    private func flush() {
        flushScheduled = false
        guard let id, !pending.isEmpty else { pending.removeAll(); return }
        let data = String(decoding: pending, as: UTF8.self)
        pending.removeAll(keepingCapacity: true)
        inOrder { try await $0.writeTerminal(id: id, data: data) }
    }

    /// A key the service encodes as the program asked (keys.ts), after what was typed before it.
    func namedKey(_ name: String) {
        guard let id else { return }
        flush()
        inOrder { try await $0.terminalKeys(id: id, [name]) }
    }

    private func inOrder(_ send: @escaping @Sendable (DaemonClient) async throws -> Void) {
        let before = sending
        let c = client()
        sending = Task {
            await before?.value
            do { try await send(c) } catch { screenLog.error("send: \(error.localizedDescription, privacy: .public)") }
        }
    }

    func pageShortcut(_ key: String, shift: Bool) {
        let arg = (try? JSONEncoder().encode(key)).map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
        evaluate("window.agentswitch?.shortcut(\(arg), \(shift))")
    }

    fileprivate func sized(cols: Int, rows: Int) {
        evaluate("window.agentswitch?.grid(\(cols), \(rows))")
        guard let id, view.window?.isKeyWindow == true else { return }
        resizeWork?.cancel()
        let c = client()
        let work = DispatchWorkItem { Task { try? await c.resizeTerminal(id: id, cols: cols, rows: rows) } }
        resizeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: work)
    }

    // MARK: the look

    /// The user's iTerm profile, as the page and the phone draw it (`GET /terminals/style`).
    private func loadStyle() {
        let c = client()
        Task { [weak self] in
            let style = (try? await c.terminalStyle()) ?? .fallback
            self?.apply(style)
        }
    }

    private func apply(_ style: TerminalStyle) {
        self.style = style
        view.font = Self.font(style.families, size: CGFloat(style.fontSize))
        colors()
        reclaim()
    }

    /// Empty, in the user's colours.
    private func clear() {
        view.getTerminal().resetToInitialState()
        colors()
    }

    private func colors() {
        let color = { (text: String?) -> NSColor? in
            text.flatMap(TerminalStyle.rgba).map { NSColor(srgbRed: $0.red, green: $0.green, blue: $0.blue, alpha: $0.alpha) }
        }
        if let bg = color(style.theme.background) { view.nativeBackgroundColor = bg }
        if let fg = color(style.theme.foreground) { view.nativeForegroundColor = fg }
        if let cursor = color(style.theme.cursor) { view.caretColor = cursor }
        if let selection = color(style.theme.selectionBackground) { view.selectedTextBackgroundColor = selection }
        if let ansi = style.theme.ansi?.compactMap(TerminalStyle.rgba), ansi.count == 16 {
            view.installColors(ansi.map { SwiftTerm.Color(red: UInt16($0.red * 65535), green: UInt16($0.green * 65535), blue: UInt16($0.blue * 65535)) })
        }
        view.needsDisplay = true
    }

    /// The first family of the stack this Mac has (`ui-monospace`, `monospace`: the system's).
    static func font(_ families: [String], size: CGFloat) -> NSFont {
        for family in families {
            switch family.lowercased() {
            case "ui-monospace", "monospace", "sf mono": return NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
            default:
                if let font = NSFontManager.shared.font(withFamily: family, traits: [], weight: 5, size: size) ?? NSFont(name: family, size: size) { return font }
            }
        }
        return NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }
}

extension TerminalScreenController: @preconcurrency TerminalViewDelegate {
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) { sized(cols: newCols, rows: newRows) }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    /// What the screen types, reports or answers: to the program.
    func send(source: TerminalView, data: ArraySlice<UInt8>) { typed(data) }
    func scrolled(source: TerminalView, position: Double) {}
    /// Web links open in the browser; a folder link opens in Finder, a file link is only shown there (it comes from an
    /// agent's output, and opening a file can run it); nothing else.
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link) else { return }
        LinkOpener.open(url)
    }
    func bell(source: TerminalView) {}
    func clipboardCopy(source: TerminalView, content: Data) {
        guard let text = String(data: content, encoding: .utf8) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

/// The stream's delegate (URLSession keeps it strongly; it keeps the screen weakly). Called on the main queue.
private final class StreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    weak var screen: TerminalScreenController?

    init(_ screen: TerminalScreenController) { self.screen = screen }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        MainActor.assumeIsolated { screen?.received(data, from: dataTask) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated { screen?.ended(task, error: error) }
    }
}
