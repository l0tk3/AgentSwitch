import AgentSwitchMacCore
import AppKit

/// The main window's Terminals page as the window uses it: the native page (NativeTerminalsPage, 2026-10-05), or — by
/// a hidden default kept as a way back for now — the daemon's page in a web view (TerminalsPageController).
@MainActor
protocol TerminalsPage: AnyObject {
    var window: NSWindow? { get set }
    /// What the bar and the status bar show of the terminals.
    var head: TerminalHead { get }
    /// The page itself, for the window's page container.
    var pageView: NSView { get }
    var pageRefreshing: () -> Bool { get set }
    /// The window's name while the page is shown (the terminal on screen).
    var title: String? { get }
    var onTitle: () -> Void { get set }
    var onScreen: Bool { get set }
    /// The terminals on screen while the page is in use: their turns need no telling.
    var watching: Set<String> { get }
    var onDetach: (String) -> Void { get set }
    var onAttach: (String) -> Void { get set }
    var onRaise: (String) -> Void { get set }

    func load(terminal id: String?)
    func show(terminal id: String)
    func toggleList()
    func seal()
    func split(_ side: String)
    func newTerminal()
    func shortcut(_ key: String)
    func pageDrawsIn()
    func windowKeyChanged(_ key: Bool)
    /// The window is seen (on screen, not minimised or covered) or not.
    func windowVisible(_ visible: Bool)
    func focus()
    func stop()
    func setDetached(_ ids: Set<String>)
    func detachShown()

    #if DEBUG
    var probeScreen: TerminalScreenController? { get }
    var probeScreens: [Int: TerminalScreenController] { get }
    var probeWeb: TerminalWebView? { get }
    #endif
}

extension TerminalsPage {
    /// The pane in focus as its session's record, or as the terminal again (the native page's; the web page has none).
    func toggleView() {}

    /// The hidden default that keeps the web page (`defaults write com.agentswitch.mac terminalsPageWeb -bool YES`).
    static var webKey: String { "terminalsPageWeb" }
}
