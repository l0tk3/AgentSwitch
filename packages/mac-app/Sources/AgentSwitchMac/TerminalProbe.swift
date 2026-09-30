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
            say("first responder \(window.firstResponder.map { String(describing: type(of: $0)) } ?? "-")")
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
