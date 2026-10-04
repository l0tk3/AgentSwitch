import AgentSwitchMacCore
import AppKit
import SwiftUI

// The classic look's side of the shared parts (docs/ui-v0.md §8, 2026-10-04; docs/design/concepts/classic.html): what
// PixelViews.swift and DispatchStyle.swift draw in place of their pixels when `\.interfaceLook` is `.classic` — line
// icons, dots, the system's spinner, thin bars. Nothing here is used by a page directly: the pages keep asking for the
// shared parts, which decide.

/// What stands for a pixel sprite: a system symbol, the app's own mark, an agent's mark (the only ones drawn by hand).
enum ClassicIcon {
    case symbol(String)
    case mark
    case agent(String)

    init?(rows: [String]) {
        if let name = PixelArt.symbol(for: rows) {
            self = .symbol(name)
        } else if rows == PixelArt.markRows || rows == PixelArt.railDispatch {
            self = .mark
        } else if let agent = PixelArt.agents.first(where: { $0.value == rows })?.key {
            self = .agent(agent)
        } else {
            return nil
        }
    }

    /// The icon in the sprite's frame.
    @ViewBuilder
    func view(in size: CGSize, color: Color) -> some View {
        let side = min(size.width, size.height)
        switch self {
        case .symbol(let name):
            // A dot fills its square, as the pixel square did; a line icon is a little larger than the sprite's height,
            // whose pixels filled their frame edge to edge.
            let dot = name.hasPrefix("circle")
            Image(systemName: name)
                .font(.system(size: dot ? side * 0.92 : max(side * 1.08, 10), weight: dot ? .regular : .medium))
                .foregroundStyle(color)
        case .mark:
            Canvas { context, canvas in ClassicMark.draw(&context, in: CGRect(origin: .zero, size: canvas), lit: color, dim: color.opacity(0.5)) }
        case .agent(let harness):
            Canvas { context, canvas in ClassicAgent.draw(harness, &context, in: CGRect(origin: .zero, size: canvas), color: color) }
        }
    }
}

/// The app's mark as lines: one source switched onto three lanes, the same picture as the pixel mark with the squares
/// rounded and the steps curved; the top lane is the lit one.
enum ClassicMark {
    static func draw(_ context: inout GraphicsContext, in rect: CGRect, lit: Color, dim: Color, end: Color? = nil) {
        // The pixel mark's grid: 14 × 11 cells.
        let u = min(rect.width / 14, rect.height / 11)
        let origin = CGPoint(x: rect.midX - 7 * u, y: rect.midY - 5.5 * u)
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * u, y: origin.y + y * u) }
        func block(_ x: CGFloat, _ y: CGFloat) -> Path {
            Path(roundedRect: CGRect(origin: point(x, y), size: CGSize(width: 3 * u, height: 3 * u)), cornerRadius: 0.85 * u, style: .continuous)
        }
        let stroke = StrokeStyle(lineWidth: max(1, 0.95 * u), lineCap: .round)
        func lane(to y: CGFloat) -> Path {
            var path = Path()
            path.move(to: point(3, 5.5))
            path.addCurve(to: point(11, y), control1: point(7.4, 5.5), control2: point(6.6, y))
            return path
        }
        context.stroke(lane(to: 5.5), with: .color(dim), style: stroke)
        context.stroke(lane(to: 9.5), with: .color(dim), style: stroke)
        context.fill(block(11, 4), with: .color(dim))
        context.fill(block(11, 8), with: .color(dim))
        context.stroke(lane(to: 1.5), with: .color(lit), style: stroke)
        context.fill(block(0, 4), with: .color(lit))
        context.fill(block(11, 0), with: .color(end ?? lit))
    }
}

/// The app's mark in a state (PixelMarkView's classic side): the lit lane's end amber while something waits for you,
/// red on an error, the whole mark faint when off; while busy the system's spinner beside it.
struct ClassicMarkView: View {
    let state: PixelArt.MarkState
    let height: CGFloat

    var body: some View {
        let end: Color? = state == .waiting ? .waiting : state == .error ? .failed : nil
        HStack(spacing: height * 0.3) {
            Canvas { context, canvas in
                ClassicMark.draw(&context, in: CGRect(origin: .zero, size: canvas), lit: .primary, dim: Color.primary.opacity(0.45), end: end)
            }
            .frame(width: height * 14 / 11, height: height)
            .opacity(state == .off ? 0.4 : 1)
            if state == .busy { ClassicSpinner(size: max(12, height * 0.8)) }
        }
        .accessibilityLabel("AgentSwitch")
    }
}

