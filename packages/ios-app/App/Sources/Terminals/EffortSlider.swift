import AgentSwitchKit
import SwiftUI
import UIKit

// How hard the agent thinks, chosen on a line (docs/terminal-v0.md §1 思考强度; 2026-10-07, user: 思考强度改成滑块调节
// 加上和官方差不多的特效，新建的时候也这样选): the levels its model takes are the line's stops, lowest first. In the
// classic look a slider of this app's own: a rounded rectangle for the line, a rounded oblong for the knob, and in the
// filled part a few particles of light drifting forward — a few more and a little quicker with each level, and at the highest level the most, the quickest, each with a tail, the highest level in a colour of its own
// (violet). Its story, all the user's words on 2026-10-07: first a thick pill with a round knob and stars, after
// Codex's own (太大了，而且和codex的一模一样); then bars that rise like a signal's strength (太丑了，改成滑块吧还是，然后一个
// 圆角矩形+圆角长方形滑块，里面加上流动特效); now this, at the bars' small size. In the pixel look a row of cells: a bright
// one running along the lit ones, and at the top the row in violet, twinkling. A tick under the finger at
// each stop; nothing moves under Reduce Motion. The Mac draws the same line (packages share nothing but the service's API).

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

    /// The room the line is drawn in: the knob's height (the pixel look's cells with their ticks).
    private static let height: CGFloat = 34
    /// The first and last stops stand a little inside the line's ends: the knob stays within it there.
    private func inset(_ width: CGFloat) -> CGFloat { look.isClassic ? 9 : 15 }

    var body: some View {
        let chosen = EffortScale.index(of: level, in: levels)
        let resting = chosen ?? EffortScale.index(of: fallback, in: levels)
        let at = dragging ?? resting
        VStack(spacing: 2) {
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
                    .onChanged { value in
                        let stop = EffortScale.stop(at: Double(value.location.x - inset), width: width, count: levels.count)
                        if stop != dragging {
                            if dragging != nil || stop != resting { UISelectionFeedbackGenerator().selectionChanged() }
                            dragging = stop
                        }
                    }
                    .onEnded { value in
                        let stop = EffortScale.stop(at: Double(value.location.x - inset), width: width, count: levels.count)
                        dragging = nil
                        if levels.indices.contains(stop) { choose(levels[stop]) }
                    })
            }
            .frame(height: Self.height)
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
        let inset = inset(size.width)
        let width = Double(size.width - inset * 2)
        let mid = size.height / 2 - 1
        func x(_ index: Int) -> CGFloat { inset + CGFloat(EffortScale.place(of: index, width: width, count: count)) }
        let knob = at.map(x)
        let heat = at.map { EffortScale.heat($0, count: count) } ?? 0
        let moving = !still && enabled && heat > 0
        let top = heat >= 1 && count > 1
        let colour = top ? Theme.top : Theme.signal
        /// A number in 0 ..< 1 that is always the same for the same star.
        func chance(_ seed: Double) -> Double { let v = sin(seed) * 43758.5453; return v - v.rounded(.down) }

        if look.isClassic {
            // A rounded rectangle for the line and a rounded oblong for the knob, particles of light streaming in the filled part.
            let thick: CGFloat = 20, radius: CGFloat = 6.5
            let track = CGRect(x: 0, y: mid - thick / 2, width: size.width, height: thick)
            g.fill(Path(roundedRect: track, cornerRadius: radius), with: .color(Theme.ink.opacity(0.1)))
            // The stops still ahead, faintly: where a level is.
            for index in 0..<count where at.map({ index > $0 }) ?? true {
                g.fill(Path(roundedRect: CGRect(x: x(index) - 0.75, y: mid - 7 / 2, width: 1.5, height: 7), cornerRadius: 0.75), with: .color(Theme.ink.opacity(0.26)))
            }
            guard let knob else { return }
            // Filled up to the knob.
            let fill = CGRect(x: 0, y: track.minY, width: knob, height: thick)
            let shape = Path(roundedRect: fill, cornerRadius: radius)
            var inner = g
            inner.opacity = firm ? 1 : 0.38
            inner.fill(shape, with: .linearGradient(Gradient(colors: top ? [Theme.topDeep, Theme.top] : [colour.opacity(0.7), colour]),
                                                    startPoint: CGPoint(x: 0, y: mid), endPoint: CGPoint(x: max(fill.maxX, 1), y: mid)))
            if moving, fill.width > 16 {
                // Particles of light drifting forward in the filled part, kept quiet: below the highest level a few
                // plain dots, slow — a few more and a little quicker with each level; at the highest level the most
                // of them, at their quickest, and only there each with a tail fading behind it (2026-10-07, user, of
                // tails and speed at every level: 粒子流光应该克制一些 最高档位之前粒子慢一些而且没拖尾 挡位越高粒子速度和数量
                // 高一些 到最高挡位速度和粒子数量最大并且加上拖尾; before that, of slanted bands of light: 太难看了).
                inner.clip(to: shape)
                let longest: Double = top ? 18 : 0
                let run = Double(fill.width) + longest
                let motes = top ? 18 : Int((2 + 8 * heat).rounded())
                let speed = top ? 42.0 : 6.0 + 12.0 * heat
                for mote in 0..<motes {
                    let seed = Double(mote) * 12.9898 + 4.1
                    let pace = speed * (0.6 + 0.8 * chance(seed * 2.3))
                    let px = (chance(seed) * run + time * pace).truncatingRemainder(dividingBy: run)
                    let py = Double(track.minY) + 4.0 + chance(seed * 1.7 + 3.1) * (Double(thick) - 4.0 * 2)
                    let twinkle = 0.55 + 0.45 * sin(time * (1.1 + 2.4 * chance(seed * 0.61)) + seed)
                    let radius = 0.8 + 0.8 * chance(seed * 0.37)
                    let glow = (top ? 0.35 + 0.6 * twinkle : 0.22 + 0.4 * twinkle)
                    if top {
                        let tail = longest * (0.4 + 0.6 * chance(seed * 0.83))
                        var streak = Path()
                        streak.move(to: CGPoint(x: px - tail, y: py))
                        streak.addLine(to: CGPoint(x: px, y: py))
                        inner.stroke(streak, with: .linearGradient(Gradient(colors: [.white.opacity(0), .white.opacity(glow * 0.75)]),
                                                                   startPoint: CGPoint(x: px - tail, y: py), endPoint: CGPoint(x: px, y: py)),
                                     style: StrokeStyle(lineWidth: radius * 1.5, lineCap: .round))
                    }
                    inner.fill(Path(ellipseIn: CGRect(x: px - radius, y: py - radius, width: radius * 2, height: radius * 2)), with: .color(.white.opacity(glow)))
                }
            }
            // The knob: an oblong standing over the line, white; hollow while it only shows the model's own level.
            let grip = CGRect(x: knob - 13 / 2, y: mid - 30 / 2, width: 13, height: 30)
            let oblong = Path(roundedRect: grip, cornerRadius: 4.5)
            var shaded = g
            shaded.addFilter(.shadow(color: .black.opacity(0.28), radius: 2, y: 0.8))
            shaded.fill(oblong, with: .color(.white.opacity(firm ? 1 : 0.8)))
            g.stroke(Path(roundedRect: grip.insetBy(dx: 0.25, dy: 0.25), cornerRadius: 4.5), with: .color(.black.opacity(0.12)), lineWidth: 0.5)
        } else {
            // A row of cells; the lit ones up to the knob, a bright one running along them.
            let cell: CGFloat = 7, gap: CGFloat = 2, tall: CGFloat = 22
            let cells = max(1, Int((size.width + gap) / (cell + gap)))
            let lit = knob.map { min(cells, Int($0 / (cell + gap)) + 1) } ?? 0
            let lap = 2.8 - 1.9 * heat
            let runner = moving && lit > 1 ? Int(time.truncatingRemainder(dividingBy: lap) / lap * Double(lit)) : -1
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
