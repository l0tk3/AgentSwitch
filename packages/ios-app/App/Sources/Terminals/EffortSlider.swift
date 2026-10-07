import AgentSwitchKit
import SwiftUI
import UIKit

// How hard the agent thinks, chosen on a line (docs/terminal-v0.md §1 思考强度; 2026-10-07, user: 思考强度改成滑块调节
// 加上和官方差不多的特效，新建的时候也这样选; then, shown Codex's own: 太细了，而且描述没有必要，而且最高档最好换个颜色
// … 就像这样): the levels its model takes are the line's stops, lowest first. The line is a thick pill, filled up to a
// round knob that sits inside its end; stars twinkle in the filled part, more of them the higher the level; the
// highest level has a colour of its own (violet), drifting stars, and its name in that colour. In the pixel look the
// same in cells: a bright one running along the lit ones, and at the top the row in violet, twinkling. A tick under
// the finger at each stop; nothing moves under Reduce Motion. The Mac draws the same line (packages share nothing but
// the service's API).

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

    /// The pill's thickness, and the room it is drawn in (its knob's shadow below).
    static let thick: CGFloat = 30
    private static let height: CGFloat = 38
    /// The first and last stops stand half the pill's thickness inside its ends: the knob sits inside the pill there.
    private static let inset: CGFloat = thick / 2

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
        let mid = size.height / 2 - 1
        func x(_ index: Int) -> CGFloat { Self.inset + CGFloat(EffortScale.place(of: index, width: width, count: count)) }
        let knob = at.map(x)
        let heat = at.map { EffortScale.heat($0, count: count) } ?? 0
        let moving = !still && enabled && heat > 0
        let top = heat >= 1 && count > 1
        let colour = top ? Theme.top : Theme.signal
        /// A number in 0 ..< 1 that is always the same for the same star.
        func chance(_ seed: Double) -> Double { let v = sin(seed) * 43758.5453; return v - v.rounded(.down) }

        if look.isClassic {
            let thick = Self.thick
            let track = CGRect(x: 0, y: mid - thick / 2, width: size.width, height: thick)
            g.fill(Path(roundedRect: track, cornerRadius: thick / 2), with: .color(Theme.ink.opacity(0.09)))
            // The stops still ahead, faintly: where a level is.
            for index in 0..<count where at.map({ index > $0 }) ?? true {
                g.fill(Path(ellipseIn: CGRect(x: x(index) - 1.5, y: mid - 1.5, width: 3, height: 3)), with: .color(Theme.ink.opacity(0.28)))
            }
            guard let knob else { return }
            // Filled up to the knob, which sits inside the fill's round end.
            let fill = CGRect(x: 0, y: track.minY, width: knob + thick / 2, height: thick)
            let shape = Path(roundedRect: fill, cornerRadius: thick / 2)
            var inner = g
            inner.opacity = firm ? 1 : 0.38
            inner.fill(shape, with: .linearGradient(Gradient(colors: top ? [Theme.topDeep, Theme.top, Theme.top.opacity(0.82)] : [colour.opacity(0.72), colour]),
                                                    startPoint: CGPoint(x: 0, y: mid), endPoint: CGPoint(x: fill.maxX, y: mid)))
            if moving, fill.width > thick + 6 {
                // Stars in the filled part: more of them the higher, each twinkling at its own pace; at the highest they drift.
                inner.clip(to: shape)
                let room = Double(fill.width - thick - 2)
                for star in 0..<Int((3 + 13 * heat).rounded()) {
                    let seed = Double(star) * 12.9898 + 4.1
                    var px = chance(seed) * room
                    if top { px = (px + time * (3 + 5 * chance(seed * 2.3))).truncatingRemainder(dividingBy: room) }
                    let py = 4 + chance(seed * 1.7 + 3.1) * Double(thick - 8)
                    let twinkle = 0.5 + 0.5 * sin(time * (1.1 + 2.4 * chance(seed * 0.61)) + seed)
                    let radius = 0.6 + 0.9 * chance(seed * 0.37)
                    inner.fill(Path(ellipseIn: CGRect(x: 4 + px - radius, y: Double(track.minY) + py - radius, width: radius * 2, height: radius * 2)),
                               with: .color(.white.opacity(0.2 + 0.75 * twinkle)))
                }
            }
            let across = thick - 4
            let circle = Path(ellipseIn: CGRect(x: knob - across / 2, y: mid - across / 2, width: across, height: across))
            var shaded = g
            shaded.addFilter(.shadow(color: .black.opacity(0.25), radius: 2.5, y: 1))
            shaded.fill(circle, with: .color(.white.opacity(firm ? 1 : 0.85)))
        } else {
            // A row of cells; the lit ones up to the knob, a bright one running along them.
            let cell: CGFloat = 7, gap: CGFloat = 2, tall: CGFloat = 22
            let cells = max(1, Int((size.width + gap) / (cell + gap)))
            let lit = knob.map { min(cells, Int($0 / (cell + gap)) + 1) } ?? 0
            let lap = 2.8 - 1.9 * heat
            let runner = moving && !top && lit > 1 ? Int(time.truncatingRemainder(dividingBy: lap) / lap * Double(lit)) : -1
            let frame = Int(time * 9)
            let strength = firm ? 0.55 + 0.45 * heat : 0.3
            for index in 0..<cells {
                let rect = CGRect(x: CGFloat(index) * (cell + gap), y: mid - tall / 2, width: cell, height: tall)
                guard index < lit else { g.fill(Path(rect), with: .color(Theme.ink.opacity(0.13))); continue }
                if index == runner { g.fill(Path(rect), with: .color(Theme.ink)); continue }
                // At the highest the row twinkles: a cell or two dim for a moment.
                let dim = top && moving && chance(Double(index) * 7.31 + Double(frame) * 1.93) > 0.9
                g.fill(Path(rect), with: .color(colour.opacity(dim ? strength * 0.4 : strength)))
            }
            for index in 0..<count {
                g.fill(Path(CGRect(x: x(index) - 0.5, y: mid + tall / 2 + 2, width: 1, height: 3)), with: .color(Theme.ink.opacity(0.4)))
            }
            guard let knob else { return }
            let bar = CGRect(x: knob - 2, y: mid - tall / 2 - 3, width: 4, height: tall + 6)
            if firm { g.fill(Path(bar), with: .color(Theme.ink)) } else { g.stroke(Path(bar.insetBy(dx: 0.5, dy: 0.5)), with: .color(Theme.ink.opacity(0.6)), lineWidth: 1) }
        }
    }
}

/// The slider with its words: the agent's own word for it and the level over the line — the highest level in its own
/// colour; `Default` puts the choice back where there is one to put back. No sentence about what a level is (2026-10-07,
/// user: 描述没有必要): only a line the caller has to say (what choosing does, why it cannot be chosen now).
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
        let highest = level != nil && level == levels.last && levels.count > 1
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                heading
                Spacer(minLength: 8)
                if level != nil, let reset {
                    Button(action: reset) { LookWord("Default").mono(12) }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
                Text(level.map(EffortDisplay.name) ?? fallback.map { "Default · \(EffortDisplay.name($0))" } ?? "Default")
                    .mono(13, weight: .medium).foregroundStyle(level == nil ? Color.secondary : highest ? Theme.top : Theme.signal)
                    .contentTransition(.opacity)
            }
            EffortSlider(levels: levels, level: level, fallback: fallback, enabled: enabled, choose: choose)
            if let note {
                Text(note).font(.caption).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
