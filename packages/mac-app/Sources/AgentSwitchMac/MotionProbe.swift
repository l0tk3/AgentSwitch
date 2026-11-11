#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// `-designPreview <dir> -designPreviewOnly motion` (debug builds; no service): what Core Animation steps for the app
/// (LayerMotion.swift; docs/ui-v0.md §7.4, 2026-11-10) beside what it stands for, drawn by SwiftUI. A small window in a
/// corner of the screen for a moment, dark and light: the pixel look's spinner (every frame, the type's two sizes), the
/// waiting square (both steps, its two sizes) and words that blink with it (both steps). `motion.txt` says of each how
/// far the layer's picture is from SwiftUI's own — as the window server shows the window, and as a picture of the
/// window is drawn — and then, of a spinner, a square, blinking words and the classic look's ring left to move for a
/// second: what their layers showed, and how many times the window's SwiftUI was laid out meanwhile (none: that is the
/// point of them). Last, a click on each where it stands in a button's label: the button's, as it was while they were
/// drawn by SwiftUI. `motion-<dark|light>.png` is the window as the window server had it: SwiftUI's above, the
/// layer's below, pair by pair.
@MainActor
enum MotionProbe {
    static func run(into directory: URL) async throws {
        let log = RecordTurnProbe.Log()
        for dark in [true, false] { try await compare(dark: dark, directory: directory, log: log) }
        try await moving(log: log)
        try await clicking(log: log)
        try log.lines.joined(separator: "\n").appending("\n").write(to: directory.appendingPathComponent("motion.txt"), atomically: true, encoding: .utf8)
    }

    /// What is compared: a strip drawn by SwiftUI, and the same by a layer held still.
    private enum Kind: CaseIterable {
        case spinner12, spinner9, squares, words

        var name: String {
            switch self {
            case .spinner12: "the spinner at 12 pt"
            case .spinner9: "the spinner at 9 pt"
            case .squares: "the waiting square, 8 pt and 4 pt"
            case .words: "words that blink"
            }
        }
    }

    private struct Strip: View {
        let kind: Kind
        let layered: Bool

        var body: some View {
            HStack(spacing: 6) {
                switch kind {
                case .spinner12: spinner(12)
                case .spinner9: spinner(9)
                case .squares:
                    ForEach([2, 1] as [CGFloat], id: \.self) { pixel in
                        ForEach(0..<2, id: \.self) { step in
                            if layered { BlinkingSquare(pixel: pixel, held: step) } else { BlinkingSquare.square(dim: step == 1, pixel: pixel).frame(width: 4 * pixel, height: 4 * pixel) }
                        }
                    }
                case .words:
                    ForEach(0..<2, id: \.self) { step in
                        let words = Text("▪2 Waiting").font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.waiting)
                        if layered { words.blinks(true, held: step) } else { words.opacity(step == 1 ? BlinkView.dim : 1) }
                    }
                }
            }
            .padding(.horizontal, 6)
            // Every strip of one height: a strip's rows in a picture of the window are known by its place alone.
            .frame(height: Self.height)
        }

        @ViewBuilder
        private func spinner(_ size: CGFloat) -> some View {
            ForEach(BrailleSpinner.frames.indices, id: \.self) { frame in
                if layered { BrailleSpinner(size: size, held: frame) } else { BrailleSpinner.text(frame, size: size).frame(width: (size * 2 / 3).rounded()) }
            }
        }

