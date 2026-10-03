#if DEBUG
import AgentSwitchMacCore
import AppKit

/// `-browserProbe <dir>` (debug builds, with `-localPort` and AGENTSWITCH_HOME of a running service, e.g. an
/// `AGENTSWITCH_ROUTER=echo` daemon with throw-away data — its Chrome runs on that home's profile, never the user's):
/// opens the main window's Browser page behind every other window (the app is not made active), writes a test page
/// into `<dir>` and opens it in a new tab, waits for its picture and writes `browser.png`; then clicks the page's field
/// and types into it with events of its own (keys through the screen's text input, Chinese committed as an input
/// method commits, Return) and writes `browser-typed.png`; takes the tab over (the size becomes the screen's) and writes
/// `browser-held.png`; hands it back; goes through the remaining BrowserService calls (the list, the local servers, a
/// refused path, navigation, reload) and writes what came back to `probe.txt`; closes the tab and quits.
@MainActor
enum BrowserProbe {
    static var directory: URL? { UserDefaults.standard.string(forKey: "browserProbe").map { URL(fileURLWithPath: $0) } }

    /// The test page: a field at a known place (CSS pixels), what was typed and how many presses, and room to scroll.
    static let page = """
    <!doctype html><meta charset="utf-8"><title>Probe Page</title>
    <style>body{margin:0;font:20px -apple-system,sans-serif;background:#fff;color:#1f2328}h1{position:absolute;left:40px;top:20px;margin:0;font-size:28px}
    #i{position:absolute;left:40px;top:120px;width:400px;height:40px;font-size:20px;box-sizing:border-box}#out{position:absolute;left:40px;top:200px;font-size:28px;color:#0969da}
    #n{position:absolute;left:40px;top:260px}#tall{position:absolute;top:0;left:0;width:1px;height:3000px}</style>
    <h1>AgentSwitch Browser Probe</h1><input id="i" placeholder="type here"><div id="out">(nothing yet)</div><div id="n">presses: 0</div><div id="tall"></div>
    <script>const i=document.getElementById('i'),o=document.getElementById('out');let n=0;
    i.addEventListener('input',()=>{o.textContent='typed: '+i.value});
    i.addEventListener('keydown',e=>{if(e.key==='Enter')o.textContent='entered: '+i.value});
    document.addEventListener('mousedown',()=>{n++;document.getElementById('n').textContent='presses: '+n});</script>
    """
    /// The field's box on the page, CSS pixels.
    static let field = BrowserBox(x: 40, y: 120, width: 400, height: 40)

