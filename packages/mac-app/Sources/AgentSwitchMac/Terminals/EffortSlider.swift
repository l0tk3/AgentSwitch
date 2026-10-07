import AgentSwitchMacCore
import SwiftUI

// How hard the agent thinks, chosen on a line (docs/terminal-v0.md §1 思考强度; 2026-10-07, user: 思考强度改成滑块调节
// 加上和官方差不多的特效，新建的时候也这样选): the levels its model takes are the line's stops, lowest first. The line
// is livelier the higher the level — a sheen running along its filled part, faster and brighter stop by stop, and at
// the highest a glow around the knob with sparks off it; in the pixel look the same in cells, a bright one running
// along the lit ones and the row flickering at the top. Nothing moves under Reduce Motion.

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

    private static let height: CGFloat = 30
    /// The first and last stops stand this far inside the ends: the knob stays whole.
    private static let inset: CGFloat = 10

    var body: some View {
        let chosen = EffortScale.index(of: level, in: levels)
        let resting = chosen ?? EffortScale.index(of: fallback, in: levels)
        let at = dragging ?? resting
        VStack(spacing: 3) {
            GeometryReader { geo in
                let width = Double(geo.size.width - Self.inset * 2)
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: still || !enabled || (at ?? 0) == 0)) { context in
                    Canvas { g, size in
                        draw(&g, size: size, at: at, firm: dragging != nil || chosen != nil, time: context.date.timeIntervalSinceReferenceDate)
                    }
                }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { value in dragging = EffortScale.stop(at: Double(value.location.x - Self.inset), width: width, count: levels.count) }
                    .onEnded { value in
                        let stop = EffortScale.stop(at: Double(value.location.x - Self.inset), width: width, count: levels.count)
                        dragging = nil
                        if levels.indices.contains(stop) { choose(levels[stop]) }
                    })
            }
            .frame(height: Self.height)
            HStack {
                Text(levels.first.map(TerminalEffort.name) ?? "")
                Spacer(minLength: 8)
                Text(levels.last.map(TerminalEffort.name) ?? "")
            }
            .mono(10.5).foregroundStyle(Look.faint)
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
        let width = Double(size.width - Self.inset * 2)
        let mid = size.height / 2 + 3
        func x(_ index: Int) -> CGFloat { Self.inset + CGFloat(EffortScale.place(of: index, width: width, count: count)) }
        let knob = at.map(x)
        let heat = at.map { EffortScale.heat($0, count: count) } ?? 0
        let moving = !still && enabled && heat > 0
        let top = heat >= 1 && count > 1
        // The sheen's lap: quicker the higher.
        let lap = 2.8 - 1.9 * heat
        let phase = time.truncatingRemainder(dividingBy: lap) / lap
        let strength = firm ? 0.5 + 0.5 * heat : 0.28

        if look.isClassic {
            let track = CGRect(x: Self.inset - 4, y: mid - 3, width: CGFloat(width) + 8, height: 6)
            g.fill(Path(roundedRect: track, cornerRadius: 3), with: .color(Look.ink.opacity(0.10)))
            if let knob {
                let fill = CGRect(x: track.minX, y: track.minY, width: knob - track.minX, height: track.height)
                var inner = g
                inner.clip(to: Path(roundedRect: fill, cornerRadius: 3))
                inner.fill(Path(fill), with: .color(Color.signal.opacity(strength)))
                if moving {
                    let band: CGFloat = 54
                    let from = fill.minX - band + (fill.width + band) * CGFloat(phase)
                    inner.fill(Path(CGRect(x: from, y: fill.minY, width: band, height: fill.height)),
                               with: .linearGradient(Gradient(colors: [.white.opacity(0), .white.opacity(0.3 + 0.55 * heat), .white.opacity(0)]),
                                                     startPoint: CGPoint(x: from, y: mid), endPoint: CGPoint(x: from + band, y: mid)))
                }
            }
            for index in 0..<count {
                let on = at.map { index <= $0 } ?? false
                g.fill(Path(ellipseIn: CGRect(x: x(index) - 1.5, y: mid - 1.5, width: 3, height: 3)), with: .color(on ? Color.white.opacity(0.9) : Look.ink.opacity(0.3)))
            }
            guard let knob else { return }
            if top, moving {
                // At the highest: a glow breathing around the knob, and sparks off it.
                let breath = 0.5 + 0.5 * sin(time * 3.2)
                g.fill(Path(ellipseIn: CGRect(x: knob - 14, y: mid - 14, width: 28, height: 28)), with: .color(Color.signal.opacity(0.10 + 0.14 * breath)))
                for spark in 0..<6 {
                    let life = (time * 0.85 + Double(spark) * 0.167).truncatingRemainder(dividingBy: 1)
                    let lean = sin(Double(spark) * 2.4) * 11
                    let point = CGPoint(x: knob + CGFloat(lean * life), y: mid - 9 - CGFloat(life) * 11)
                    g.fill(Path(ellipseIn: CGRect(x: point.x - 1.2, y: point.y - 1.2, width: 2.4, height: 2.4)), with: .color(Color.signal.opacity((1 - life) * 0.9)))
                }
            }
            let circle = Path(ellipseIn: CGRect(x: knob - 8, y: mid - 8, width: 16, height: 16))
            var shaded = g
            shaded.addFilter(.shadow(color: .black.opacity(0.22), radius: 2.5, y: 1))
            shaded.fill(circle, with: .color(firm ? .white : Look.panel))
            g.stroke(circle, with: .color(firm ? Color.signal.opacity(0.9) : Look.ink.opacity(0.35)), lineWidth: firm ? 1.5 : 1)
        } else {
            // A row of cells; the lit ones up to the knob, a bright one running along them.
            let cell: CGFloat = 5, gap: CGFloat = 2, tall: CGFloat = 12
            let start = Self.inset - 3
            let cells = max(1, Int((CGFloat(width) + 6 + gap) / (cell + gap)))
            let lit = knob.map { min(cells, Int(($0 - start) / (cell + gap)) + 1) } ?? 0
            let runner = moving && lit > 1 ? Int(phase * Double(lit)) : -1
            let frame = Int(time * 14)
            for index in 0..<cells {
                let rect = CGRect(x: start + CGFloat(index) * (cell + gap), y: mid - tall / 2, width: cell, height: tall)
                guard index < lit else { g.fill(Path(rect), with: .color(Look.ink.opacity(0.13))); continue }
                if index == runner { g.fill(Path(rect), with: .color(Look.ink)); continue }
                // At the highest the row flickers, a few cells dimmer each frame.
                let flicker = top && moving && (index &* 7919 &+ frame &* 104729) % 9 == 0
                g.fill(Path(rect), with: .color(Color.signal.opacity(flicker ? strength * 0.45 : strength)))
            }
            for index in 0..<count {
                g.fill(Path(CGRect(x: x(index) - 0.5, y: mid + tall / 2 + 2, width: 1, height: 3)), with: .color(Look.ink.opacity(0.4)))
            }
            guard let knob else { return }
            let bar = CGRect(x: knob - 1.5, y: mid - tall / 2 - 3, width: 3, height: tall + 6)
            if firm { g.fill(Path(bar), with: .color(Look.ink)) } else { g.stroke(Path(bar.insetBy(dx: 0.5, dy: 0.5)), with: .color(Look.ink.opacity(0.6)), lineWidth: 1) }
        }
    }
}

/// The slider with its words: the agent's own word for it and the level over the line, a sentence about the level
/// under it; `Default` puts the choice back where there is one to put back.
struct EffortPicker: View {
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
        let shown = level ?? fallback
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let heading { heading } else { Text(word).mono(11.5, weight: .semibold).foregroundStyle(Look.ink) }
                Spacer(minLength: 8)
                if level != nil, let reset {
                    Button(action: reset) { Text("Default").mono(11) }.buttonStyle(QuietButtonStyle())
                }
                Text(level.map(TerminalEffort.name) ?? fallback.map { "Default · \(TerminalEffort.name($0))" } ?? "Default")
                    .mono(11.5, weight: .medium).foregroundStyle(level == nil ? Look.ink2 : Color.signal)
                    .contentTransition(.opacity)
            }
            EffortSlider(levels: levels, level: level, fallback: fallback, enabled: enabled, choose: choose)
            if let hint = shown.flatMap(EffortScale.hint) {
                Text(hint).font(.system(size: 12)).foregroundStyle(Look.ink2).fixedSize(horizontal: false, vertical: true)
            }
            if let note {
                Text(note).font(.system(size: 11.5)).foregroundStyle(Look.faint).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