        static let height: CGFloat = 26
    }

    private static func window(_ content: some View, dark: Bool, look: InterfaceLook = .pixel) -> (NSWindow, NSView) {
        let host = NSHostingView(rootView: content.environment(\.colorScheme, dark ? .dark : .light).environment(\.interfaceLook, look))
        let window = PreviewWindow(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.backgroundColor = dark ? .black : .dispatchGround
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.level = .floating
        window.ignoresMouseEvents = true
        window.setFrameOrigin(NSPoint(x: 24, y: 24))
        window.orderFrontRegardless()
        return (window, host)
    }

    private static func compare(dark: Bool, directory: URL, log: RecordTurnProbe.Log) async throws {
        let rows = Kind.allCases.flatMap { kind in [(kind, false), (kind, true)] }
        let (window, host) = window(VStack(alignment: .leading, spacing: 0) {
            ForEach(rows.indices, id: \.self) { row in Strip(kind: rows[row].0, layered: rows[row].1) }
        }, dark: dark)
        try await DesignPreview.settle()
        try await Task.sleep(for: .milliseconds(400))
        let name = dark ? "dark" : "light"
        guard let shown = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]) else {
            window.close()
            return log.say("\(name): the window server gave no picture of the window")
        }
        try NSBitmapImageRep(cgImage: shown).representation(using: .png, properties: [:])?.write(to: directory.appendingPathComponent("motion-\(name).png"))
        guard let drawn = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { window.close(); return }
        host.cacheDisplay(in: host.bounds, to: drawn)
        try drawn.representation(using: .png, properties: [:])?.write(to: directory.appendingPathComponent("motion-\(name)-drawn.png"))
        // The strips are of one height, SwiftUI's above its layer's.
        for (what, image) in [("on screen", shown), ("drawn", drawn.cgImage)] {
            guard let image, let pixels = Pixels(image) else { continue }
            let strip = pixels.height / rows.count
            for (index, kind) in Kind.allCases.enumerated() {
                let own = index * 2 * strip, layer = own + strip
                let far = pixels.difference(rowsFrom: own, and: layer, count: strip)
                log.say("\(name), \(what), \(kind.name): \(far.differing) of \(strip * pixels.width) pixels differ, the furthest by \(far.furthest) of 255; "
                        + "drawn on \(pixels.inked(from: own, count: strip)) pixels by SwiftUI, on \(pixels.inked(from: layer, count: strip)) by the layer")
            }
        }
        window.close()
    }

    /// Each left to move for a second: what its layer showed, and the layouts of the window's SwiftUI meanwhile.
    private static func moving(log: RecordTurnProbe.Log) async throws {
        func all<V: NSView>(_ type: V.Type, in view: NSView) -> [V] { (view as? V).map { [$0] } ?? view.subviews.flatMap { all(type, in: $0) } }
        func watch(_ name: String, look: InterfaceLook = .pixel, _ content: some View, layer: (NSView) -> CALayer?, says: (CALayer) -> String) async throws {
            let (window, host) = window(HStack(spacing: 8) { content; Text("Beside It").font(.system(size: 12.5, design: .monospaced)) }.padding(8), dark: true, look: look)
            defer { window.close() }
            try await DesignPreview.settle()
            guard let layer = layer(host) else { return log.say("\(name): no layer") }
            let layouts = LayoutCount(of: host)
            var seen: [String] = []
            let start = CFAbsoluteTimeGetCurrent()
            while CFAbsoluteTimeGetCurrent() - start < 1.1 {
                if let now = layer.presentation().map(says), seen.last != now { seen.append(now) }
                try await Task.sleep(for: .milliseconds(12))
            }
            log.say("\(name), moving for a second: its layer showed \(seen.count) states one after another (\(Set(seen).count) different), "
                    + "the window's SwiftUI was laid out \(layouts.count) times")
        }
        func picture(_ layer: CALayer) -> String { (layer.contents as AnyObject?).map { "\(ObjectIdentifier($0).hashValue)" } ?? "-" }
        try await watch("the spinner", BrailleSpinner(size: 12), layer: { all(SteppedGlyphView.self, in: $0).first?.layer?.sublayers?.first }, says: picture)
        try await watch("the waiting square", BlinkingSquare(), layer: { all(BlinkView.self, in: $0).first?.layer?.sublayers?.first }, says: picture)
        try await watch("words that blink", Text("▪2").font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.waiting).blinks(true),
                        layer: { all(BlinkView.self, in: $0).first?.layer?.sublayers?.first }, says: picture)
        try await watch("the classic look's waiting ring", look: .classic, ClassicWaitingDot().padding(8),
                        layer: { all(WaitingRingView.self, in: $0).first?.layer?.sublayers?.first },
                        says: { String(format: "%.1f", $0.opacity * 10) })
    }
}

