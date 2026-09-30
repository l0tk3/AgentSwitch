#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftTerm

/// `-terminalProbe <dir> -probeTerminal <id>` (debug builds, with `-localPort` and AGENTSWITCH_HOME of a running
/// service): opens the terminal window on that terminal behind every other window (the app is not made active), types
/// into the native screen with events of its own (`abc`, Shift+Enter, `def`), then writes what the screen holds and a
/// picture of the window to `<dir>` and quits. Nothing else of the app starts.
@MainActor
enum TerminalProbe {
    static var directory: URL? { UserDefaults.standard.string(forKey: "terminalProbe").map { URL(fileURLWithPath: $0) } }

    static func run(_ terminals: TerminalWindowController, into dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var log: [String] = []
        func say(_ line: String) { log.append(line); try? log.joined(separator: "\n").write(to: dir.appendingPathComponent("probe.txt"), atomically: true, encoding: .utf8) }
        let id = UserDefaults.standard.string(forKey: "probeTerminal") ?? ""
        TerminalWindowController.probing = true
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
                say("mouse mode \(lt.mouseMode); opened \(opened)")
                LinkOpener.probeOpened = nil
            }
            if UserDefaults.standard.bool(forKey: "probeCompose") {
                screen.view.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
                try? await Task.sleep(for: .milliseconds(400))
                say("marked rect \(NSStringFromRect(screen.view.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: nil)))")
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
