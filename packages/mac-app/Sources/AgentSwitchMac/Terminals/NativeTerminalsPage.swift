import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The main window's Terminals page, natively (docs/terminal-v0.md §1 Mac, 2026-10-05; user: terminal全都改成原生): the
/// list, the panes with their native screens, the new-terminal panel, the cards and the questions, all without a web
/// view and without signing in to the console (the app's own client and its local token). The model (TerminalsModel)
/// holds what is on the page; this object stands between it and the window: the bar's and the status bar's words
/// (`head`), the keyboard, the page's keys, and whether the page is seen.
/// One per open window: the window closing stops it (the terminals run on: the service holds them).
@MainActor
final class NativeTerminalsPage: NSObject, TerminalsPage {
    weak var window: NSWindow? { didSet { if window != nil, keyMonitor == nil { watchKeys() } } }
    let head = TerminalHead()
    let model: TerminalsModel
    private let host: NSHostingView<TerminalsPageView>
    var pageView: NSView { host }
    var pageRefreshing: () -> Bool = { false } { didSet { model.pageRefreshing = pageRefreshing } }
    private(set) var title: String?
    var onTitle: () -> Void = {}
    var onDetach: (String) -> Void = { _ in } { didSet { model.onDetach = onDetach } }
    var onAttach: (String) -> Void = { _ in } { didSet { model.onAttach = onAttach } }
    var onRaise: (String) -> Void = { _ in } { didSet { model.onRaise = onRaise } }
    /// The Terminals page is the one on screen: it has the keyboard and is read from the service; under another page it
    /// keeps its screens' streams but takes nothing.
    var onScreen = false { didSet { if onScreen != oldValue { seenChanged() } } }
    private var visible = true
    private var keyMonitor: Any?
    private var stopped = false

    init(model appModel: AppModel) {
        model = TerminalsModel(client: { appModel.client }, defaults: Self.defaults)
        host = NSHostingView(rootView: TerminalsPageView(model: model))
        host.sizingOptions = []
        super.init()
        model.onFocusScreen = { [weak self] pane in self?.focusScreen(pane) }
        model.onGround = { [weak self] color in
            if self?.head.ground != color { self?.head.ground = color }
        }
        model.onScreenKey = { [weak self] key, shift, alt in self?.screenKey(key, shift: shift, alt: alt) }
        follow()
    }

    /// What the page remembers is the user's; a probe's page remembers nothing.
    private static var defaults: UserDefaults? {
        #if DEBUG
        if MainWindowController.probing { return nil }
        #endif
        return .standard
    }

    // MARK: what the window asks

    func load(terminal id: String?) {
        if let id { model.show(terminal: id) }
        seenChanged()
    }

    func show(terminal id: String) { model.show(terminal: id) }
    func toggleList() { model.toggleList() }
    func seal() { model.focused?.session?.toggleSeal() }
    func split(_ side: String) { model.split(side == "down" ? .bottom : .right) }
    func newTerminal() { model.showCreate() }
    func toggleView() { model.toggleSimple() }
    func setDetached(_ ids: Set<String>) { model.setDetached(ids) }
    func detachShown() { if let id = model.current?.id { onDetach(id) } }

    /// ⌘1–9 from another page.
    func shortcut(_ key: String) {
        if let number = Int(key) { _ = model.perform(.select(number)) }
    }

    func pageDrawsIn() { for pane in model.panes.values { pane.screen.pageDrawsIn() } }

    var watching: Set<String> {
        guard onScreen, let window, window.isKeyWindow, window.isVisible else { return [] }
        return Set(model.panes.values.compactMap(\.screen.shown))
    }

    func windowKeyChanged(_ key: Bool) {
        // Brought to the front: each terminal's size is this window's when nobody else has it.
        guard key, onScreen else { return }
        for pane in model.panes.values { pane.screen.windowBecameKey() }
    }

    func windowVisible(_ visible: Bool) {
        guard visible != self.visible else { return }
        self.visible = visible
        seenChanged()
    }

    private func seenChanged() {
        guard !stopped else { return }
        model.setActive(onScreen && visible)
        guard onScreen else { return }
        if window?.isKeyWindow == true { for pane in model.panes.values { pane.screen.windowBecameKey() } }
        focus()
    }

    /// The keyboard to the terminal on screen; while a terminal is being made or the page asks something, off it.
    func focus() {
        guard onScreen else { return }
        focusScreen(model.focusPane)
    }

    private func focusScreen(_ pane: Int) {
        guard onScreen, let window, model.sheet == nil, model.renaming == nil else { return }
        // A pane that shows a record: the keyboard to its reply box.
        if let state = model.panes[pane], state.simple, state.session != nil, !model.creating {
            if window.firstResponder is NativeTerminalView { window.makeFirstResponder(nil) }
            state.record.focusReply()
            return
        }
        let screen = model.panes[pane]?.screen
        // A field that is going away may still hold the keyboard: off it first.
        if window.firstResponder !== screen?.view { window.makeFirstResponder(nil) }
        guard !model.creating, let screen, screen.shown != nil else { return }
        screen.focus()
    }

    func stop() {
        stopped = true
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        model.stop()
    }

    // MARK: the bar's words