extension MotionProbe {
    /// A button whose label is a spinner, a waiting square, blinking words and a word: clicked on each in turn.
    fileprivate static func clicking(log: RecordTurnProbe.Log) async throws {
        final class Count { var clicks = 0 }
        let count = Count()
        let (window, host) = window(Button { count.clicks += 1 } label: {
            HStack(spacing: 10) {
                BrailleSpinner(size: 12)
                BlinkingSquare()
                Text("▪2").font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.waiting).blinks(true)
                Text("Working").font(.system(size: 12.5, design: .monospaced))
            }
            .padding(10).contentShape(Rectangle())
        }.buttonStyle(.plain), dark: true)
        defer { window.close() }
        window.ignoresMouseEvents = false
        try await DesignPreview.settle()
        func all<V: NSView>(_ type: V.Type, in view: NSView) -> [V] { (view as? V).map { [$0] } ?? view.subviews.flatMap { all(type, in: $0) } }
        let layers: [(String, NSView)] = all(SteppedGlyphView.self, in: host).map { ("the spinner", $0) } + all(BlinkView.self, in: host).enumerated().map { ($0.offset == 0 ? "the waiting square" : "the blinking words", $0.element) }
        func click(_ at: NSPoint) async {
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                guard let e = NSEvent.mouseEvent(with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                                 context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1) else { continue }
                NSApp.postEvent(e, atStart: false)
            }
            try? await Task.sleep(for: .milliseconds(300))
        }
        for (name, view) in layers {
            let before = count.clicks
            let frame = view.convert(view.bounds, to: nil)
            await click(NSPoint(x: frame.midX, y: frame.midY))
            log.say("a click on \(name) in a button's label: \(count.clicks - before == 1 ? "the button's" : "LOST (\(count.clicks - before) clicks)")")
        }
        let before = count.clicks
        await click(NSPoint(x: host.bounds.maxX - 14, y: host.bounds.midY))
        log.say("a click on the button's word: \(count.clicks - before == 1 ? "the button's" : "LOST (\(count.clicks - before) clicks)")")
    }
}

/// How many times a SwiftUI hosting view's class was laid out since this was made (the page's own view and those
/// inside it: the method is the class's, so one replacement serves them all; a probe's process ends with the probe).
@MainActor
final class LayoutCount {
    private static var all = 0
    private static var counted: Set<ObjectIdentifier> = []
    private let from: Int
    var count: Int { Self.all - from }

    init(of host: NSView) {
        let kind: AnyClass = type(of: host)
        if Self.counted.insert(ObjectIdentifier(kind)).inserted {
            let selector = #selector(NSView.layout)
            if let method = class_getInstanceMethod(kind, selector) {
                typealias Layout = @convention(c) (AnyObject, Selector) -> Void
                let original = unsafeBitCast(method_getImplementation(method), to: Layout.self)
                let counted: @convention(block) (AnyObject) -> Void = { view in
                    MainActor.assumeIsolated { Self.all += 1 }
                    original(view, selector)
                }
                // Its own method, not one it has from the class above it (replacing that would count every view's).
                class_replaceMethod(kind, selector, imp_implementationWithBlock(counted), method_getTypeEncoding(method))
            }
        }
        from = Self.all
    }
}

/// A picture's pixels, eight bits a channel, for telling two parts of it apart.
struct Pixels {
    let width: Int
    let height: Int
    private let data: [UInt8]

    init?(_ image: CGImage) {
        width = image.width
        height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        data = bytes
    }

    /// Two bands of `count` rows: how many pixels differ at all, and the widest difference in one channel.
    func difference(rowsFrom a: Int, and b: Int, count: Int) -> (differing: Int, furthest: Int) {
        var differing = 0, furthest = 0
        for row in 0..<count where a + row < height && b + row < height {
            for column in 0..<width {
                let p = ((a + row) * width + column) * 4, q = ((b + row) * width + column) * 4
                let far = (0..<3).map { abs(Int(data[p + $0]) - Int(data[q + $0])) }.max() ?? 0
                if far > 0 { differing += 1 }
                furthest = max(furthest, far)
            }
        }
        return (differing, furthest)
    }

    /// The pixels of a band that are not its first pixel's colour (the ground): how much is drawn there.
    func inked(from: Int, count: Int) -> Int {
        let ground = Array(data[(from * width * 4)..<(from * width * 4 + 3)])
        var inked = 0
        for row in 0..<count where from + row < height {
            for column in 0..<width {
                let p = ((from + row) * width + column) * 4
                if data[p] != ground[0] || data[p + 1] != ground[1] || data[p + 2] != ground[2] { inked += 1 }
            }
        }
        return inked
    }
}
#endif
