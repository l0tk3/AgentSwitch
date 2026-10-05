import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The screen and its refresh in the window's middle, inset as on the main window's page (terminal.css `.screen`).
/// Top left origin, as the screen is placed. A drop on it — files, text, a web address — is pasted into the program.
final class ItemTerminalStage: NSView {
    private let screen: TerminalScreenController
    static let inset = NSEdgeInsets(top: 4, left: 16, bottom: 4, right: 4)
    /// The room on the screen's left: less in a pane among several.
    var leftInset: CGFloat = ItemTerminalStage.inset.left { didSet { if leftInset != oldValue { needsLayout = true } } }

    init(screen: TerminalScreenController) {
        self.screen = screen
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
        addSubview(screen.view)
        addSubview(screen.refresh)
        registerForDraggedTypes([.fileURL, .URL, .string])
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        let inset = Self.inset
        screen.place(CGRect(x: leftInset, y: inset.top, width: bounds.width - leftInset - inset.right, height: bounds.height - inset.top - inset.bottom))
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { screen.shown == nil ? [] : .copy }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool { screen.drop(sender.draggingPasteboard) }
}

/// One terminal in a window of its own (docs/dispatch-v0.md §1 单独的窗口; docs/terminal-v0.md §1, 2026-10-05). All
/// native: the terminal's screen as the main window has it (its own stream, its own screen id, so the size it holds is
/// this window's), the bars and what floats over the screen in SwiftUI (TerminalWindowViews). No rail, no list, nothing
/// to change to. Closing the window ends nothing: the service holds the terminal, and it stays in the main window's list.
@MainActor
final class TerminalWindowController: NSObject {
    let id: String
    let model: TerminalWindowModel
    let screen: TerminalScreenController
    private(set) var window: NSWindow?
    /// The window closed (by the user, or its terminal was deleted).
    var onClosed: () -> Void = {}
    /// ⌘T: a new terminal is the main window's to make.
    var newTerminal: () -> Void = {}
    private var keyMonitor: Any?
    private var observers: [NSObjectProtocol] = []

    static let sizeKey = "AgentSwitchTerminalWindowSize"

    init(id: String, client: @escaping () -> DaemonClient, info: TerminalInfo? = nil) {
        self.id = id
        model = TerminalWindowModel(id: id, client: client, info: info)
        screen = TerminalScreenController(client: client)
        screen.takesOnOpen = true
        super.init()
        wire()
    }

    /// The model and the screen, each told what the other knows.
    private func wire() {
        screen.onMessage = { [weak self] event, data in self?.model.received(event: event, data: data) }
        screen.onSize = { [weak self] grid, away in self?.model.screenSaid(grid: grid.map { [$0.cols, $0.rows] }, away: away) }
        screen.onClick = { [weak self] in self?.model.screenClicked() }
        screen.onGround = { [weak self] color in
            guard let self, self.model.ground != color else { return }
            self.model.ground = color
            self.window?.backgroundColor = color
        }
        // ⌘T from the screen; the rest of the main window's page shortcuts (its list, its panes) mean nothing here, and
        // the window's own are taken before the screen sees them (`handle`).
        screen.onShortcut = { [weak self] key, shift, _ in
            if key == "t", !shift { self?.newTerminal() }
        }
        model.onGone = { [weak self] in self?.close() }
        model.onNote = { [weak self] text in self?.screen.note(text) }
        model.onClaim = { [weak self] in self?.screen.claim() }
        model.onFocusScreen = { [weak self] in
            guard let self, let window = self.window else { return }
            // A field that is going away may still hold the keyboard: off it first.
            if window.firstResponder !== self.screen.view { window.makeFirstResponder(nil) }
            self.screen.focus()
        }
        model.onInfo = { [weak self] in
            guard let self else { return }
            self.window?.title = self.model.title
            self.screen.workdir = self.model.info?.workdir
        }
    }

    // MARK: the window

    func open(frame: NSRect) {
        guard window == nil else { return raise() }
        let window = Self.makeWindow(model: model, stage: ItemTerminalStage(screen: screen), frame: frame)
        self.window = window
        observe(window)
        watchKeys()
        model.start()
        screen.workdir = model.info?.workdir
        raise()
        // Shown once the window is the key one: a terminal opened in a window in use takes its size from it.
        screen.show(id)
    }

