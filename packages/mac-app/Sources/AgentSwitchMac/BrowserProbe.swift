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
/// refused path, navigation, reload) and writes what came back to `probe.txt`; closes the tab and quits. Since
/// 2026-10-03 it also waits for the tab to be this Mac's (your own tab on screen) with frames at the display's device
/// pixels drawn one CSS pixel to a point, closes and opens the tab list (`browser-list-closed.png`), the tab's size
/// following the screen, and drags the list's edge (wider, past the left to close it, a double click to reset it).
/// It also zooms the page (docs/browser-v0.md §1 页面缩放): ⌘= twice to 125 % — the tab at the screen's size ÷ 1.25,
/// drawn across the screen —, a click on the field and a letter typed there (`browser-zoom.png`), ⌘− to 110 %, two
/// more to 90 % (fewer frame pixels to a CSS pixel there), and back to 100 %, the site forgotten.
/// What a healthy run writes: every line of a size in `probe.txt` (`claimed`, the four `zoom …`, `list closed`,
/// `list open`, `after the drag`, `after the reset`) reads `yes` — the frame came at the display's pixels times the
/// zoom, and each is drawn on one of the display's. 110 % is the step at a scale between quarters (2.2
/// frame pixels to a CSS pixel on a 2x display), which the daemon draws as asked since 2026-10-03: `no` on that line
/// alone, its frame at the quarter below (`scale 2.0`), is a service that still draws in quarter steps — the page in
/// the same place, enlarged from fewer pixels.
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
            // The other two walks (BrowserProbe+Windows.swift): the engine's box alone, and tabs with windows of their own.
            if mode == "engine" { await engineWalk(browser, window, dir: dir, say: say); exit(0) }
            if browser.windows { await windowsWalk(browser, window, model: model, file: file, dir: dir, say: say); exit(0) }
            let opened = await browser.open(.path(file.path))
            say("open \(file.lastPathComponent): \(opened ? "ok" : "FAIL") \(browser.openError ?? "") → tab \(browser.selectedID ?? "-") \(browser.current?.url ?? "")")
            guard opened else { exit(1) }
            for _ in 0..<80 where !browser.hasFrame || !browser.screen.hasFrame {
                try? await Task.sleep(for: .milliseconds(250))
            }
            // Your own tab on screen is this Mac's (尺寸有主, 2026-10-03): taken, at the screen's size, its frames at the
            // display's device pixels, drawn one CSS pixel to a point.
            let backing = Double(window.backingScaleFactor)
            for _ in 0..<40 where browser.current?.heldBy != BrowserDefaults.screen || (browser.screen.geometry?.scale ?? 0) < backing {
                try? await Task.sleep(for: .milliseconds(250))
            }
            try? await Task.sleep(for: .seconds(1))
            say("frame: \(browser.screen.geometry.map { "\(Int($0.width))x\(Int($0.height)) scale \($0.scale) seq \($0.seq)" } ?? "none"), screen \(NSStringFromSize(browser.screen.bounds.size)), title \(browser.current.map(BrowserTabText.title) ?? "-")")
            say(sizeLine("claimed", browser, backing: backing))
            shot(window, dir.appendingPathComponent("browser.png"))

            // Click the field, type with key events, commit Chinese as an input method does, press Return.
            window.makeKey()
            window.makeFirstResponder(browser.screen)
            clickField(browser, window, say)
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

            // The page's zoom (2026-10-03), by the window's own keys: ⌘= twice to 125 %, the tab at the screen's size
            // ÷ 1.25 and drawn across the screen; a click still lands on the field and typing goes on in it; ⌘− a step
            // back; then 100 % again, which forgets the site.
            let traced = browser.probeTrace.count
            for _ in 0..<2 {
                key(window, "=", 24, flags: .command)
                try? await Task.sleep(for: .seconds(2))
            }
            say(sizeLine("zoom \(browser.zoom.map(BrowserZoomText.percent) ?? "-")", browser, backing: backing))
            clickField(browser, window, say)
            try? await Task.sleep(for: .milliseconds(600))
            key(window, "z", 6)
            try? await Task.sleep(for: .seconds(2))
            shot(window, dir.appendingPathComponent("browser-zoom.png"))
            say("zoomed: a click on the field + z (see browser-zoom.png: the page 1.25 times as large across the screen, \"typed: abc 你好z\", presses: 2)")
            for line in browser.probeTrace.dropFirst(traced) { say("  \(line)") }
            key(window, "-", 27, flags: .command)
            try? await Task.sleep(for: .seconds(2))
            say(sizeLine("zoom \(browser.zoom.map(BrowserZoomText.percent) ?? "-")", browser, backing: backing))
            // Two more steps out, past 100 % to 90 %: fewer frame pixels to a CSS pixel, each still on one of the display's.
            for _ in 0..<2 {
                key(window, "-", 27, flags: .command)
                try? await Task.sleep(for: .seconds(2))
            }
            say(sizeLine("zoom \(browser.zoom.map(BrowserZoomText.percent) ?? "-")", browser, backing: backing))
            browser.zoomReset()
            try? await Task.sleep(for: .seconds(2))
            let kept = browser.current.flatMap(BrowserZoomMemory.site(of:)).flatMap(browser.zoomMemory.percent(for:))
            say(sizeLine("zoom \(browser.zoom.map(BrowserZoomText.percent) ?? "-")", browser, backing: backing) + ", the site remembered at \(kept.map { "\($0) %" } ?? "nothing")")

            // The list closed and opened again (⌘B): the screen widens and the tab's size follows it.
            browser.toggleList()
            try? await Task.sleep(for: .seconds(2))
            say(sizeLine("list closed", browser, backing: backing))
            shot(window, dir.appendingPathComponent("browser-list-closed.png"))
            browser.toggleList()
            try? await Task.sleep(for: .seconds(2))
            say(sizeLine("list open", browser, backing: backing))

            // The list's edge dragged as a person drags it: wider, then past the left edge (closed), opened again, and a
            // double click back to the default width.
            await dragEdge(window, to: 400, say)
            say("edge dragged to 400: \(sideLine(browser)); \(sizeLine("after the drag", browser, backing: backing))")
            await dragEdge(window, to: 60, say)
            say("edge dragged to 60: \(sideLine(browser))")
            browser.toggleList()
            try? await Task.sleep(for: .seconds(1))
            say("opened again: \(sideLine(browser))")
            if let grip = view(named: "GripView", in: window.contentView) {
                let at = grip.convert(CGPoint(x: grip.bounds.midX, y: grip.bounds.midY), to: nil)
                mouse(grip, .leftMouseDown, at: at, window: window, clicks: 1)
                mouse(grip, .leftMouseUp, at: at, window: window, clicks: 1)
                mouse(grip, .leftMouseDown, at: at, window: window, clicks: 2)
                mouse(grip, .leftMouseUp, at: at, window: window, clicks: 2)
            }
            try? await Task.sleep(for: .seconds(1))
            say("double click: \(sideLine(browser)); \(sizeLine("after the reset", browser, backing: backing))")

            // Take over: the tab takes the screen's size.
            let wanted = browser.screen.viewportRequest
            await browser.takeOver()
            try? await Task.sleep(for: .seconds(2))
            let held = browser.current
            say("take over: heldBy \(held?.heldBy ?? "-"), viewport \(held.map { "\($0.viewport.width)x\($0.viewport.height)@\($0.viewport.scale) by \($0.viewport.by ?? "-")" } ?? "-"), asked \(wanted.map { "\($0.width)x\($0.height)@\($0.scale)" } ?? "-"), frame \(browser.screen.geometry.map { "\(Int($0.width))x\(Int($0.height))" } ?? "-")")
            shot(window, dir.appendingPathComponent("browser-held.png"))
            await browser.handBack()
            try? await Task.sleep(for: .seconds(1))
            say("hand back (your own tab on screen: this Mac's again): heldBy \(browser.current?.heldBy ?? "-"), viewport \(browser.current.map { "\($0.viewport.width)x\($0.viewport.height)" } ?? "-")")

            let client = model.client
            let id = browser.selectedID ?? ""
            await step("browserTabs", say) { let l = try await client.browserTabs(); return "running \(l.running), groups \(l.groups.map { "\($0.owner.label):\($0.tabs.count)" })" }
            await step("localServers", say) { try await client.localServers().map { "\($0.port) \($0.name)" }.joined(separator: ", ") }
            await step("openTab refused", say) { let t = try await client.openTab(.path("~/.ssh/id_ed25519")); return "UNEXPECTED \(t.id)" }
            await step("navigate", say) { try await client.navigate(tabId: id, to: .typed(file.absoluteString + "#again"), screen: BrowserDefaults.screen).url }
            await step("history reload", say) { try await client.history(tabId: id, .reload, screen: BrowserDefaults.screen).url }
            // Your own tab on screen is this Mac's again at once (尺寸有主): another screen may not size it.
            await step("viewport by a screen not holding it", say) { let t = try await client.setViewport(tabId: id, BrowserViewportRequest(width: 800, height: 600), screen: "mac-probe-other"); return "UNEXPECTED \(t.viewport)" }
            await browser.close(id)
            say("closed: \(browser.list.tabs.count) tabs left")
            exit(0)
        }
    }

    /// A click in the middle of the test page's field, where the screen draws it now. Handed to the screen itself: a
    /// posted click on a window of an app that is not active only activates it.
    private static func clickField(_ browser: BrowserPageModel, _ window: NSWindow, _ say: (String) -> Void) {
        let screen = browser.screen
        guard let geometry = screen.geometry,
              let rect = BrowserGeometry.viewRect(field, frame: geometry, in: screen.bounds.size, zoom: screen.zoom) else { return }
        let point = screen.convert(CGPoint(x: rect.midX, y: rect.midY), to: nil)
        mouse(screen, .leftMouseDown, at: point, window: window, clicks: 1)
        mouse(screen, .leftMouseUp, at: point, window: window, clicks: 1)
        say("click at view \(Int(rect.midX)),\(Int(rect.midY)) (window \(Int(point.x)),\(Int(point.y)))")
    }

    /// The list's edge pressed, moved past the slop and let go at window x `x` (the page starts at the window's left).
    private static func dragEdge(_ window: NSWindow, to x: CGFloat, _ say: (String) -> Void) async {
        guard let grip = view(named: "GripView", in: window.contentView) else { return say("FAIL no list edge") }
        let start = grip.convert(CGPoint(x: grip.bounds.midX, y: grip.bounds.midY), to: nil)
        mouse(grip, .leftMouseDown, at: start, window: window, clicks: 1)
        mouse(grip, .leftMouseDragged, at: CGPoint(x: start.x + 10, y: start.y), window: window, clicks: 1)
        mouse(grip, .leftMouseDragged, at: CGPoint(x: x, y: start.y), window: window, clicks: 1)
        mouse(grip, .leftMouseUp, at: CGPoint(x: x, y: start.y), window: window, clicks: 1)
        try? await Task.sleep(for: .seconds(1.5))
    }

    /// A mouse event handed to `view` itself (a posted one would activate the app first).
    private static func mouse(_ view: NSView, _ type: NSEvent.EventType, at point: CGPoint, window: NSWindow, clicks: Int) {
        guard let e = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                         windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1) else { return }
        switch type {
        case .leftMouseDown: view.mouseDown(with: e)
        case .leftMouseDragged: view.mouseDragged(with: e)
        case .leftMouseUp: view.mouseUp(with: e)
        default: break
        }
    }

    /// The first view under `root` whose class name ends with `name`.
    private static func view(named name: String, in root: NSView?) -> NSView? {
        guard let root else { return nil }
        if String(describing: type(of: root)).hasSuffix(name) { return root }
        for sub in root.subviews { if let found = view(named: name, in: sub) { return found } }
        return nil
    }

    private static func sideLine(_ browser: BrowserPageModel) -> String {
        "list \(browser.side.closed ? "closed" : "open") at \(Int(browser.side.width)), screen \(NSStringFromSize(browser.screen.bounds.size))"
    }

    /// Who holds the tab, its size, the frame and where it is drawn: one CSS pixel to a point when the frame's scale is
    /// the display's and its rectangle is the page's CSS size; at another zoom of the page, as many points to a CSS pixel
    /// as the zoom, the frame's scale the display's times the zoom (a frame pixel on a pixel of the display; never under
    /// the CSS size nor over the daemon's limit, BrowserScreenPolicy.frameScale). `no` when
    /// the frame came at another scale than asked or is fitted instead (see the header for what a healthy run reads).
    private static func sizeLine(_ what: String, _ browser: BrowserPageModel, backing: Double) -> String {
        let tab = browser.current
        let geometry = browser.screen.geometry
        let zoom = browser.screen.zoom
        let drawn = geometry.map { BrowserGeometry.fit($0, in: browser.screen.bounds.size, zoom: zoom) } ?? .zero
        let exact = geometry.map { abs(Double(drawn.width) - $0.width * zoom / $0.scale) < 0.5 && abs($0.scale - BrowserScreenPolicy.frameScale(backingScale: backing, zoom: zoom)) < 0.01 } ?? false
        let each = zoom == 1 ? "a point" : "\(zoom) points"
        return "\(what): heldBy \(tab?.heldBy ?? "-"), viewport \(tab.map { "\($0.viewport.width)x\($0.viewport.height)@\($0.viewport.scale) by \($0.viewport.by ?? "-")" } ?? "-"), "
            + "screen \(NSStringFromSize(browser.screen.bounds.size)), frame \(geometry.map { "\(Int($0.width))x\(Int($0.height)) scale \($0.scale)" } ?? "-"), "
            + "drawn \(NSStringFromRect(drawn)), one CSS pixel to \(each) at \(backing)x: \(exact ? "yes" : "no")"
    }

    private static func step(_ name: String, _ say: (String) -> Void, _ body: () async throws -> String) async {
        do { say("ok   \(name): \(try await body())") } catch { say("err  \(name): \(BrowserPageModel.describe(error))") }
    }

    /// A key pressed and let go, posted to the app: the window's own keys see it first (`flags`: ⌘ for the zoom's).
    private static func key(_ window: NSWindow, _ chars: String, _ code: UInt16, flags: NSEvent.ModifierFlags = []) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil, characters: chars,
                                           charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) else { continue }
            NSApp.postEvent(e, atStart: false)
        }
    }

    static func shot(_ window: NSWindow, _ file: URL) {
        guard let view = window.contentView?.superview ?? window.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: file)
    }
}
#endif
