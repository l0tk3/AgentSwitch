import AgentSwitchKit
import SwiftUI
import UIKit

// How hard the agent thinks, chosen on a line (docs/terminal-v0.md §1 思考强度; 2026-10-07, user: 思考强度改成滑块调节
// 加上和官方差不多的特效，新建的时候也这样选): the levels its model takes are the line's stops, lowest first. The line
// is livelier the higher the level — a sheen running along its filled part, faster and brighter stop by stop, and at
// the highest a glow around the knob with sparks off it; in the pixel look the same in cells, a bright one running
// along the lit ones and the row flickering at the top. A tick under the finger at each stop; nothing moves under
// Reduce Motion. The Mac draws the same line (packages share nothing but the service's API).

/// The line itself.
struct EffortSlider: View {
    let levels: [String]
    /// The level chosen; nil: none — the model's default.
    let level: String?
    /// What that default is, when the agent says: where the knob rests, hollow, while none is chosen.
    var fallback: String?
    var enabled = true
    /// A stop was chosen: dragged to and let go, or tapped.
    let choose: (String) -> Void
    @Environment(\.interfaceLook) private var look
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var dragging: Int?

    private static let height: CGFloat = 40
    /// The first and last stops stand this far inside the ends: the knob stays whole.
    private static let inset: CGFloat = 13

    var body: some View {
        let chosen = EffortScale.index(of: level, in: levels)
        let resting = chosen ?? EffortScale.index(of: fallback, in: levels)
        let at = dragging ?? resting
        VStack(spacing: 2) {
            GeometryReader { geo in
                let width = Double(geo.size.width - Self.inset * 2)
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: still || !enabled || (at ?? 0) == 0)) { context in
                    Canvas { g, size in
                        draw(&g, size: size, at: at, firm: dragging != nil || chosen != nil, time: context.date.timeIntervalSinceReferenceDate)
                    }
                }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let stop = EffortScale.stop(at: Double(value.location.x - Self.inset), width: width, count: levels.count)
                        if stop != dragging {
                            if dragging != nil || stop != resting { UISelectionFeedbackGenerator().selectionChanged() }
                            dragging = stop
                        }
                    }
                    .onEnded { value in
                        let stop = EffortScale.stop(at: Double(value.location.x - Self.inset), width: width, count: levels.count)
                        dragging = nil
                        if levels.indices.contains(stop) { choose(levels[stop]) }
                    })
            }
            .frame(height: Self.height)
            HStack {
                Text(levels.first.map(EffortDisplay.name) ?? "")
                Spacer(minLength: 8)
                Text(levels.last.map(EffortDisplay.name) ?? "")
            }
            .mono(11).foregroundStyle(.tertiary)
        }
        .opacity(enabled ? 1 : 0.45)
        .allowsHitTesting(enabled)
        .accessibilityElement()
        .accessibilityLabel("Level")
        .accessibilityValue(at.map { EffortDisplay.name(levels[$0]) } ?? "Default")
        .accessibilityAdjustableAction { direction in
            guard enabled, let next = EffortScale.step(from: chosen, by: direction == .increment ? 1 : -1, start: resting, count: levels.count), next != chosen else { return }
            choose(levels[next])
        }
    }

    private func draw(_ g: inout GraphicsContext, size: CGSize, at: Int?, firm: Bool, time: Double) {
        let count = levels.count
        let width = Double(size.width - Self.inset * 2)
        let mid = size.height / 2 + 4
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
            let track = CGRect(x: Self.inset - 5, y: mid - 4, width: CGFloat(width) + 10, height: 8)
            g.fill(Path(roundedRect: track, cornerRadius: 4), with: .color(Theme.ink.opacity(0.10)))
            if let knob {
                let fill = CGRect(x: track.minX, y: track.minY, width: knob - track.minX, height: track.height)
                var inner = g
                inner.clip(to: Path(roundedRect: fill, cornerRadius: 4))
                inner.fill(Path(fill), with: .color(Theme.signal.opacity(strength)))
                if moving {
                    let band: CGFloat = 60
                    let from = fill.minX - band + (fill.width + band) * CGFloat(phase)
                    inner.fill(Path(CGRect(x: from, y: fill.minY, width: band, height: fill.height)),
                               with: .linearGradient(Gradient(colors: [.white.opacity(0), .white.opacity(0.3 + 0.55 * heat), .white.opacity(0)]),
                                                     startPoint: CGPoint(x: from, y: mid), endPoint: CGPoint(x: from + band, y: mid)))
                }
            }
            for index in 0..<count {
                let on = at.map { index <= $0 } ?? false
                g.fill(Path(ellipseIn: CGRect(x: x(index) - 2, y: mid - 2, width: 4, height: 4)), with: .color(on ? Color.white.opacity(0.9) : Theme.ink.opacity(0.3)))
            }
            guard let knob else { return }
            if top, moving {
                // At the highest: a glow breathing around the knob, and sparks off it.
                let breath = 0.5 + 0.5 * sin(time * 3.2)
                g.fill(Path(ellipseIn: CGRect(x: knob - 20, y: mid - 20, width: 40, height: 40)), with: .color(Theme.signal.opacity(0.10 + 0.14 * breath)))
                for spark in 0..<6 {
                    let life = (time * 0.85 + Double(spark) * 0.167).truncatingRemainder(dividingBy: 1)
                    let lean = sin(Double(spark) * 2.4) * 14
                    let point = CGPoint(x: knob + CGFloat(lean * life), y: mid - 13 - CGFloat(life) * 12)
                    g.fill(Path(ellipseIn: CGRect(x: point.x - 1.5, y: point.y - 1.5, width: 3, height: 3)), with: .color(Theme.signal.opacity((1 - life) * 0.9)))
                }
            }
            let circle = Path(ellipseIn: CGRect(x: knob - 12, y: mid - 12, width: 24, height: 24))
            var shaded = g
            shaded.addFilter(.shadow(color: .black.opacity(0.22), radius: 3, y: 1))
            shaded.fill(circle, with: .color(firm ? .white : Theme.panel))
            g.stroke(circle, with: .color(firm ? Theme.signal.opacity(0.9) : Theme.ink.opacity(0.35)), lineWidth: firm ? 1.5 : 1)
        } else {
            // A row of cells; the lit ones up to the knob, a bright one running along them.
            let cell: CGFloat = 6, gap: CGFloat = 2, tall: CGFloat = 16
            let start = Self.inset - 3
            let cells = max(1, Int((CGFloat(width) + 6 + gap) / (cell + gap)))
            let lit = knob.map { min(cells, Int(($0 - start) / (cell + gap)) + 1) } ?? 0
            let runner = moving && lit > 1 ? Int(phase * Double(lit)) : -1
            let frame = Int(time * 14)
            for index in 0..<cells {
                let rect = CGRect(x: start + CGFloat(index) * (cell + gap), y: mid - tall / 2, width: cell, height: tall)
                guard index < lit else { g.fill(Path(rect), with: .color(Theme.ink.opacity(0.13))); continue }
                if index == runner { g.fill(Path(rect), with: .color(Theme.ink)); continue }
                // At the highest the row flickers, a few cells dimmer each frame.
                let flicker = top && moving && (index &* 7919 &+ frame &* 104729) % 9 == 0
                g.fill(Path(rect), with: .color(Theme.signal.opacity(flicker ? strength * 0.45 : strength)))
            }
            for index in 0..<count {
                g.fill(Path(CGRect(x: x(index) - 0.5, y: mid + tall / 2 + 2, width: 1, height: 4)), with: .color(Theme.ink.opacity(0.4)))
            }
            guard let knob else { return }
            let bar = CGRect(x: knob - 2, y: mid - tall / 2 - 4, width: 4, height: tall + 8)
            if firm { g.fill(Path(bar), with: .color(Theme.ink)) } else { g.stroke(Path(bar.insetBy(dx: 0.5, dy: 0.5)), with: .color(Theme.ink.opacity(0.6)), lineWidth: 1) }
        }
    }
}

