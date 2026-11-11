#if DEBUG
import AgentSwitchMacCore
import AppKit

/// `-shellProbe <dir> -probeTerminal <id> -localPort <port>` with AGENTSWITCH_HOME of a throw-away service (debug
/// builds; docs/terminal-v0.md §0, 2026-11-10): the real main window on that terminal, behind every other window, and
/// then a shell opened as a person opens one — the new-terminal panel, `Shell`, a folder, Start — with the list
/// filtered to another agent's terminals, as a list may be. `shell.txt` says after each step what the page held: what
/// the panel offered, the terminal made and where it is shown, the filter, what its screen said to a line typed into it
/// as keys are, and that it has one view (no record).
@MainActor
enum ShellProbe {
    static var directory: URL? { UserDefaults.standard.string(forKey: "shellProbe").map { URL(fileURLWithPath: $0) } }

    static func run(_ main: MainWindowController, model: AppModel, into dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var lines: [String] = []
        func say(_ line: String) {
            lines.append(line)
            try? lines.joined(separator: "\n").appending("\n").write(to: dir.appendingPathComponent("shell.txt"), atomically: true, encoding: .utf8)
        }
        func until(_ seconds: Double, _ done: () -> Bool) async -> Bool {
            let end = Date().addingTimeInterval(seconds)
            while Date() < end {
                if done() { return true }
                try? await Task.sleep(for: .milliseconds(100))
            }
            return done()
        }
        func text(_ screen: TerminalScreenController?) -> String {
            guard let screen else { return "" }
            let t = screen.view.getTerminal()
            return (0..<t.rows).compactMap { row -> String? in
                guard let line = t.getLine(row: row) else { return nil }
                return String((0..<line.count).map { t.getCharacter(for: line[$0]) }).trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "\0")))
            }.joined(separator: "\n")
        }
        Task {
            guard let first = UserDefaults.standard.string(forKey: "probeTerminal") else { say("FAIL no terminal to open the window on"); exit(1) }
            model.probeServiceUp()
            MainWindowController.probing = true   // opened without making the app active, behind the other windows
            main.show(terminal: first)
            MainWindowController.probing = false
            guard await until(20, { main.probeTerminals?.current?.id == first }), let page = main.probeTerminals else { say("FAIL the page did not show \(first)"); exit(1) }
            say("ok   the window is on \(first): \(page.current?.harness ?? "-") \"\(page.current?.name ?? "-")\"")
            say("\(page.shellOffered ? "ok  " : "FAIL") the service offers a shell here: \(page.shellOffered); agents \(page.agents)")

            // The list as a person may have it: one agent's alone. What is made next is not that agent's.
            page.filter = TerminalListFilter(agent: "claude-code", active: true)
            let folder = (page.current?.cwd ?? NSHomeDirectory())
            page.showCreate(folder: folder)
            page.pickedAgent = TerminalKind.shell
            say("\(page.creating && page.pickedShell ? "ok  " : "FAIL") the panel is open with Shell picked: creating \(page.creating), picked \(page.pickedAgent), folder \(page.folderText)")
            page.start()
            let made = await until(20) { !page.creating && page.current.map { $0.id != first && $0.harness == TerminalKind.shell } == true }
            guard made, let shell = page.current else { say("FAIL no shell was made: \(page.createError.isEmpty ? "(no reason given)" : page.createError)"); exit(1) }
            say("ok   made: \(shell.id) \(shell.harness) \"\(shell.name)\" \(shell.status), in the pane in focus: \(TerminalPanes.pane(page.layout, page.focusPane)?.term == shell.id)")
            say("\(page.filter == TerminalListFilter(agent: nil, active: true) ? "ok  " : "FAIL") the list's filter after it was made: agent \(page.filter.agent ?? "none"), active \(page.filter.active)")
            let listed = page.rows.contains { if case .terminal(let t, _, _, _) = $0 { t.id == shell.id } else { false } }
            say("\(listed ? "ok  " : "FAIL") it is in the list: \(listed)")

            // Its screen: what the shell drew, then a line typed as keys are.
            let screen = page.focused?.screen
            let drew = await until(20) { screen?.probeShown == shell.id && !text(screen).isEmpty }
            say("\(drew ? "ok  " : "FAIL") its screen shows it and has drawn: shows \(screen?.probeShown ?? "-"), \(text(screen).count) characters")
            // What it answers is read without its spaces and line ends: a long folder wraps on the screen, and a row's
            // end is cut where it does (2026-11-10: the answer was there, on two rows, and was not found).
            func flat(_ s: String) -> String { String(String.UnicodeScalarView(s.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) })) }
            let wanted = flat("typed-42 in \(folder)")
            screen?.view.send(txt: "echo typed-$((6*7)) in $PWD\r")
            let answered = await until(15) { flat(text(screen)).contains(wanted) }
            let rows = text(screen).split(separator: "\n").map(String.init)
            let said = rows.lastIndex { $0.contains("typed-42") }.map { rows[$0...].prefix(3).joined(separator: " ⏎ ") } ?? "(not on the screen)"
            say("\(answered ? "ok  " : "FAIL") a line typed into it was run there: \(said)")

            // It has one view: asked for its record, it stays its screen.
            page.setSimple(true)
            page.toggleSimple()
            try? await Task.sleep(for: .milliseconds(400))
            say("\(page.focused?.simple == false && !page.focusedSimple ? "ok  " : "FAIL") asked for the simple view twice over, it is still its screen: simple \(page.focused?.simple ?? false)")
            say("\(page.current?.status == "idle" ? "ok  " : "FAIL") its status after printing: \(page.current?.status ?? "-")")
            say("end")
            exit(lines.contains { $0.hasPrefix("FAIL") } ? 1 : 0)
        }
    }
}
#endif
