#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftTerm

/// `-terminalProbe <dir> -probeTerminal <id>` (debug builds, with `-localPort` and AGENTSWITCH_HOME of a running
/// service): opens the main window's Terminals page on that terminal behind every other window (the app is not made active), types
/// into the native screen with events of its own (`abc`, Shift+Enter, `def`), then writes what the screen holds and a
/// picture of the window to `<dir>` and quits. Nothing else of the app starts.
@MainActor
enum TerminalProbe {
    static var directory: URL? { UserDefaults.standard.string(forKey: "terminalProbe").map { URL(fileURLWithPath: $0) } }

    static func run(_ terminals: MainWindowController, into dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var log: [String] = []
        func say(_ line: String) { log.append(line); try? log.joined(separator: "\n").write(to: dir.appendingPathComponent("probe.txt"), atomically: true, encoding: .utf8) }
        let id = UserDefaults.standard.string(forKey: "probeTerminal") ?? ""
        MainWindowController.probing = true
        terminals.show(terminal: id)
        Task {
            var screen: TerminalScreenController?
            for _ in 0..<60 {
                try? await Task.sleep(for: .milliseconds(250))
                screen = terminals.probeScreen
                if let screen, screen.probeShown == id, screen.probeSeq > 0 { break }
            }
            guard let screen, let window = terminals.window else { say("no window or screen"); exit(1) }
            say("shown \(screen.probeShown ?? "-") seq \(screen.probeSeq) frame \(NSStringFromRect(screen.view.frame)) hidden \(screen.view.isHidden) grid \(screen.view.getTerminal().cols)x\(screen.view.getTerminal().rows)")
            // Key within the app (posted keys go to the key window), still behind the others, the app not active.
            window.makeKey()
            window.makeFirstResponder(screen.view)
            say("key \(window.isKeyWindow)")
            try? await Task.sleep(for: .milliseconds(400))
            func key(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = []) {
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    guard let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                                   windowNumber: window.windowNumber, context: nil, characters: chars,
                                                   charactersIgnoringModifiers: chars.lowercased(), isARepeat: false, keyCode: code) else { continue }
                    NSApp.postEvent(e, atStart: false)
                }
            }
            key("a", 0); key("b", 11); key("c", 8)
            try? await Task.sleep(for: .milliseconds(300))
            key("\r", 36, .shift)
            try? await Task.sleep(for: .milliseconds(300))
            key("d", 2); key("e", 14); key("f", 3)
            try? await Task.sleep(for: .seconds(2))
            // Wide characters beside ASCII (the phone drew them far apart, 2026-09-30).
            screen.note("接口确认齐全。跟随其他屏幕尺寸变化时 resize abc 你好")
            try? await Task.sleep(for: .milliseconds(300))
            say("first responder \(window.firstResponder.map { String(describing: type(of: $0)) } ?? "-")")
            // Where the program's cursor is, and a composition in progress drawn there (an input method's marked text).
            let tt = screen.view.getTerminal()
            let cursor = tt.getCursorLocation()
            var inverse: [Int] = []
            if let line = tt.getLine(row: cursor.y) {
                for col in 0..<tt.cols where line[col].attribute.style.contains(.inverse) { inverse.append(col) }
            }
            say("cursor col \(cursor.x) row \(cursor.y); inverse cells on that row \(inverse)")
            if UserDefaults.standard.bool(forKey: "probeStatus") {
                // The status bar (proposal B, 2026-10-03): the page reports the terminal on screen and shows no Encrypt &
                // Send bar of its own; the lock opens the sealed reply's box under the terminal, and closes it.
                @MainActor func page() async -> String {
                    let js = "JSON.stringify({statusBar: document.documentElement.classList.contains('status-bar'), sealBar: getComputedStyle(document.getElementById('sealBar')).display, sealHidden: document.getElementById('sealBar').hidden, composer: !document.getElementById('composer').hidden, focus: document.activeElement ? document.activeElement.id : null})"
                    return (try? await terminals.probeWeb?.evaluateJavaScript(js)) as? String ?? "-"
                }
                try? await Task.sleep(for: .seconds(1))
                let context = terminals.probeHead?.shown.map { "\($0.agent) | \($0.mode ?? "-") | \($0.size) | running \($0.running)" } ?? "none"
                say("status: context \(context) page \(await page())")
                terminals.probeSeal()
                try? await Task.sleep(for: .milliseconds(900))
                say("lock: page \(await page())")
                if let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]) {
                    try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("status.png"))
                }
                // The page itself (a window behind the others has its web content drawn only on request).
                if let web = terminals.probeWeb {
                    let image: NSImage? = await withCheckedContinuation { done in web.takeSnapshot(with: nil) { image, _ in done.resume(returning: image) } }
                    if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                        try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("status-page.png"))
                    }
                }
                terminals.probeSeal()
                try? await Task.sleep(for: .milliseconds(600))
                say("lock again: page \(await page())")
            }
            if let second = UserDefaults.standard.string(forKey: "probePanes") {
                // Split panes (docs/terminal-v0.md §1 分屏, 2026-10-03): the pane split, a second terminal put in the new
                // half, each pane its own native screen and grid, the line between them dragged, the focus moved, a
                // pane closed.
                @MainActor func js(_ source: String) async -> String { (try? await terminals.probeWeb?.evaluateJavaScript(source)) as? String ?? "-" }
                let state = "JSON.stringify({panes: [...document.querySelectorAll('#panes .pane')].map(el => ({pane: el.dataset.pane, focus: el.classList.contains('focus'), head: el.querySelector('.pane-head').hidden ? null : el.querySelector('.pane-head').textContent.trim().slice(0, 40), w: Math.round(el.getBoundingClientRect().width), empty: !!el.querySelector('.pane-empty')})), lines: document.querySelectorAll('.pane-line').length})"
                @MainActor func native() -> String {
                    terminals.probeScreens.sorted { $0.key < $1.key }.map { pane, screen in
                        let t = screen.view.getTerminal()
                        return "\(pane):\(screen.probeShown ?? "-") \(Int(screen.view.frame.minX)),\(Int(screen.view.frame.minY)) \(Int(screen.view.frame.width))x\(Int(screen.view.frame.height)) grid \(t.cols)x\(t.rows) hidden \(screen.view.isHidden)"
                    }.joined(separator: " | ")
                }
                @MainActor func shots(_ name: String) async {
                    if let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]) {
                        try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name)-window.png"))
                    }
                    if let web = terminals.probeWeb {
                        let image: NSImage? = await withCheckedContinuation { done in web.takeSnapshot(with: nil) { image, _ in done.resume(returning: image) } }
                        if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                            try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name)-page.png"))
                        }
                    }
                }
                say("panes: one pane: page \(await js(state)) native \(native())")
                _ = await js("String(window.agentswitch.split('right'))")
                try? await Task.sleep(for: .milliseconds(800))
                say("panes: split right: page \(await js(state)) native \(native())")
                _ = await js("window.agentswitch.show(\"\(second)\"), ''")
                try? await Task.sleep(for: .milliseconds(2500))
                say("panes: second terminal in the new pane: page \(await js(state)) native \(native()) first responder pane \(terminals.probeScreens.first { $0.value.view === window.firstResponder }?.key ?? -1)")
                say("panes: status bar \(terminals.probeHead?.shown.map { "\($0.agent) | \($0.size)" } ?? "none")")
                // Typed into the pane in focus only.
                if let focused = terminals.probeScreen { window.makeFirstResponder(focused.view) }
                key("x", 7); key("y", 16); key("z", 6); key("\r", 36)
                try? await Task.sleep(for: .seconds(1))
                for (pane, screen) in terminals.probeScreens.sorted(by: { $0.key < $1.key }) {
                    let t = screen.view.getTerminal()
                    var lines: [String] = []
                    for row in 0..<t.rows { if let line = t.getLine(row: row) { let text = line.translateToString(trimRight: true); if !text.isEmpty { lines.append(text) } } }
                    say("panes: screen \(pane) holds: \(lines.suffix(3).joined(separator: " / "))")
                }
                await shots("panes-two")
                // The line between them dragged 160 pt to the left.
                let drag = "(() => { const l = document.querySelector('.pane-line'); const r = l.getBoundingClientRect(); const x = r.x + 3, y = r.y + 40; l.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: x, clientY: y, bubbles: true})); window.dispatchEvent(new PointerEvent('pointermove', {clientX: x - 160, clientY: y, bubbles: true})); const sizes = [...document.querySelectorAll('.pane-size')].map(e => e.textContent); window.dispatchEvent(new PointerEvent('pointerup', {clientX: x - 160, clientY: y, bubbles: true})); return JSON.stringify(sizes); })()"
                say("panes: line dragged, sizes said meanwhile \(await js(drag))")
                try? await Task.sleep(for: .milliseconds(1500))
                say("panes: after the drag: page \(await js(state)) native \(native())")
                // The focus to the first pane: the status bar says its terminal.
                let firstPane = terminals.probeScreens.keys.min() ?? 1
                _ = await js("window.agentswitch.focusPane(\(firstPane)), ''")
                try? await Task.sleep(for: .milliseconds(1200))
                say("panes: focus on pane \(firstPane): page \(await js(state)) status bar \(terminals.probeHead?.shown.map { "\($0.agent) | \($0.size)" } ?? "none") title \(window.title)")
                // ⌘⇧↩: the pane in focus alone, then all again.
                _ = await js("String(window.agentswitch.shortcut('Enter', true))")
                try? await Task.sleep(for: .milliseconds(1000))
                say("panes: zoomed: page \(await js(state)) native \(native())")
                _ = await js("String(window.agentswitch.shortcut('Enter', true))")
                try? await Task.sleep(for: .milliseconds(1500))
                say("panes: unzoomed: native \(native())")
                // The second pane closed: its terminal runs on, one pane as before.
                _ = await js("(document.querySelectorAll('#panes .pane .x')[1] || {click() {}}).click(), ''")
                try? await Task.sleep(for: .milliseconds(1200))
                say("panes: second pane closed: page \(await js(state)) native \(native()) kept \(await js("localStorage.getItem('terminal.panes')"))")
                try? await Task.sleep(for: .milliseconds(1500))
                say("panes: a moment later: native \(native()) page's screen \(await js("JSON.stringify([...document.querySelectorAll('.pane-screen')].map(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); }))"))")
                // The second terminal's row dragged from the tree onto the pane: its right edge splits that side for it,
                // then its middle shows it there (it leaves its own pane, which closes).
                func dragRow(to point: String) -> String {
                    "(() => { const row = document.querySelector('.row.term[data-id=\"\(second)\"]'); if (!row) return 'no row'; const r = row.getBoundingClientRect(); const p = document.querySelector('#panes .pane').getBoundingClientRect(); const at = \(point); row.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: r.x + 40, clientY: r.y + 6, bubbles: true})); window.dispatchEvent(new PointerEvent('pointermove', {clientX: r.x + 70, clientY: r.y + 40, bubbles: true})); window.dispatchEvent(new PointerEvent('pointermove', {clientX: at[0], clientY: at[1], bubbles: true})); const said = (document.querySelector('.pane-drop span') || {}).textContent || 'no drop'; const ghost = !!document.querySelector('.pane-ghost'); window.dispatchEvent(new PointerEvent('pointerup', {clientX: at[0], clientY: at[1], bubbles: true})); return said + (ghost ? ' (ghost shown)' : ''); })()"
                }
                say("panes: row dragged to the right edge: \(await js(dragRow(to: "[p.right - 20, p.y + p.height / 2]")))")
                try? await Task.sleep(for: .milliseconds(2000))
                say("panes: after the drop: page \(await js(state)) native \(native())")
                say("panes: row dragged to the first pane's middle: \(await js(dragRow(to: "[p.x + p.width / 2, p.y + p.height / 2]")))")
                try? await Task.sleep(for: .milliseconds(2000))
                say("panes: after the drop: page \(await js(state)) native \(native())")
                // ⌘-click on the first terminal's row: a new pane to the right with it.
                _ = await js("(() => { const row = document.querySelector('.row.term[data-id=\"\(id)\"]'); row && row.dispatchEvent(new MouseEvent('click', {metaKey: true, bubbles: true})); return ''; })()")
                try? await Task.sleep(for: .milliseconds(2000))
                say("panes: ⌘-click on the other row: page \(await js(state)) native \(native())")
                // The page loaded again: the panes come back as they were left.
                _ = await js("location.reload(), ''")
                try? await Task.sleep(for: .seconds(5))
                say("panes: after a reload: page \(await js(state)) native \(native())")
                _ = await js("localStorage.removeItem('terminal.panes'), ''")
            }
            if UserDefaults.standard.bool(forKey: "probeAway") {
                // One size for one terminal: a phone takes it while it follows; the window shows where it is in use,
                // a click on the placeholder takes it back, and it comes back by itself when the phone leaves.
                let home = ProcessInfo.processInfo.environment["AGENTSWITCH_HOME"].map { URL(fileURLWithPath: $0) }
                let client = DaemonClient(port: UserDefaults.standard.integer(forKey: "localPort"), tokenFile: home?.appendingPathComponent(DaemonClient.tokenFileName))
                @MainActor func page() async -> String {
                    guard let web = terminals.probeWeb else { return "-" }
                    let js = "JSON.stringify({hidden: document.getElementById('away').hidden, place: document.getElementById('away').dataset.place || null, head: document.getElementById('awayHead').textContent})"
                    return (try? await web.evaluateJavaScript(js)) as? String ?? "-"
                }
                @MainActor func shot(_ name: String) {
                    if let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]) {
                        try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name))
                    }
                }
                let t0 = screen.view.getTerminal()
                say("away: owner \(screen.probeOwner ?? "-") grid \(t0.cols)x\(t0.rows) page \(await page())")
                let phone = URLSession(configuration: .ephemeral)
                let follow = phone.dataTask(with: client.terminalStreamRequest(id: id, screen: "phone-probe"))
                follow.resume()
                try? await Task.sleep(for: .milliseconds(500))
                try? await client.resizeTerminal(id: id, cols: 50, rows: 30, screen: "phone-probe")
                try? await Task.sleep(for: .milliseconds(1200))
                let t1 = screen.view.getTerminal()
                say("phone took it: owner \(screen.probeOwner ?? "-") buffer \(t1.cols)x\(t1.rows) page \(await page())")
                shot("away.png")
                terminals.probeWeb?.evaluateJavaScript("document.getElementById('away').dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))", completionHandler: nil)
                try? await Task.sleep(for: .milliseconds(1500))
                let t2 = screen.view.getTerminal()
                say("clicked here: owner \(screen.probeOwner ?? "-") buffer \(t2.cols)x\(t2.rows) page \(await page())")
                try? await client.resizeTerminal(id: id, cols: 50, rows: 30, screen: "phone-probe")
                try? await Task.sleep(for: .milliseconds(800))
                say("phone again: owner \(screen.probeOwner ?? "-") page \(await page())")
                if let other = UserDefaults.standard.string(forKey: "probeTerminal2") {
                    // Opening a terminal the phone is using does not take it: the placeholder says where it is in use.
                    terminals.show(terminal: other)
                    try? await Task.sleep(for: .milliseconds(2500))
                    say("other opened: shown \(screen.probeShown ?? "-") owner \(screen.probeOwner ?? "-") page \(await page())")
                    terminals.show(terminal: id)
                    try? await Task.sleep(for: .milliseconds(2500))
                    say("back to the phone's: shown \(screen.probeShown ?? "-") owner \(screen.probeOwner ?? "-") page \(await page())")
                    terminals.probeWeb?.evaluateJavaScript("document.getElementById('away').dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))", completionHandler: nil)
                    try? await Task.sleep(for: .milliseconds(1500))
                    say("taken over: owner \(screen.probeOwner ?? "-") page \(await page())")
                }
                follow.cancel()
                phone.invalidateAndCancel()
                try? await Task.sleep(for: .seconds(4.5))
                let t3 = screen.view.getTerminal()
                say("phone left: owner \(screen.probeOwner ?? "-") buffer \(t3.cols)x\(t3.rows) page \(await page()) visible \(window.isVisible) occlusion \(window.occlusionState.contains(.visible))")
            }
            if let picture = UserDefaults.standard.string(forKey: "probeDrop") {
                // A picture dropped on the screen as Finder drops one: its path typed, escaped; Claude Code makes it [Image #n].
                let board = NSPasteboard(name: NSPasteboard.Name("agentswitch-probe-\(UUID().uuidString)"))
                board.clearContents()
                board.writeObjects([URL(fileURLWithPath: picture) as NSURL])
                let took = screen.drop(board)
                try? await Task.sleep(for: .seconds(2))
                let dt = screen.view.getTerminal()
                var shown: [String] = []
                for row in 0..<dt.rows { if let line = dt.getLine(row: row) { shown.append(line.translateToString(trimRight: true)) } }
                say("dropped \(took): " + (shown.filter { $0.contains("Image") || $0.contains("probe") }.joined(separator: " | ")))
                board.releaseGlobally()
            }
            if UserDefaults.standard.bool(forKey: "probeLink") {
                // A link as Claude Code writes one (OSC 8), ⌘-clicked through the window as a person would.
                var opened: [String] = []
                LinkOpener.probeOpened = { opened.append($0.absoluteString) }
                screen.view.feed(text: "\r\n\u{1b}]8;;file:///tmp/probe-link.png\u{1b}\\probe-link.png\u{1b}]8;;\u{1b}\\ and \u{1b}]8;;https://example.com/\u{1b}\\example\u{1b}]8;;\u{1b}\\")
                let lt = screen.view.getTerminal()
                let row = lt.getCursorLocation().y
                let optimal = screen.view.getOptimalFrameSize().size
                let cw = optimal.width / CGFloat(lt.cols), ch = optimal.height / CGFloat(lt.rows)
                @MainActor func click(col: Int) {
                    let inView = NSPoint(x: (CGFloat(col) + 0.5) * cw, y: screen.view.isFlipped ? (CGFloat(row) + 0.5) * ch : screen.view.bounds.height - (CGFloat(row) + 0.5) * ch)
                    let at = screen.view.convert(inView, to: nil)
                    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                        guard let e = NSEvent.mouseEvent(with: type, location: at, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
                                                         windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { continue }
                        if type == .leftMouseDown { screen.view.mouseDown(with: e) } else { screen.view.mouseUp(with: e) }
                    }
                    say("clicked col \(col) row \(row) at \(NSStringFromPoint(at)); hit view \(window.contentView?.hitTest(at).map { String(describing: type(of: $0)) } ?? "-")")
                }
                say("link at (3,\(row)) \(lt.link(at: .screen(Position(col: 3, row: row)), mode: .explicitOnly) ?? "none"); at (21,\(row)) \(lt.link(at: .screen(Position(col: 21, row: row)), mode: .explicitAndImplicit) ?? "none"); highlight \(screen.view.linkHighlightMode) reporting \(screen.view.linkReporting); cell \(NSStringFromSize(NSSize(width: cw, height: ch))) flipped \(screen.view.isFlipped)")
                click(col: 3)
                try? await Task.sleep(for: .milliseconds(300))
                click(col: 21)
                try? await Task.sleep(for: .milliseconds(300))
                // Plain paths as agents print them (2026-10-01): absolute, and relative to where the agent works.
                screen.view.feed(text: "\r\n  /Users/l0tk3/Desktop/WorkSpace/Projects/AgentSwitch/docs/design/icon-explorations-2026-10-01/crt.html\r\n\r\n  see docs/ui-v0.md:12 for it")
                try? await Task.sleep(for: .milliseconds(200))
                let pathRow = lt.getCursorLocation().y - 2
                @MainActor func clickAt(col: Int, row r: Int) {
                    let inView = NSPoint(x: (CGFloat(col) + 0.5) * cw, y: screen.view.isFlipped ? (CGFloat(r) + 0.5) * ch : screen.view.bounds.height - (CGFloat(r) + 0.5) * ch)
                    let at = screen.view.convert(inView, to: nil)
                    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                        guard let e = NSEvent.mouseEvent(with: type, location: at, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
                                                         windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { continue }
                        if type == .leftMouseDown { screen.view.mouseDown(with: e) } else { screen.view.mouseUp(with: e) }
                    }
                }
                say("workdir \(screen.workdir ?? "-"); path link \(lt.link(at: .screen(Position(col: 20, row: pathRow)), mode: .explicitAndImplicit) ?? "none"); relative \(lt.link(at: .screen(Position(col: 10, row: pathRow + 2)), mode: .explicitAndImplicit) ?? "none")")
                clickAt(col: 20, row: pathRow)
                try? await Task.sleep(for: .milliseconds(300))
                clickAt(col: 10, row: pathRow + 2)
                try? await Task.sleep(for: .milliseconds(300))
                say("mouse mode \(lt.mouseMode); opened \(opened)")
                LinkOpener.probeOpened = nil
            }
            if UserDefaults.standard.bool(forKey: "probeCompose") {
                // An input method composing (Pinyin): its marked text inline at the cursor, the candidate window's anchor.
                @MainActor func capture(_ name: String) {
                    if let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]) {
                        try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name))
                    }
                }
                let none = NSRange(location: NSNotFound, length: 0)
                let v = screen.view
                say("caret \(NSStringFromRect(window.convertToScreen(v.convert(NSRect(x: 0, y: 0, width: 1, height: 1), to: nil))))")
                v.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: none)
                try? await Task.sleep(for: .milliseconds(400))
                say("zhong: at 0 \(NSStringFromRect(v.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: nil))) at 5 \(NSStringFromRect(v.firstRect(forCharacterRange: NSRange(location: 5, length: 0), actualRange: nil))) selected \(v.selectedRange())")
                capture("compose.png")
                v.setMarkedText("中文", selectedRange: NSRange(location: 1, length: 0), replacementRange: none)
                try? await Task.sleep(for: .milliseconds(400))
                say("中文: at 0 \(NSStringFromRect(v.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: nil))) at 1 \(NSStringFromRect(v.firstRect(forCharacterRange: NSRange(location: 1, length: 0), actualRange: nil))) selected \(v.selectedRange())")
                capture("compose-cjk.png")
                v.unmarkText()
                try? await Task.sleep(for: .milliseconds(200))
                say("unmarked: marked \(v.hasMarkedText()) selected \(v.selectedRange())")
            }
            let t = screen.view.getTerminal()
            var lines: [String] = []
            for row in 0..<t.rows {
                if let line = t.getLine(row: row) { lines.append(line.translateToString(trimRight: true)) }
            }
            say("screen:\n" + lines.filter { !$0.isEmpty }.suffix(12).joined(separator: "\n"))
            if let frame = window.contentView?.superview, let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) {
                frame.cacheDisplay(in: frame.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("window.png"))
            }
            // The window as the window server composites it (the page included): our own window needs no permission.
            if let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]) {
                try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("composited.png"))
                say("composited \(image.width)x\(image.height)")
            } else {
                say("composited: none")
            }
            // The page alone (WebKit may not paint a window hidden behind the others): the list drawn, the screen's area clear.
            if let web = terminals.probeWeb {
                let image: NSImage? = await withCheckedContinuation { done in web.takeSnapshot(with: nil) { image, _ in done.resume(returning: image) } }
                if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                    try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("page.png"))
                    let sx = CGFloat(rep.pixelsWide) / web.bounds.width, sy = CGFloat(rep.pixelsHigh) / web.bounds.height
                    let f = screen.view.frame
                    func alpha(_ x: CGFloat, _ y: CGFloat) -> String { rep.colorAt(x: Int(x * sx), y: Int(y * sy)).map { String(format: "a%.2f", $0.alphaComponent) } ?? "-" }
                    say("page \(rep.pixelsWide)x\(rep.pixelsHigh): screen centre \(alpha(f.midX, f.midY)), list \(alpha(40, 60))")
                }
            }
            // The screen as its layers composite it (its default background is the layer's colour).
            let v = screen.view
            say("layer bg \(v.layer?.backgroundColor.map { String(describing: $0) } ?? "none")")
            say("native bg \(v.nativeBackgroundColor) fg \(v.nativeForegroundColor) terminal bg \(v.getTerminal().backgroundColor) opaque \(v.isOpaque) metal \(v.isUsingMetalRenderer)")
            for row in [0, 5, t.rows - 1] {
                if let line = t.getLine(row: row) { say("row \(row) cell0 \(line[0].attribute)") }
            }
            if let layer = v.layer, let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(v.bounds.width * 2), pixelsHigh: Int(v.bounds.height * 2),
                                                              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                                              bytesPerRow: 0, bitsPerPixel: 0), let ctx = NSGraphicsContext(bitmapImageRep: rep) {
                ctx.cgContext.scaleBy(x: 2, y: 2)
                ctx.cgContext.translateBy(x: 0, y: v.bounds.height)
                ctx.cgContext.scaleBy(x: 1, y: -1)
                layer.render(in: ctx.cgContext)
                try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("screen-layer.png"))
            }
            exit(0)
        }
    }
}
#endif