    static func run(_ main: MainWindowController, model: AppModel, into dir: URL) {
        model.probeServiceUp()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var log: [String] = []
        func say(_ line: String) {
            log.append(line)
            try? log.joined(separator: "\n").write(to: dir.appendingPathComponent("probe.txt"), atomically: true, encoding: .utf8)
        }
        let file = dir.appendingPathComponent("probe-page.html")
        try? page.write(to: file, atomically: true, encoding: .utf8)
        MainWindowController.probing = true
        main.show(.browser)
        Task {
            try? await Task.sleep(for: .seconds(1))
            guard let browser = main.probeBrowser, let window = main.window else { say("FAIL no window"); exit(1) }
            await browser.refresh()
            say("list: \(browser.list.tabs.count) tabs, running \(browser.list.running), problem \(browser.problem ?? "-")")
            let opened = await browser.open(.path(file.path))
            say("open \(file.lastPathComponent): \(opened ? "ok" : "FAIL") \(browser.openError ?? "") → tab \(browser.selectedID ?? "-") \(browser.current?.url ?? "")")
            guard opened else { exit(1) }
            for _ in 0..<80 where !browser.hasFrame || !browser.screen.hasFrame {
                try? await Task.sleep(for: .milliseconds(250))
            }
            try? await Task.sleep(for: .seconds(1))
            say("frame: \(browser.screen.geometry.map { "\(Int($0.width))x\(Int($0.height)) scale \($0.scale) seq \($0.seq)" } ?? "none"), screen \(NSStringFromSize(browser.screen.bounds.size)), title \(browser.current.map(BrowserTabText.title) ?? "-")")
            shot(window, dir.appendingPathComponent("browser.png"))

            // Click the field, type with key events, commit Chinese as an input method does, press Return.
            window.makeKey()
            window.makeFirstResponder(browser.screen)
            if let geometry = browser.screen.geometry, let rect = BrowserGeometry.viewRect(field, frame: geometry, in: browser.screen.bounds.size) {
                let point = browser.screen.convert(CGPoint(x: rect.midX, y: rect.midY), to: nil)
                // Handed to the screen itself: a posted click on a window of an app that is not active only activates it.
                for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                    guard let e = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                     windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { continue }
                    if type == .leftMouseDown { browser.screen.mouseDown(with: e) } else { browser.screen.mouseUp(with: e) }
                }
                say("click at view \(Int(rect.midX)),\(Int(rect.midY)) (window \(Int(point.x)),\(Int(point.y)))")
            }
            try? await Task.sleep(for: .milliseconds(600))
            for (chars, code) in [("a", UInt16(0)), ("b", 11), ("c", 8), (" ", 49)] { key(window, chars, code) }
            try? await Task.sleep(for: .milliseconds(400))
            browser.screen.insertText("你好", replacementRange: NSRange(location: NSNotFound, length: 0))
            try? await Task.sleep(for: .milliseconds(400))
            key(window, "\r", 36)
            try? await Task.sleep(for: .seconds(2))
            shot(window, dir.appendingPathComponent("browser-typed.png"))
            say("typed: abc + 你好 + Enter (see browser-typed.png: \"entered: abc 你好\", presses: 1)")
            for line in browser.probeTrace { say("  \(line)") }

            // Take over: the tab takes the screen's size.
            let wanted = browser.screen.viewportRequest
            await browser.takeOver()
            try? await Task.sleep(for: .seconds(2))
            let held = browser.current
            say("take over: heldBy \(held?.heldBy ?? "-"), viewport \(held.map { "\($0.viewport.width)x\($0.viewport.height)@\($0.viewport.scale) by \($0.viewport.by ?? "-")" } ?? "-"), asked \(wanted.map { "\($0.width)x\($0.height)@\($0.scale)" } ?? "-"), frame \(browser.screen.geometry.map { "\(Int($0.width))x\(Int($0.height))" } ?? "-")")
            shot(window, dir.appendingPathComponent("browser-held.png"))
            await browser.handBack()
            try? await Task.sleep(for: .seconds(1))
            say("hand back: heldBy \(browser.current?.heldBy ?? "-"), viewport \(browser.current.map { "\($0.viewport.width)x\($0.viewport.height)" } ?? "-")")

            let client = model.client
            let id = browser.selectedID ?? ""
            await step("browserTabs", say) { let l = try await client.browserTabs(); return "running \(l.running), groups \(l.groups.map { "\($0.owner.label):\($0.tabs.count)" })" }
            await step("localServers", say) { try await client.localServers().map { "\($0.port) \($0.name)" }.joined(separator: ", ") }
            await step("openTab refused", say) { let t = try await client.openTab(.path("~/.ssh/id_ed25519")); return "UNEXPECTED \(t.id)" }
            await step("navigate", say) { try await client.navigate(tabId: id, to: .typed(file.absoluteString + "#again"), screen: BrowserDefaults.screen).url }
            await step("history reload", say) { try await client.history(tabId: id, .reload, screen: BrowserDefaults.screen).url }
            await step("viewport unheld", say) { let t = try await client.setViewport(tabId: id, BrowserViewportRequest(width: 800, height: 600), screen: BrowserDefaults.screen); return "UNEXPECTED \(t.viewport)" }
            await browser.close(id)
            say("closed: \(browser.list.tabs.count) tabs left")
            exit(0)
        }
    }

    private static func step(_ name: String, _ say: (String) -> Void, _ body: () async throws -> String) async {
        do { say("ok   \(name): \(try await body())") } catch { say("err  \(name): \(BrowserPageModel.describe(error))") }
    }

    private static func key(_ window: NSWindow, _ chars: String, _ code: UInt16) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil, characters: chars,
                                           charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) else { continue }
            NSApp.postEvent(e, atStart: false)
        }
    }

    private static func shot(_ window: NSWindow, _ file: URL) {
        guard let view = window.contentView?.superview ?? window.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: file)
    }
}
#endif
