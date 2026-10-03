import AgentSwitchKit
import SwiftUI

// The rest of the desktop terminal window's motion, on the phone (docs/design/implemented/phone.html, the effects
// table): the waiting blink, the block caret, rows drawn line by line and wiped out, a screen's refresh, scanlines,
// the dither, and the wordmark's reveal. All in steps, never eased; still under Reduce Motion.

/// What waits for you blinks: 1.1 s a cycle in two steps (under three times a second), every blinker on one clock.
struct WaitingBlink: ViewModifier {
    var on = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        TimelineView(.periodic(from: Date(timeIntervalSinceReferenceDate: 0), by: 0.55)) { t in
            content.opacity(on && !reduceMotion && Int(t.date.timeIntervalSinceReferenceDate / 0.55) % 2 == 1 ? 0.25 : 1)
        }
    }
}

extension View {
    func waitingBlink(_ on: Bool = true) -> some View { modifier(WaitingBlink(on: on)) }
}

/// A prompt's block caret: 1 s a cycle, in two steps.
struct BlockCaret: View {
    var width: CGFloat = 8
    var height: CGFloat = 17
    var color: Color = Theme.ink
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: Date(timeIntervalSinceReferenceDate: 0), by: 0.5)) { t in
            Rectangle().fill(color).frame(width: width, height: height)
                .opacity(!reduceMotion && Int(t.date.timeIntervalSinceReferenceDate / 0.5) % 2 == 1 ? 0 : 1)
        }
        .accessibilityHidden(true)
    }
}

/// Drawn line by line: a row that arrives with an unfold shows at its turn (22 ms a line), in one step.
struct StepIn: ViewModifier {
    let delay: Duration
    @State private var shown: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// `active`: the row came with the unfold just made (otherwise it is simply there).
    init(index: Int, active: Bool) {
        delay = .milliseconds(22 * index)
        _shown = State(initialValue: !active)
    }

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .task {
                guard !shown else { return }
                if !reduceMotion { try? await Task.sleep(for: delay) }
                shown = true
            }
    }
}

/// Wiped out top down in five steps (0.2 s) once `on` turns true; it stays gone.
struct WipeOut: ViewModifier {
    let on: Bool
    @State private var step = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let steps = 5

    func body(content: Content) -> some View {
        content
            .mask {
                GeometryReader { g in
                    let cut = g.size.height * CGFloat(step) / CGFloat(Self.steps)
                    Rectangle().frame(width: g.size.width, height: g.size.height - cut).offset(y: cut)
                }
            }
            .onChange(of: on) {
                guard on else { step = 0; return }
                guard !reduceMotion else { step = Self.steps; return }
                Task { @MainActor in
                    for s in 1...Self.steps {
                        try? await Task.sleep(for: .milliseconds(40))
                        step = s
                    }
                }
            }
    }
}

/// A screen drawn afresh (the desktop's terminal switch — a refresh, not a glitch): it comes in top down in 13 steps
/// (0.26 s), a scanline at its edge, each time `trigger` changes. `ground` covers what has not come in yet.
struct ScreenRefresh<Trigger: Equatable>: ViewModifier {
    let trigger: Trigger
    let ground: Color
    @State private var step: Int?
    @State private var run: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static var steps: Int { 13 }

    func body(content: Content) -> some View {
        content
            .overlay {
                if let step {
                    GeometryReader { g in
                        let edge = (g.size.height * CGFloat(step) / CGFloat(Self.steps)).rounded()
                        ground.frame(width: g.size.width, height: g.size.height - edge).offset(y: edge)
                        Color.white.opacity(0.9).frame(width: g.size.width, height: 2).offset(y: min(edge, g.size.height - 2))
                    }
                    .allowsHitTesting(false)
                }
            }
            .onChange(of: trigger) { play() }
            // Cut short, the cover would stay over what comes back.
            .onDisappear {
                run?.cancel()
                run = nil
                step = nil
            }
    }

    private func play() {
        guard !reduceMotion else { return }
        run?.cancel()
        run = Task { @MainActor in
            for s in 0..<Self.steps {
                step = s
                try? await Task.sleep(for: .milliseconds(20))
                guard !Task.isCancelled else { return }
            }
            step = nil
        }
    }
}

extension View {
    func screenRefresh<T: Equatable>(on trigger: T, ground: Color) -> some View { modifier(ScreenRefresh(trigger: trigger, ground: ground)) }
}