    /// The window as it is built: as the main window's — no toolbar, the content under the title bar, the bar drawn in
    /// its row —, always dark, in the terminal's ground.
    static func makeWindow(model: TerminalWindowModel, stage: NSView, frame: NSRect, as kind: NSWindow.Type = NSWindow.self) -> NSWindow {
        let window = kind.init(contentRect: NSRect(origin: .zero, size: frame.size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = model.title
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = model.ground
        window.isReleasedWhenClosed = false
        window.minSize = TerminalWindowPlace.minSize
        window.tabbingMode = .disallowed
        let barHeight = max(28, window.frame.height - window.contentLayoutRect.height)
        let host = NSHostingController(rootView: TerminalWindowRoot(model: model, stage: stage, barHeight: barHeight))
        host.sizingOptions = []
        window.contentViewController = host
        window.setFrame(frame, display: false)
        return window
    }

    func raise() {
        guard let window else { return }
        #if DEBUG
        if MainWindowController.probing { window.orderBack(nil); return }
        #endif
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func close() { window?.close() }

    /// The window is the one in use: its terminal's turns need no telling (the Live Activity).
    var watching: Bool {
        guard let window else { return false }
        return window.isKeyWindow && window.isVisible && !window.isMiniaturized
    }

    private func observe(_ window: NSWindow) {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.closed() }
        })
        for (name, key) in [(NSWindow.didBecomeKeyNotification, true), (NSWindow.didResignKeyNotification, false)] {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.model.windowKey = key
                    // Brought to the front: the terminal's size is this window's when nobody else has it.
                    if key {
                        self.screen.windowBecameKey()
                        if !self.model.composing, !self.model.cardHasKeys { self.screen.focus() }
                    }
                }
            })
        }
        observers.append(center.addObserver(forName: NSWindow.didEndLiveResizeNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.rememberSize() }
        })
    }

    /// The next window of this kind opens at this one's size.
    private func rememberSize() {
        guard let window, !window.styleMask.contains(.fullScreen) else { return }
        #if DEBUG
        if MainWindowController.probing { return }
        #endif
        UserDefaults.standard.set(NSStringFromSize(window.frame.size), forKey: Self.sizeKey)
    }

    private func closed() {
        rememberSize()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        model.stop()
        screen.stop()
        window = nil
        onClosed()
    }

    // MARK: keys

    /// The window's own keys, taken before the screen or a field sees them: a menu bar app has no menu to carry them.
    private func watchKeys() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            nonisolated(unsafe) let key = event
            let taken = MainActor.assumeIsolated { self?.handle(key) ?? false }
            return taken ? nil : event
        }
    }

    private func handle(_ event: NSEvent) -> Bool {
        guard let window, event.window === window, window.attachedSheet == nil else { return false }
        let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        let editing = (window.firstResponder as? NSText)?.isEditable == true
        // An input method's Return and Esc are its own (they pick or drop a candidate).
        let marking = (window.firstResponder as? NSTextInputClient)?.hasMarkedText() ?? false
        let press = ItemWindowKey.Press(key: key, keyCode: event.keyCode, command: flags.contains(.command), control: flags.contains(.control),
                                        option: flags.contains(.option), shift: flags.contains(.shift))
        guard let action = ItemWindowKey.action(for: press, editing: editing, marking: marking, inSeal: editing && model.composing && model.sealFocused,
                                                cardHasKeys: model.cardHasKeys) else { return false }
        switch action {
        case .close: window.performClose(nil)
        case .newTerminal: newTerminal()
        default: return model.perform(action, in: window)
        }
        return true
    }
}

extension TerminalWindowModel {
    /// A key of the cards', the sealed reply's or a field's, done for this terminal (ItemWindowKey; the window's own
    /// two — closing it, a new terminal — are the caller's).
    func perform(_ action: ItemWindowKey, in window: NSWindow) -> Bool {
        switch action {
        case .close, .newTerminal: return false
        case .seal: toggleSeal()
        case .primary: return primaryKey()
        case .deny: return denyKey()
        case .send: send()
        case .closeSeal: closeSeal()
        case .newLine: return NSApp.sendAction(#selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)), to: nil, from: nil)
        case .leaveField: window.makeFirstResponder(nil)
        case .giveKeysBack: giveKeysBack()
        case .number(let n): return numberKey(n)
        case .question(let step): return moveQuestion(by: step)
        case .swallow: break
        case .edit(let name): return NSApp.sendAction(Selector((name)), to: nil, from: window)
        }
        return true
    }
}