/// The agents' marks as lines, each from its own logo: Claude Code's spark, Codex's >_, OpenCode's brackets, pi's π.
enum ClassicAgent {
    static func draw(_ harness: String, _ context: inout GraphicsContext, in rect: CGRect, color: Color) {
        let s = min(rect.width, rect.height)
        let origin = CGPoint(x: rect.midX - s / 2, y: rect.midY - s / 2)
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * s, y: origin.y + y * s) }
        var path = Path()
        switch harness {
        case "claude-code":
            for k in 0..<4 {
                let angle = CGFloat(k) * .pi / 4
                let dx = cos(angle) * 0.44, dy = sin(angle) * 0.44
                path.move(to: p(0.5 - dx, 0.5 - dy))
                path.addLine(to: p(0.5 + dx, 0.5 + dy))
            }
        case "codex":
            path.move(to: p(0.12, 0.2)); path.addLine(to: p(0.46, 0.5)); path.addLine(to: p(0.12, 0.8))
            path.move(to: p(0.56, 0.82)); path.addLine(to: p(0.9, 0.82))
        case "opencode":
            path.move(to: p(0.38, 0.1)); path.addLine(to: p(0.14, 0.1)); path.addLine(to: p(0.14, 0.9)); path.addLine(to: p(0.38, 0.9))
            path.move(to: p(0.62, 0.1)); path.addLine(to: p(0.86, 0.1)); path.addLine(to: p(0.86, 0.9)); path.addLine(to: p(0.62, 0.9))
        default:
            path.move(to: p(0.1, 0.24)); path.addLine(to: p(0.9, 0.24))
            path.move(to: p(0.34, 0.24)); path.addLine(to: p(0.3, 0.86))
            path.move(to: p(0.66, 0.24)); path.addCurve(to: p(0.86, 0.84), control1: p(0.64, 0.62), control2: p(0.68, 0.86))
        }
        context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: max(1, s * 0.11), lineCap: .round, lineJoin: .round))
    }
}

/// A status as a dot (StatusMark's classic side): filled in the status's colour, a ring when off, the spinner while
/// busy. The pixel square's 8 pt.
struct ClassicDot: View {
    let level: StatusLevel
    var side: CGFloat = 8

    var body: some View {
        switch level {
        case .busy: ClassicSpinner(size: side * 1.4)
        case .off: Circle().strokeBorder(Color.inkDim, lineWidth: 1.25).frame(width: side, height: side)
        default: Circle().fill(level.color).frame(width: side, height: side)
        }
    }
}

/// The system's spinner at the size of a line's mark; a still ring while it is not seen or under Reduce Motion
/// (ui-v0 §7.4: nothing turns for nobody).
struct ClassicSpinner: View {
    /// The glyph size of the braille spinner it stands for: 12 in a line of words.
    var size: CGFloat = 12
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onScreen) private var onScreen

    var body: some View {
        let side = max(8, (size * 0.85).rounded())
        Group {
            if onScreen, !reduceMotion {
                ProgressView().controlSize(.small).scaleEffect(side / 16)
            } else {
                Circle().trim(from: 0.12, to: 0.88).stroke(Color.secondary, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .padding(1)
            }
        }
        .frame(width: side, height: side)
        .accessibilityLabel("Working")
    }
}

/// Waiting for you: an amber dot whose ring breathes (BlinkingSquare's classic side); still under Reduce Motion and
/// while it is not seen.
struct ClassicWaitingDot: View {
    var color: Color = .waiting
    var side: CGFloat = 8
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onScreen) private var onScreen

    var body: some View {
        Group {
            if reduceMotion || !onScreen {
                dot(out: false)
            } else {
                TimelineView(.periodic(from: Motion.epoch, by: Motion.blink)) { timeline in
                    dot(out: Motion.step(at: timeline.date, every: Motion.blink) % 2 == 1)
                        .animation(.easeInOut(duration: Motion.blink), value: Motion.step(at: timeline.date, every: Motion.blink))
                }
            }
        }
        .frame(width: side, height: side)
    }

    private func dot(out: Bool) -> some View {
        Circle().fill(color)
            .overlay(Circle().stroke(color.opacity(out ? 0 : 0.5), lineWidth: max(1, side * 0.16)).scaleEffect(out ? 1.9 : 1.3))
    }
}

/// A thin bar for a part of a whole (CharMeter's and the progress blocks' classic side).
struct ClassicBar: View {
    let fraction: Double
    var color: Color = .ok
    var width: CGFloat = 55
    var height: CGFloat = 4

    var body: some View {
        Capsule().fill(Color.inkDim.opacity(0.4))
            .overlay(alignment: .leading) {
                Capsule().fill(color).frame(width: max(0, min(1, fraction)) * width)
            }
            .frame(width: width, height: height)
            .accessibilityHidden(true)
    }
}
