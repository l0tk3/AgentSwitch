import AgentSwitchMacCore
import AppKit
import SwiftUI

/// What a menu asks of the main window (MainWindowController.menu): the bar's, the rail's and the window's own actions.
enum AppMenuCommand: Equatable {
    case page(MainPage), nextPage, previousPage
    case newTerminal, newChannel, newTab, passwords, files, toggleRail
    case toggleView, split(String)
}

/// The menus across the top of the screen while AgentSwitch is in front (user #584: 这个功能栏里应该做一些真东西进去).
/// Nothing new: every item is something the app already does somewhere — a button in the bar, the rail, a page, the
/// settings — with the key it already has. The keys are still taken first where they were (the windows' own key
/// handlers, MainShortcut and TerminalsPageKey): a menu's key acts only where no window took it, as in the settings
/// window, and does the same thing there. An item that has nothing to act on is dimmed.
struct AppMenus: Commands {
    let delegate: AppDelegate
    @AppStorage(InterfaceLook.key) private var appearance = InterfaceLook.pixel.rawValue
    @AppStorage("terminals.recordSide") private var recordSide = true

    private var main: MainWindowController { delegate.main }
    private var page: MainPage { main.state.page }

    var body: some Commands {
        // AgentSwitch: About (the system's) · Check for Updates… · Settings… ⌘, · … · Quit (the system's, asked first).
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") { delegate.settings.show(.general) }
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { delegate.settings.show(nil) }.keyboardShortcut(",", modifiers: .command)
        }

        // File.
        CommandGroup(replacing: .newItem) {
            Button("New Terminal") { main.menu(.newTerminal) }.keyboardShortcut("t", modifiers: .command)
            Button("New Channel") { main.menu(.newChannel) }
            Button("New Tab") { main.menu(.newTab) }
        }

        // View: the Terminals page's views and panes, the Files column, the rail, the look and the text.
        CommandGroup(before: .toolbar) {
            Button("Simple View / Terminal View") { main.menu(.toggleView) }
                .keyboardShortcut("e", modifiers: [.command, .shift]).disabled(page != .terminals)
            Button(recordSide ? "Hide Side Pane" : "Show Side Pane") { recordSide.toggle() }
                .disabled(page != .terminals)
            Button("Split Right") { main.menu(.split("right")) }
                .keyboardShortcut("d", modifiers: .command).disabled(page != .terminals)
            Button("Split Down") { main.menu(.split("down")) }
                .keyboardShortcut("d", modifiers: [.command, .shift]).disabled(page != .terminals)
            Divider()
            Button("Show or Hide Files") { main.menu(.files) }.keyboardShortcut("f", modifiers: [.command, .shift])
            Button(main.state.railHidden ? "Show Rail" : "Hide Rail") { main.menu(.toggleRail) }.keyboardShortcut("b", modifiers: [.command, .option])
            Divider()
            Picker("Appearance", selection: $appearance) {
                ForEach(InterfaceLook.allCases, id: \.self) { Text($0.label).tag($0.rawValue) }
            }
            Menu("Text Size") {
                Button("Bigger") { TextScale.shared.set(TextScale.shared.step + 1) }
                    .disabled(TextScale.shared.step >= TextSize.steps.upperBound)
                Button("Smaller") { TextScale.shared.set(TextScale.shared.step - 1) }
                    .disabled(TextScale.shared.step <= TextSize.steps.lowerBound)
                Button("Actual Size") { TextScale.shared.set(0) }.disabled(TextScale.shared.step == 0)
            }
        }

        // Help: the system's search alone — the app has no help book, and `AgentSwitch Help` would only say so.
        CommandGroup(replacing: .help) {}

        // Go: the pages in the rail's order, with their keys; the password book.
        CommandMenu("Go") {
            ForEach(MainPage.allCases, id: \.self) { item in
                pageItem(item)
            }
            Divider()
            Button("Next Page") { main.menu(.nextPage) }.keyboardShortcut(.tab, modifiers: .control)
            Button("Previous Page") { main.menu(.previousPage) }.keyboardShortcut(.tab, modifiers: [.control, .shift])
            Divider()
            Button("Passwords") { main.menu(.passwords) }.keyboardShortcut("l", modifiers: [.command, .shift])
        }
    }

    /// A page with the key that goes there (Terminals has none of its own: ⌘1–9 go to a terminal).
    @ViewBuilder
    private func pageItem(_ item: MainPage) -> some View {
        let button = Button(item.title) { main.menu(.page(item)) }
        switch item {
        case .dispatch: button.keyboardShortcut("0", modifiers: .command)
        case .rooms: button.keyboardShortcut("m", modifiers: [.command, .shift])
        case .browser: button.keyboardShortcut("b", modifiers: [.command, .shift])
        case .clash: button.keyboardShortcut("k", modifiers: [.command, .shift])
        case .terminals: button
        }
    }
}
