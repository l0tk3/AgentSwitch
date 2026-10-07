import AgentSwitchMacCore
import SwiftUI

// How hard the agent thinks, chosen on a line (docs/terminal-v0.md §1 思考强度; 2026-10-07, user: 思考强度改成滑块调节
// 加上和官方差不多的特效，新建的时候也这样选): the levels its model takes are the line's stops, lowest first. In the
// classic look the stops are bars that rise, a signal's strength — lit up to the level, the highest level in a colour
// of its own (violet), a light passing over the lit ones. It was a thick pill with a round knob and stars, drawn after
// Codex's own, and the user found it too large and the same as Codex's (太大了，而且和codex的一模一样，可以稍微改一下): this
// is half the size and this app's own picture. In the pixel look a row of cells: a bright one running along the lit
// ones, and at the top the row in violet, twinkling. Nothing moves under Reduce Motion.

/// The line itself.
struct EffortSlider: View {
    let levels: [String]
    /// The level chosen; nil: none — the model's default.
    let level: String?
    /// What that default is, when the agent says: where the knob rests, hollow, while none is chosen.
    var fallback: String?
    var enabled = true
    /// A stop was chosen: dragged to and let go, clicked, or stepped to with ← →.
    let choose: (String) -> Void
    @Environment(\.interfaceLook) private var look
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var dragging: Int?
    @FocusState private var focused: Bool

    /// The room the line is drawn in: the tallest bar's height (the pixel look's cells with their ticks).
    private static let height: CGFloat = 22
    /// A bar's share of the width at most: the bars stand together at the leading edge of a wide row.
    private static let stride: CGFloat = 17
    /// A stop is in the middle of its bar: half a share inside each end. The pixel look's row of cells runs from end to
    /// end, its first and last stops a little inside.
    private func inset(_ width: CGFloat) -> CGFloat { look.isClassic ? width / CGFloat(max(levels.count, 1)) / 2 : 12 }