/// Scanlines behind a list (the desktop's sidebar): a 1 pt line every 3 pt at 4 % ink.
struct Scanlines: View {
    var body: some View {
        Canvas { context, size in
            var path = Path()
            var y: CGFloat = 0
            while y < size.height {
                path.addRect(CGRect(x: 0, y: y, width: size.width, height: 1))
                y += 3
            }
            context.fill(path, with: .color(Theme.ink.opacity(0.04)))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A 50 % checkerboard of 1 pt cells: a floating layer's hard shadow, and (as a mask) what cannot be used.
struct Checker: View {
    var color: Color = Theme.inkDim

    var body: some View {
        Canvas { context, size in
            var path = Path()
            var y: CGFloat = 0
            var row = 0
            while y < size.height {
                var x: CGFloat = row % 2 == 0 ? 0 : 1
                while x < size.width {
                    path.addRect(CGRect(x: x, y: y, width: 1, height: 1))
                    x += 2
                }
                y += 1
                row += 1
            }
            context.fill(path, with: .color(color))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The dithered hard shadow of a floating layer, put 6 pt down and right by the caller.
struct DitherShadow: View {
    var body: some View { Checker() }
}

extension View {
    /// Half of it dithered away: an agent that is not installed.
    func dithered(_ on: Bool = true) -> some View { mask { if on { Checker(color: .black) } else { Rectangle() } } }
}

/// The wordmark AGENTSWITCH (ui-v0 §7.2.10): ink letters with 2-cell strokes over a signal offset of one fine cell,
/// half-lit pixels in the steps. `reveal`: as it first shows, it resolves out of glyph noise cell by cell (1.1 s, 45 ms
/// a frame), shows one frame of the screen seen up close (LCD stripes, 0.28 s), then settles.
struct Wordmark: View {
    var word = "AGENTSWITCH"
    /// A letter cell: a stroke is this wide (the settled marks sit on a grid of half of it).
    var cell: CGFloat = 4
    var reveal = false
    @State private var start: Date?
    @State private var settleAt: [Double] = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let ramp = Array(" .:-=+*#%@█")
    static let noiseEnds = 1.1
    static let lcdEnds = 1.38

    var body: some View {
        let rows = PixelArt.wordRows(word)
        let cols = rows.first?.count ?? 0
        Group {
            if let start {
                TimelineView(.animation(minimumInterval: 0.045)) { t in
                    let seconds = t.date.timeIntervalSince(start)
                    Canvas { context, _ in
                        if seconds < Self.noiseEnds { noise(&context, rows: rows, seconds: seconds) } else { lcd(&context, rows: rows) }
                    }
                }
            } else {
                Canvas { context, _ in settled(&context, rows: rows) }
            }
        }
        .frame(width: CGFloat(cols + 1) * cell, height: CGFloat(rows.count + 1) * cell)
        .accessibilityElement()
        .accessibilityLabel("AgentSwitch")
        .onAppear {
            guard reveal, !reduceMotion, start == nil else { return }
            settleAt = (0..<(rows.count * cols)).map { _ in Double.random(in: 0.12...0.88) }
            start = .now
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(Self.lcdEnds))
                start = nil
            }
        }
    }

    /// Cells not settled yet show a glyph from the ramp, new each frame (the letters' cells from all of it, the rest
    /// from its faint end); a settled cell flashes the signal colour for 90 ms, then turns ink.
    private func noise(_ context: inout GraphicsContext, rows: [String], seconds: Double) {
        let font = Font.system(size: cell * 1.3, design: .monospaced)
        let lit = Self.ramp.map { context.resolve(Text(String($0)).font(font).foregroundStyle(Theme.ink)) }
        let faint = Self.ramp.prefix(4).map { context.resolve(Text(String($0)).font(font).foregroundStyle(Theme.line)) }
        let frame = Int(seconds / 0.045)
        let cols = rows.first?.count ?? 0
        for (y, row) in rows.enumerated() {
            for (x, c) in row.enumerated() {
                let on = c == "#"
                let at = settleAt.indices.contains(y * cols + x) ? settleAt[y * cols + x] : 0
                let box = CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)
                if seconds >= at {
                    if on { context.fill(Path(box), with: .color(seconds - at < 0.09 ? Theme.signal : Theme.ink)) }
                } else {
                    let pick = Self.hash(x, y, frame)
                    let glyph = on ? lit[pick % lit.count] : faint[pick % faint.count]
                    context.draw(glyph, at: CGPoint(x: box.midX, y: box.midY), anchor: .center)
                }
            }
        }
    }

    /// The screen up close: each lit cell as red, green and blue stripes over a soft glow.
    private func lcd(_ context: inout GraphicsContext, rows: [String]) {
        let cells = PixelArt.sprite(rows)
        var glow = context
        glow.addFilter(.blur(radius: cell * 0.6))
        glow.opacity = 0.5
        for c in cells { glow.fill(Path(CGRect(x: CGFloat(c.x) * cell, y: CGFloat(c.y) * cell, width: cell, height: cell)), with: .color(.white)) }
        let stripe = cell / 3
        let colours: [Color] = [Color(red: 1, green: 0.23, blue: 0.23), Color(red: 0.23, green: 1, blue: 0.48), Color(red: 0.23, green: 0.48, blue: 1)]
        for c in cells {
            for (i, colour) in colours.enumerated() {
                let r = CGRect(x: CGFloat(c.x) * cell + CGFloat(i) * stripe + stripe * 0.12, y: CGFloat(c.y) * cell + cell * 0.06,
                               width: stripe * 0.76, height: cell * 0.88)
                context.fill(Path(r), with: .color(colour))
            }
        }
    }

    private func settled(_ context: inout GraphicsContext, rows: [String]) {
        let fine = PixelArt.fine(rows)
        let f = cell / 2
        func rect(_ x: Int, _ y: Int) -> CGRect { CGRect(x: CGFloat(x) * f, y: CGFloat(y) * f, width: f, height: f) }
        let cells = PixelArt.sprite(fine)
        var shadow = Path(), half = Path(), ink = Path()
        for c in cells { shadow.addRect(rect(c.x + 1, c.y + 1)) }
        for c in PixelArt.halfLit(fine) { half.addRect(rect(c.x, c.y)) }
        for c in cells { ink.addRect(rect(c.x, c.y)) }
        context.fill(shadow, with: .color(Theme.signal))
        context.fill(half, with: .color(Theme.ink.opacity(0.42)))
        context.fill(ink, with: .color(Theme.ink))
    }

    private static func hash(_ x: Int, _ y: Int, _ frame: Int) -> Int {
        var h = UInt64(truncatingIfNeeded: x &* 73_856_093 ^ y &* 19_349_663 ^ frame &* 83_492_791)
        h = h &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return Int(h >> 33)
    }
}