    /// The bar's and the status bar's words from what the page shows, again whenever any of it changes.
    private func follow() {
        withObservationTracking { tell() } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, !self.stopped else { return }
                self.follow()
            }
        }
    }

    private func tell() {
        let terminal = model.current
        let session = model.focused?.session
        let name = terminal.map { TerminalWindowText.folder($0.workdir) } ?? ""
        let git = terminal.flatMap { model.gits[$0.workdir] }.map(TerminalWindowText.git) ?? ""
        let help = terminal.map { [$0.name, DisplayPath.short($0.workdir, home: NSHomeDirectory())].filter { !$0.isEmpty }.joined(separator: " · ") } ?? ""
        if head.name != name { head.name = name }
        if head.git != git { head.git = git }
        if head.help != help { head.help = help }
        if head.status != terminal?.status { head.status = terminal?.status }
        let mark = TerminalListText.mark(model.terminals)
        let state = PixelArt.MarkState(page: mark.state)
        if head.mark != state { head.mark = state }
        if head.tag != mark.tag { head.tag = mark.tag }
        let simple = model.focusedSimple
        if head.simple != simple { head.simple = simple }
        let light = model.focusedLight
        if head.light != light { head.light = light }
        var context = terminal == nil ? nil : session?.context
        context?.simple = simple
        if head.context != context { head.context = context }
        let width = model.sideClosed ? 0 : model.sideWidth + 1
        if head.sideWidth != width { head.sideWidth = width }
        let next = model.creating || terminal == nil ? "New Terminal" : TerminalWindowText.title(folder: name, name: terminal?.name ?? "")
        if title != next {
            title = next
            onTitle()
        }
        // A terminal being made, a question asked: the screen gives the keyboard up.
        if model.creating || model.sheet != nil, let window, window.firstResponder is NativeTerminalView { window.makeFirstResponder(nil) }
    }

    // MARK: keys

    /// The page's keys, taken before the screen or a field sees them (a menu bar app has no menu to carry them).
    private func watchKeys() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            nonisolated(unsafe) let key = event
            let taken = MainActor.assumeIsolated { self?.handle(key) ?? false }
            return taken ? nil : event
        }
    }

    private func handle(_ event: NSEvent) -> Bool {
        guard onScreen, let window, event.window === window, window.attachedSheet == nil else { return false }
        let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
        let press = ItemWindowKey.Press(key: event.charactersIgnoringModifiers?.lowercased() ?? "", keyCode: event.keyCode, command: flags.contains(.command),
                                        control: flags.contains(.control), option: flags.contains(.option), shift: flags.contains(.shift))
        return take(press, in: window)
    }

    private func take(_ press: ItemWindowKey.Press, in window: NSWindow) -> Bool {
        let responder = window.firstResponder
        let editing = (responder as? NSText)?.isEditable == true
        let plain = (responder as? NSTextView)?.delegate is PlainTextField
        let marking = (responder as? NSTextInputClient)?.hasMarkedText() ?? false
        // The page's question: ↩ answers yes, esc no; its own field keeps its keys.
        if let sheet = model.sheet, !press.command, !press.control, !press.option {
            guard !plain, !marking else { return false }
            if press.keyCode == 36 {
                if sheet.offers == nil || !model.sheetFolder.trimmingCharacters(in: .whitespaces).isEmpty { model.answerSheet(ok: true) }
            } else if press.keyCode == 53 {
                model.answerSheet(ok: false)
            }
            return true
        }
        let session = model.creating ? nil : model.focused?.session
        // A record in the pane in focus: esc stops the agent while it works, as it does in the terminal (a card's keys
        // and a composition come first).
        if model.focusedSimple, press.keyCode == 53, !press.command, !press.option, !press.shift, !plain, !marking,
           session?.info?.status == "working", !(session?.cardHasKeys ?? false), !(session?.composing ?? false) {
            model.focused?.record.interrupt()
            return true
        }
        let inSeal = editing && !plain && (session?.composing ?? false) && (session?.sealFocused ?? false)
        guard let key = TerminalsPageKey.action(for: press, editing: editing, plainField: plain, marking: marking, inSeal: inSeal,
                                                cardHasKeys: session?.cardHasKeys ?? false, creating: model.creating) else { return false }
        if case .item(let item) = key {
            if let session { return session.perform(item, in: window) }
            // No terminal on screen: only a field's edit keys have somewhere to go.
            if case .edit(let name) = item { return NSApp.sendAction(Selector((name)), to: nil, from: window) }
            return false
        }
        return model.perform(key)
    }

    /// A key the screen hands over by its name (it takes the page's ⌘ keys as key equivalents).
    private func screenKey(_ key: String, shift: Bool, alt: Bool) {
        guard let window else { return }
        let codes: [String: UInt16] = ["Enter": 36, "Backspace": 51, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126]
        _ = take(ItemWindowKey.Press(key: codes[key] == nil ? key : "", keyCode: codes[key] ?? 0, command: true, option: alt, shift: shift), in: window)
    }

    #if DEBUG
    var probeScreen: TerminalScreenController? { model.focused?.screen }
    var probeScreens: [Int: TerminalScreenController] { model.panes.mapValues(\.screen) }
    var probeWeb: TerminalWebView? { nil }
    #endif
}
