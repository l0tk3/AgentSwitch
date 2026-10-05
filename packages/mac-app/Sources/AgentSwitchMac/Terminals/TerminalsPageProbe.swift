#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftTerm

/// `-terminalProbe <dir> -probeTerminal <id> -probeTerminals <another id>` (TerminalProbe; debug builds, against a
/// throw-away service): the native Terminals page used as a person would — its keys, the list, the search, the panes,
/// a new terminal, a name, a request's card, the sealed reply, the phone taking a terminal and leaving it, a window of
/// its own, closing — with what the page held after each step written to `probe.txt` and pictures `page-*.png` beside it.
@MainActor
enum TerminalsPageProbe {
    static func run(_ main: MainWindowController, id: String, second: String, into dir: URL, say: (String) -> Void) async {
        guard let model = main.probeTerminals, let window = main.window else { return say("page: not the native page") }
        TerminalScreenController.probeAsKey = true
        func pause(_ ms: Int) async { try? await Task.sleep(for: .milliseconds(ms)) }
        func key(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = []) {
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                guard let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: window.windowNumber, context: nil, characters: chars,
                                               charactersIgnoringModifiers: chars.lowercased(), isARepeat: false, keyCode: code) else { continue }
                NSApp.postEvent(e, atStart: false)
            }
        }
        func type(_ text: String) { for ch in text { key(String(ch), 0) } }
        func responder() -> String {
            guard let r = window.firstResponder else { return "nil" }
            if let editor = r as? NSTextView, let field = editor.delegate as? NSView { return "\(Swift.type(of: field)) editor" }
            return String(describing: Swift.type(of: r))
        }
        func picture(_ name: String) {
            window.displayIfNeeded()
            // The window as it draws itself (a picture of it off the screen is black while the display sleeps or is
            // locked); a native screen's ground is its layer's and is left out: the pictures go over black.
            guard let frame = window.contentView?.superview, let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return }
            frame.cacheDisplay(in: frame.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png"))
        }
        func text(_ screen: TerminalScreenController?) -> String {
            guard let screen else { return "-" }
            let t = screen.view.getTerminal()
            return (0..<t.rows).compactMap { row -> String? in
                guard let line = t.getLine(row: row) else { return nil }
                let s = String((0..<line.count).map { t.getCharacter(for: line[$0]) }).trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "\0")))
                return s.isEmpty ? nil : s
            }.suffix(3).joined(separator: " ⏎ ")
        }
        func panes() -> String {
            model.paneList.map { pane in
                let state = model.panes[pane.id]
                let grid = state?.grid.map { "\($0.cols)x\($0.rows)" } ?? "-"
                return "\(pane.id)\(pane.id == model.focusPane ? "*" : ""):\(pane.term ?? "-")(shows \(state?.screen.probeShown ?? "-") \(grid))"
            }.joined(separator: " ")
        }
        func head() -> String {
            let h = main.probeHead
            return "'\(h?.name ?? "")' status \(h?.status ?? "-") tag '\(h?.tag ?? "")' context \(h?.shown.map { "\($0.agent) · \($0.mode ?? "-") · \($0.size)" } ?? "none") list \(Int(h?.sideWidth ?? -1))"
        }
        func mine(_ id: String) -> TerminalInfo? { model.terminal(id) }
        let ours = Set([id, second])
        func rows() -> String {
            let all = model.rows
            let terms = all.compactMap { row -> String? in if case .terminal(let t, _, _, let index) = row, ours.contains(t.id) || t.cwd.contains("agentswitch-live") { "\(t.name)#\(index.map { String($0 + 1) } ?? "-")" } else { nil } }
            return "\(all.count) rows; terminals \(terms)"
        }

        // The page as it opened: the list from the service, the terminal asked for on screen, the bar's words.
        for _ in 0..<20 where !model.settled { await pause(250) }
        await pause(600)
        say("page: opened: settled \(model.settled) \(rows()) panes \(panes()) head \(head()) title '\(window.title)' responder \(responder())")
        picture("page-1-open")

        // ⌘B puts the list away and brings it back; ⌘F is the search, esc leaves it.
        key("b", 11, .command)
        await pause(400)
        say("page: ⌘B: list closed \(model.sideClosed) head \(head()) grid \(panes())")
        key("b", 11, .command)
        await pause(400)
        key("f", 3, .command)
        await pause(500)
        say("page: ⌘F: responder \(responder())")
        type("work")
        await pause(700)
        say("page: typed work: query '\(model.query)' \(model.rows.count) rows, first \(model.rows.first.map { String(describing: $0).prefix(40) } ?? "-")")
        picture("page-2-search")
        key("\u{1b}", 53)
        await pause(500)
        say("page: esc: query '\(model.query)' responder \(responder())")

        // ⌘D splits; the new pane is empty and in focus; ⌘2 puts the second terminal in it.
        key("d", 2, .command)
        await pause(700)
        say("page: ⌘D: \(panes()) responder \(responder())")
        let order = model.order
        if let at = order.firstIndex(of: second), at < 9 { key(String(at + 1), 0, .command) } else { model.select(second) }
        await pause(1500)
        say("page: the second terminal picked: \(panes()) head \(head())")
        key("q", 12); key("q", 12)
        await pause(900)
        say("page: typed qq: focused screen: \(text(model.focused?.screen)) | other: \(text(model.panes.values.first { $0.id != model.focusPane }?.screen))")
        picture("page-3-panes")
        key("", 123, [.command, .option])
        await pause(500)
        say("page: ⌘⌥←: \(panes()) head \(head()) responder \(responder())")
        if let line = model.placed(in: model.area).lines.first {
            model.dragLine(line, to: 380)
            await pause(300)
            say("page: the line dragged to 380: sizing \(model.sizing) \(panes())")
            picture("page-4-sizing")
            model.endLineDrag()
            await pause(500)
        }
        key("\r", 36, [.command, .shift])
        await pause(500)
        say("page: ⌘⇧↩: zoomed \(model.zoomed) placed \(model.placed(in: model.area).panes.count)")
        key("\r", 36, [.command, .shift])
        await pause(400)

        // A request's card in the pane in focus, answered with its key; the other pane's header says one waits.
        model.focused?.session?.received(event: "permission", data: #"{"request":{"id":"probe-1","tool":"Bash","summary":"Bash: rm -rf build"}}"#)
        model.panes.values.first { $0.id != model.focusPane }?.session?.received(event: "permission", data: #"{"request":{"id":"probe-2","tool":"Edit","summary":"Edit: /tmp/x"}}"#)
        await pause(600)
        picture("page-5-card")
        key("\r", 36, .command)
        await pause(900)
        say("page: a request, ⌘↩: waiting here \(model.focused?.session?.requests.map(\.id) ?? []) there \(model.panes.values.first { $0.id != model.focusPane }?.session?.requests.map(\.id) ?? []) responder \(responder())")

        // The sealed reply: ⌘⇧V, two letters, ↩.
        key("v", 9, [.command, .shift])
        await pause(700)
        type("hi")
        await pause(400)
        say("page: ⌘⇧V, hi: composing \(model.focused?.session?.composing ?? false) draft '\(model.focused?.session?.draft ?? "")' responder \(responder())")
        key("\r", 36)
        await pause(1500)
        say("page: ↩: composing \(model.focused?.session?.composing ?? false) screen: \(text(model.focused?.screen)) responder \(responder())")

        // The phone takes the terminal in focus, then leaves: it stays as it was left until it is taken back here.
        if let shown = model.focused?.screen.probeShown {
            let phone = URLSession(configuration: .ephemeral)
            let follow = phone.dataTask(with: main.probeClient.terminalStreamRequest(id: shown, screen: "phone-probe"))
            follow.resume()
            await pause(600)
            try? await main.probeClient.resizeTerminal(id: shown, cols: 50, rows: 30, screen: "phone-probe")
            await pause(1200)
            say("page: the phone took it: away \(model.focused?.session?.away ?? "-") head \(head())")
            follow.cancel()
            phone.invalidateAndCancel()
            await pause(5000)
            say("page: the phone left, five seconds on: away \(model.focused?.session?.away ?? "-") owner \(model.focused?.screen.probeOwner ?? "nobody") head \(head())")
            picture("page-6-left")
            window.makeFirstResponder(model.focused?.screen.view)
            key("z", 6)
            await pause(1500)
            say("page: a key typed here: away \(model.focused?.session?.away ?? "-") mine \(model.focused?.screen.probeOwner == model.focused?.screen.screenId) head \(head())")
        }

        // A name changed in the list.
        model.startRename(second)
        await pause(600)
        say("page: renaming: responder \(responder()) field '\(model.renameText)'")
        key("a", 0, .command)
        type("probe name")
        await pause(300)
        key("\r", 36)
        await pause(1500)
        say("page: a new name: '\(mine(second)?.name ?? "-")' custom \(mine(second)?.customName ?? false) renaming \(model.renaming ?? "-") responder \(responder())")

        // ⌘T: the panel in the pane in focus; esc leaves it; again, a folder typed and ↩: a new terminal there.
        key("t", 17, .command)
        await pause(600)
        say("page: ⌘T: creating \(model.creating) agent \(model.pickedAgent) agents \(model.agents) responder \(responder()) title '\(window.title)'")
        picture("page-7-create")
        key("\u{1b}", 53)
        await pause(500)
        say("page: esc: creating \(model.creating) responder \(responder())")
        key("t", 17, .command)
        await pause(400)
        let before = Set(model.terminals.map(\.id))
        model.folderText = mine(id)?.cwd ?? "~"
        key("\r", 36)
        await pause(3500)
        let made = model.terminals.first { !before.contains($0.id) }
        say("page: ↩ on the panel: made \(made?.id ?? "-") error '\(model.createError)' \(panes()) loading \(model.focused?.loading ?? "-") head \(head())")
        picture("page-8-started")

        // Out to a window of its own and back.
        if let windows = main.windows {
            model.onDetach(id)
            for _ in 0..<20 where windows.probe(id) == nil { await pause(250) }
            await pause(1200)
            say("page: out: detached \(model.detached.sorted()) \(panes()) row out \(!model.here(id))")
            model.select(id)
            await pause(500)
            say("page: picked in the list: \(panes())")
            picture("page-9-out")
            model.onAttach(id)
            await pause(1800)
            say("page: back: detached \(model.detached.sorted()) \(panes()) window open \(windows.probe(id) != nil) away \(model.focused?.session?.away ?? "-") mine \(model.focused?.screen.probeOwner == model.focused?.screen.screenId)")
            await pause(4000)
            say("page: back, four seconds on: away \(model.focused?.session?.away ?? "-") mine \(model.focused?.screen.probeOwner == model.focused?.screen.screenId) head \(head())")
        }

        // ⌘W on a running terminal asks first; ↩ closes it.
        if let made {
            model.select(made.id)
            await pause(600)
            key("w", 13, .command)
            await pause(700)
            say("page: ⌘W: asks '\(model.sheet?.title ?? "-")' check \(model.sheet?.check ?? "-")")
            picture("page-10-sheet")
            key("\r", 36)
            await pause(2500)
            say("page: ↩: sheet \(model.sheet == nil ? "gone" : "up") terminal there \(model.terminal(made.id) != nil) \(panes()) responder \(responder())")
        }
        say("page: at the end: \(rows()) head \(head())")
    }
}
#endif