/// The slider with its words: the agent's own word for it and the level over the line, a sentence about the level
/// under it; `Default` puts the choice back where there is one to put back.
struct EffortPicker<Heading: View>: View {
    let levels: [String]
    let level: String?
    var fallback: String?
    var enabled = true
    /// A line of its own under the level's sentence (`会记成这个模型的默认…`).
    var note: String?
    let choose: (String) -> Void
    /// Back to none chosen (absent where a level is always in force: a running terminal).
    var reset: (() -> Void)?
    /// The agent's word for it, as the page around writes its labels.
    @ViewBuilder var heading: Heading

    var body: some View {
        let shown = level ?? fallback
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                heading
                Spacer(minLength: 8)
                if level != nil, let reset {
                    Button(action: reset) { LookWord("Default").mono(12) }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
                Text(level.map(EffortDisplay.name) ?? fallback.map { "Default · \(EffortDisplay.name($0))" } ?? "Default")
                    .mono(13, weight: .medium).foregroundStyle(level == nil ? Color.secondary : Theme.signal)
                    .contentTransition(.opacity)
            }
            EffortSlider(levels: levels, level: level, fallback: fallback, enabled: enabled, choose: choose)
            if let hint = shown.flatMap(EffortScale.hint) {
                Text(hint).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let note {
                Text(note).font(.caption).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