    var body: some View {
        let chosen = EffortScale.index(of: level, in: levels)
        let resting = chosen ?? EffortScale.index(of: fallback, in: levels)
        let at = dragging ?? resting
        VStack(spacing: 3) {
            GeometryReader { geo in
                let inset = inset(geo.size.width)
                let width = Double(geo.size.width - inset * 2)
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: still || !enabled || (at ?? 0) == 0)) { context in
                    Canvas { g, size in
                        draw(&g, size: size, at: at, firm: dragging != nil || chosen != nil, time: context.date.timeIntervalSinceReferenceDate)
                    }
                }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { value in dragging = EffortScale.stop(at: Double(value.location.x - inset), width: width, count: levels.count) }
                    .onEnded { value in
                        let stop = EffortScale.stop(at: Double(value.location.x - inset), width: width, count: levels.count)
                        dragging = nil
                        if levels.indices.contains(stop) { choose(levels[stop]) }
                    })
            }
            .frame(height: Self.height)
            // The bars stand together; the pixel look's cells run the row's width.
            .frame(maxWidth: look.isClassic ? CGFloat(levels.count) * Self.stride : .infinity, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .opacity(enabled ? 1 : 0.45)
        .allowsHitTesting(enabled)
        .focusable(enabled)
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.leftArrow) { step(-1, from: chosen, start: resting) }
        .onKeyPress(.rightArrow) { step(1, from: chosen, start: resting) }
        .accessibilityElement()
        .accessibilityLabel("Level")
        .accessibilityValue(at.map { TerminalEffort.name(levels[$0]) } ?? "Default")
        .accessibilityAdjustableAction { direction in _ = step(direction == .increment ? 1 : -1, from: chosen, start: resting) }
    }

    private func step(_ delta: Int, from chosen: Int?, start: Int?) -> KeyPress.Result {
        guard enabled, let next = EffortScale.step(from: chosen, by: delta, start: start, count: levels.count) else { return .ignored }
        if next != chosen { choose(levels[next]) }
        return .handled
    }

    private func draw(_ g: inout GraphicsContext, size: CGSize, at: Int?, firm: Bool, time: Double) {
        let count = levels.count
        let inset = inset(size.width)
        let width = Double(size.width - inset * 2)
        let mid = size.height / 2 - 1
        func x(_ index: Int) -> CGFloat { inset + CGFloat(EffortScale.place(of: index, width: width, count: count)) }
        let knob = at.map(x)
        let heat = at.map { EffortScale.heat($0, count: count) } ?? 0
        let moving = !still && enabled && heat > 0
        let top = heat >= 1 && count > 1
        let colour = top ? Look.top : Color.signal
        /// A number in 0 ..< 1 that is always the same for the same star.
        func chance(_ seed: Double) -> Double { let v = sin(seed) * 43758.5453; return v - v.rounded(.down) }

        if look.isClassic {
            // Bars that rise, one a level: lit up to the level chosen, the rest faint. Where none is chosen the model's
            // own level is lit faintly. A light passes over the lit ones, the quicker the higher.
            let share = size.width / CGFloat(max(count, 1))
            // Narrow and tall, as a signal's bars are.
            let wide = min(share - 6, 10)
            let lowest: CGFloat = 6, tallest = size.height - 2
            let lap = 3.2 - 1.6 * heat
            let light = moving ? (time.truncatingRemainder(dividingBy: lap) / lap) * Double(count + 2) - 1 : -9
            for index in 0..<count {
                let tall = count > 1 ? lowest + (tallest - lowest) * CGFloat(index) / CGFloat(count - 1) : tallest
                let bar = Path(roundedRect: CGRect(x: x(index) - wide / 2, y: size.height - 1 - tall, width: wide, height: tall), cornerRadius: 2.5)
                guard let at, index <= at else { g.fill(bar, with: .color(Look.ink.opacity(0.11))); continue }
                g.fill(bar, with: .color(colour.opacity(firm ? 0.62 + 0.38 * Double(index + 1) / Double(at + 1) : 0.3)))
                let near = max(0, 1 - abs(Double(index) - light))
                if near > 0, firm { g.fill(bar, with: .color(.white.opacity(0.32 * near))) }
            }
        } else {
            // A row of cells; the lit ones up to the knob, a bright one running along them.
            let cell: CGFloat = 6, gap: CGFloat = 2, tall: CGFloat = 18
            let cells = max(1, Int((size.width + gap) / (cell + gap)))
            let lit = knob.map { min(cells, Int($0 / (cell + gap)) + 1) } ?? 0
            let lap = 2.8 - 1.9 * heat
            let runner = moving && lit > 1 ? Int(time.truncatingRemainder(dividingBy: lap) / lap * Double(lit)) : -1
            let frame = Int(time * 9)
            let strength = firm ? 0.55 + 0.45 * heat : 0.3
            for index in 0..<cells {
                let rect = CGRect(x: CGFloat(index) * (cell + gap), y: mid - tall / 2, width: cell, height: tall)
                guard index < lit else { g.fill(Path(rect), with: .color(Look.ink.opacity(0.13))); continue }
                if index == runner { g.fill(Path(rect), with: .color(Look.ink)); continue }
                // At the highest the row twinkles: a cell or two dim for a moment.
                let dim = top && moving && chance(Double(index) * 7.31 + Double(frame) * 1.93) > 0.9
                g.fill(Path(rect), with: .color(colour.opacity(dim ? strength * 0.4 : strength)))
            }
            for index in 0..<count {
                g.fill(Path(CGRect(x: x(index) - 0.5, y: mid + tall / 2 + 2, width: 1, height: 3)), with: .color(Look.ink.opacity(0.4)))
            }
            guard let knob else { return }
            let bar = CGRect(x: knob - 2, y: mid - tall / 2 - 3, width: 4, height: tall + 6)
            if firm { g.fill(Path(bar), with: .color(Look.ink)) } else { g.stroke(Path(bar.insetBy(dx: 0.5, dy: 0.5)), with: .color(Look.ink.opacity(0.6)), lineWidth: 1) }
        }
    }
}

/// The slider with its words: the agent's own word for it and the level over the line — the highest level in its own
/// colour; `Default` puts the choice back where there is one to put back. No sentence about what a level is (2026-10-07,
/// user: 描述没有必要): only a line the caller has to say (what choosing does, why it cannot be chosen now).
struct EffortPicker: View {
    @Environment(\.interfaceLook) private var look
    let word: String
    let levels: [String]
    let level: String?
    var fallback: String?
    var enabled = true
    /// A line of its own under the level's sentence (`会记成这个模型的默认…`).
    var note: String?
    let choose: (String) -> Void
    /// Back to none chosen (absent where a level is always in force: a running terminal).
    var reset: (() -> Void)?
    /// The word as the page around it writes its labels (the new-terminal panel's), in place of this one's own.
    var heading: AnyView?

    var body: some View {
        let highest = level != nil && level == levels.last && levels.count > 1
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let heading { heading } else { Text(word).mono(Look.size(11.5, look), weight: .semibold).foregroundStyle(Look.ink) }
                Spacer(minLength: 8)
                if level != nil, let reset {
                    Button(action: reset) { Text("Default").mono(Look.size(11, look)) }.buttonStyle(QuietButtonStyle())
                }
                Text(level.map(TerminalEffort.name) ?? fallback.map { "Default · \(TerminalEffort.name($0))" } ?? "Default")
                    .mono(Look.size(11.5, look), weight: .medium).foregroundStyle(level == nil ? Look.ink2 : highest ? Look.top : Color.signal)
                    .contentTransition(.opacity)
            }
            EffortSlider(levels: levels, level: level, fallback: fallback, enabled: enabled, choose: choose)
                .help(note ?? "")
            // Why it cannot be chosen now is a line; what choosing does is for whoever rests the pointer on the bars.
            if let note, !enabled {
                Text(note).font(.system(size: Look.size(11.5, look))).foregroundStyle(Look.faint).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
