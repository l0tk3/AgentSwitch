#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftTerm

/// `-terminalProbe <dir> -probeTerminal <id> -probeDetach YES` (TerminalProbe; debug builds): the terminal put out in a
/// window of its own (docs/dispatch-v0.md §1 单独的窗口) through the page's own message, then what the two windows
/// show — the page's row and panes, the new window's screen, typing into it, a request's card answered with its key, a
/// sealed reply, ⌘W, and the way back. Pictures of the new window are written beside the probe's.
@MainActor
enum TerminalWindowProbe {
    static func run(_ main: MainWindowController, id: String, into dir: URL, say: (String) -> Void) async {
        guard let windows = main.windows else { return say("detach: no windows") }
        // The native page is asked directly; the web page (kept behind a default) through its script.
        let model = main.probeTerminals
        let web = main.probeWeb
        func js(_ source: String) async -> String { ((try? await web?.evaluateJavaScript(source)) as? String) ?? "-" }
        func out(_ kind: String) async {
            if let model {
                switch kind {
                case "detach": model.onDetach(id)
                case "attach": model.onAttach(id)
                default: model.select(id)
                }
            } else if kind == "show" {
                _ = await js("window.agentswitch.show('\(id)'), 'ok'")
            } else {
                _ = await js("window.webkit.messageHandlers.agentswitch.postMessage({ type: '\(kind)', id: '\(id)' }), 'ok'")
            }
        }
        func pause(_ ms: Int) async { try? await Task.sleep(for: .milliseconds(ms)) }
        func page() async -> String {
            if let model {
                let shown = main.probeScreens.values.compactMap(\.probeShown).sorted().joined(separator: ",")
                return "row \(model.here(id) ? "plain" : "marked")\(model.current?.id == id ? " selected" : ""); main shows [\(shown)]; out \(windows.ids.sorted())"
            }
            let row = await js("(() => { const r = document.querySelector('.row.term[data-id=\"\(id)\"]'); return r ? (r.querySelector('.inwin') ? 'marked' : 'plain') + (r.classList.contains('sel') ? ' selected' : '') : 'no row'; })()")
            let shown = main.probeScreens.values.compactMap(\.probeShown).sorted().joined(separator: ",")
            return "row \(row); main shows [\(shown)]; out \(windows.ids.sorted())"
        }
        // The probe's windows are never the key ones: the keyboard moves as in a window in use.
        TerminalScreenController.probeAsKey = true
        say("detach: before: \(await page())")
        await out("detach")
        var controller: TerminalWindowController?
        for _ in 0..<40 {
            await pause(250)
            controller = windows.probe(id)
            if let controller, controller.screen.probeSeq > 0 { break }
        }
        guard let controller, let window = controller.window else { return say("detach: no window") }
        await pause(800)
        let screen = controller.screen
        func grid() -> String { "\(screen.view.getTerminal().cols)x\(screen.view.getTerminal().rows)" }
        func text() -> String {
            let t = screen.view.getTerminal()
            return (0..<t.rows).compactMap { row -> String? in
                guard let line = t.getLine(row: row) else { return nil }
                let s = String((0..<line.count).map { t.getCharacter(for: line[$0]) }).trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "\0")))
                return s.isEmpty ? nil : s
            }.suffix(6).joined(separator: " ⏎ ")
        }
        func picture(_ name: String) {
            window.displayIfNeeded()
            // The window as it draws itself (a picture of it off the screen is black while the display sleeps or is
            // locked); a native screen's ground is its layer's and is left out: the pictures go over black.
            guard let frame = window.contentView?.superview, let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return }
            frame.cacheDisplay(in: frame.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png"))
        }
        func key(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = []) {
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                guard let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: window.windowNumber, context: nil, characters: chars,
                                               charactersIgnoringModifiers: chars.lowercased(), isARepeat: false, keyCode: code) else { continue }
                NSApp.postEvent(e, atStart: false)
            }
        }
        func responder() -> String { window.firstResponder.map { String(describing: type(of: $0)) } ?? "nil" }
        /// A click at a point of the window, from its top left corner.
        func click(_ x: CGFloat, top: CGFloat) async {
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                if let e = NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: window.frame.height - top), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { window.sendEvent(e) }
                await pause(80)
            }
        }
        say("detach: window \(Int(window.frame.width))x\(Int(window.frame.height)) title '\(window.title)' shows \(screen.probeShown ?? "-") seq \(screen.probeSeq) grid \(grid()) owner \(screen.probeOwner ?? "-") mine \(screen.probeOwner == screen.screenId)")
        say("detach: bars: folder '\(controller.model.folder)' name '\(controller.model.info?.name ?? "-")' status \(controller.model.info?.status ?? "-") context \(controller.model.context.map { "\($0.agent) · \($0.mode ?? "-") · \($0.size)" } ?? "-")")
        say("detach: after: \(await page())")
        // The page asked to show it again: its window comes forward, the page stays as it is.
        await out("show")
        await pause(700)
        say("detach: picked in the list: \(await page())")
        picture("item-1-open")
        // The main window meanwhile: its picture and the page's (the page is a web view: drawn over the window's).
        if let mainWindow = main.window, let web {
            if let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(mainWindow.windowNumber), [.boundsIgnoreFraming, .bestResolution]) {
                try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("item-main-window.png"))
            }
            let shot: NSImage? = await withCheckedContinuation { done in web.takeSnapshot(with: nil) { image, _ in done.resume(returning: image) } }
            if let tiff = shot?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("item-main-page.png"))
            }
            let at = web.convert(web.bounds, to: nil)
            say("detach: main window \(Int(mainWindow.frame.width))x\(Int(mainWindow.frame.height)) page at x \(Int(at.minX)) top \(Int(mainWindow.frame.height - at.maxY)) \(Int(at.width))x\(Int(at.height))")
            // The row's menu, as a right click on it opens it.
            _ = await js("(() => { const r = document.querySelector('.row.term[data-id=\"\(id)\"]'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.x + 120, clientY: b.y + 10 })); return 'ok'; })()")
            await pause(400)
            say("detach: the row's menu: \(await js("[...document.querySelectorAll('#menu button')].map((b) => b.querySelector('span').textContent + (b.disabled ? ' (off)' : '')).join(' | ')"))")
            let menu: NSImage? = await withCheckedContinuation { done in web.takeSnapshot(with: nil) { image, _ in done.resume(returning: image) } }
            if let tiff = menu?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("item-main-menu.png"))
            }
            _ = await js("(document.getElementById('menu').hidden = true, 'ok')")
        }

        // Typing goes to its terminal.
        window.makeKey()
        window.makeFirstResponder(screen.view)
        await pause(300)
        key("x", 7); key("y", 16); key("z", 6)
        await pause(1200)
        say("detach: typed xyz: key \(window.isKeyWindow) responder \(responder()) owner mine \(screen.probeOwner == screen.screenId) grid \(grid()) screen: \(text())")

        // A request as the stream would say it: its card, answered with ⌘↩ (the service has no such request: it goes).
        controller.model.received(event: "permission", data: #"{"type":"permission","request":{"id":"probe-1","tool":"Bash","summary":"Bash: rm -rf build"}}"#)
        await pause(600)
        picture("item-2-approval")
        say("detach: a request: waiting \(controller.model.requests.map(\.id))")
        key("\r", 36, .command)
        await pause(900)
        say("detach: after ⌘↩: waiting \(controller.model.requests.map(\.id)) notice \(controller.model.notice ?? "-") responder \(responder())")

        // A question: the card takes the keyboard, numbers pick, ↩ submits.
        controller.model.received(event: "permission", data: #"{"type":"permission","request":{"id":"probe-2","tool":"AskUserQuestion","summary":"?","questions":[{"question":"用哪个分支？","header":"Branch","multiSelect":false,"options":[{"label":"main","description":"主分支"},{"label":"dev","description":""}]},{"question":"改哪些页面？","header":"Pages","multiSelect":true,"options":[{"label":"登录","description":""},{"label":"注册","description":""}]}]}}"#)
        await pause(500)
        key("\r", 36, .command)
        await pause(400)
        say("detach: a question, ⌘↩ with no answer: card has keys \(controller.model.cardHasKeys)")
        // A click on the screen beside the card reaches the terminal under what floats over it: the keys are its again.
        // (The probe's window is not the key one, and a view that does not take the first click gets none of it there:
        // what is under the pointer is asked, and the press handed to it.)
        func under(_ x: CGFloat, top: CGFloat) -> String {
            window.contentView?.superview?.hitTest(NSPoint(x: x, y: window.frame.height - top)).map { String(describing: type(of: $0)) } ?? "nil"
        }
        say("detach: under the pointer: beside the card \(under(120, top: 400)), on the card \(under(window.frame.width - 300, top: 122))")
        if let press = NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 120, y: window.frame.height - 400), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1),
           let release = NSEvent.mouseEvent(with: .leftMouseUp, location: press.locationInWindow, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 0) {
            NSApp.postEvent(release, atStart: false)   // ends the press's tracking
            screen.view.mouseDown(with: press)
        }
        await pause(300)
        say("detach: a click on the screen: card has keys \(controller.model.cardHasKeys) responder \(responder())")
        // And one on the card's first option picks it, the card taking the keys.
        await click(window.frame.width - 300, top: 122)
        await pause(300)
        if let ask = controller.model.first {
            say("detach: a click on the first option: picks \(controller.model.form(for: ask).picks.map(\.labels)) card has keys \(controller.model.cardHasKeys)")
        }
        // The first question answered, the second is in focus: 3 is its Other — the field takes the keyboard; esc gives
        // it back to the card.
        key("3", 20)
        await pause(500)
        key("o", 31); key("k", 40)
        await pause(400)
        if let ask = controller.model.first {
            say("detach: 3, then ok: responder \(responder()) question in focus \(controller.model.focus(in: ask)) written \(controller.model.form(for: ask).picks.map(\.other))")
        }
        key("\u{1b}", 53)
        await pause(400)
        say("detach: esc in Other: responder \(responder()) card has keys \(controller.model.cardHasKeys)")
        key("2", 19)
        await pause(300)
        key("1", 18); key("2", 19)
        await pause(400)
        if let ask = controller.model.first {
            let form = controller.model.form(for: ask)
            say("detach: 2, then 1 2: picks \(form.picks.map(\.labels)) complete \(form.complete) focus \(controller.model.focus(in: ask)) screen: \(text())")
        }
        picture("item-3-question")
        key("\r", 36)
        await pause(900)
        say("detach: after ↩: waiting \(controller.model.requests.map(\.id)) card has keys \(controller.model.cardHasKeys) responder \(responder())")

        // The sealed reply: ⌘⇧V opens it, what is written goes to the terminal on ↩.
        key("v", 9, [.command, .shift])
        await pause(700)
        say("detach: ⌘⇧V: composing \(controller.model.composing) responder \(responder()) field focused \(controller.model.sealFocused)")
        for (c, code) in [("h", UInt16(4)), ("i", 34)] { key(c, code) }
        await pause(500)
        picture("item-4-seal")
        say("detach: typed in the box: draft '\(controller.model.draft)'")
        key("\r", 36)
        await pause(1500)
        say("detach: after ↩: composing \(controller.model.composing) notice \(controller.model.notice ?? "-") responder \(responder()) screen: \(text())")
        key("v", 9, [.command, .shift])
        await pause(500)
        key("\u{1b}", 53)
        await pause(500)
        say("detach: ⌘⇧V then esc: composing \(controller.model.composing) responder \(responder())")

        // In use on the phone: the placeholder, taken back with a click's action.
        let phone = URLSession(configuration: .ephemeral)
        let follow = phone.dataTask(with: AppModelProbe.client(main).terminalStreamRequest(id: id, screen: "phone-probe"))
        follow.resume()
        await pause(600)
        try? await AppModelProbe.client(main).resizeTerminal(id: id, cols: 50, rows: 30, screen: "phone-probe")
        await pause(1200)
        say("detach: the phone took it: away \(controller.model.away ?? "-") size \(controller.model.context?.size ?? "-") buffer \(grid())")
        picture("item-5-away")
        // A click anywhere on the placeholder takes the terminal back.
        say("detach: under the pointer on the placeholder: \(under(200, top: 200))")
        await click(200, top: 200)
        await pause(1200)
        say("detach: Use Here: away \(controller.model.away ?? "-") size \(controller.model.context?.size ?? "-") buffer \(grid())")
        follow.cancel()
        phone.invalidateAndCancel()

        // ⌘W closes the window; the terminal runs on, and the page may show it again.
        key("w", 13, .command)
        await pause(900)
        say("detach: after ⌘W: \(await page()); window open \(windows.probe(id) != nil)")
        await out("show")
        await pause(1500)
        say("detach: picked in the list again: \(await page())")

        // Out once more, and back by the row's menu (`attach`).
        await out("detach")
        await pause(2500)
        say("detach: out again: \(await page())")
        await out("attach")
        await pause(2000)
        say("detach: Move Back Here: \(await page())")
    }
}

/// The probe's client: the one the window's own parts use.
@MainActor
enum AppModelProbe {
    static func client(_ main: MainWindowController) -> DaemonClient { main.probeClient }
}
#endif
