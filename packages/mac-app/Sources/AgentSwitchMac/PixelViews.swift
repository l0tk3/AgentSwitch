import AgentSwitchMacCore
import AppKit
import SwiftUI

// The pixel side of the visual language (docs/ui-v0.md §7): marks on whole-point cells, status squares, the busy
// spinner, `// labels`, character meters and dotted rules. Text people read is left to the system font.

/// A 1-bit sprite on whole-point cells, in the foreground style.
struct PixelSprite: View {
    let rows: [String]
    var pixel: CGFloat = 2
    var color: Color = .primary

    var body: some View {
        let lit = PixelArt.sprite(rows)
        Canvas { context, _ in
            for cell in lit {
                context.fill(Path(CGRect(x: CGFloat(cell.x) * pixel, y: CGFloat(cell.y) * pixel, width: pixel, height: pixel)), with: .color(color))
            }
        }
        .frame(width: CGFloat(rows.first?.count ?? 0) * pixel, height: CGFloat(rows.count) * pixel)
        .accessibilityHidden(true)
    }
}

/// The app's mark: the icon's switch on a pixel grid, in a state. `depth` for marks of 20 pt and up (§7.2.10): a
/// 1-pixel hard shadow and half-lit pixels in the diagonal steps; while busy a block runs along the lit lane with a
/// fading trail (still under Reduce Motion). Only a busy or waiting mark that is seen moves (ui-v0 §7.4, 2026-10-03):
/// idle, off and error are one picture, and nothing ticks for them.
struct PixelMarkView: View {
    let state: PixelArt.MarkState
    var pixel: CGFloat = 2
    var depth = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onScreen) private var onScreen

    var body: some View {
        let interval = reduceMotion ? nil : state.motionInterval
        Group {
            if let interval, onScreen {
                TimelineView(.periodic(from: Motion.epoch, by: interval)) { timeline in
                    Canvas { context, _ in draw(&context, frame: Motion.step(at: timeline.date, every: interval)) }
                }
                .id(interval)   // busy ↔ waiting: the other beat
            } else {
                let frame = interval.map { Motion.step(at: Date(), every: $0) } ?? 0
                Canvas { context, _ in draw(&context, frame: frame) }
            }
        }
        .frame(width: CGFloat(PixelArt.markWidth + (depth ? 1 : 0)) * pixel, height: CGFloat(PixelArt.markHeight + (depth ? 1 : 0)) * pixel)
        .accessibilityLabel("AgentSwitch")
    }

    private func draw(_ context: inout GraphicsContext, frame: Int) {
        func rect(_ x: Int, _ y: Int) -> Path { Path(CGRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel)) }
        let cells = PixelArt.markCells.filter { state != .off || !PixelArt.dithered($0) }
        let lane = PixelArt.laneA
        let head = frame % lane.count
        if depth && state == .busy {
            // A little glow under the running block, as pixel.js draws it.
            var glow = context
            glow.addFilter(.blur(radius: pixel * 1.2))
            glow.opacity = 0.7
            glow.fill(rect(lane[head].x, lane[head].y), with: .color(.busy))
        }
        if depth {
            for cell in cells { context.fill(rect(cell.x + 1, cell.y + 1), with: .color(.pixelShadow)) }
            if state != .off {
                for cell in PixelArt.markSmoothing { context.fill(rect(cell.x, cell.y), with: .color((cell.lit ? Color.primary : .inkDim).opacity(0.42))) }
            }
        }
        for cell in cells {
            var color: Color = cell.lit ? .primary : .inkDim
            if cell.end && state == .waiting { color = Color.waiting.opacity(frame % 2 == 1 ? 0.25 : 1) }   // as pixel.js
            if cell.end && state == .error { color = .failed }
            context.fill(rect(cell.x, cell.y), with: .color(color))
        }
        if state == .busy {
            // With depth a fading trail behind the block; without, a two-cell block that stops at the lane's end.
            let trail: [(Int, Double)] = depth ? [(0, 1), (1, 0.55), (2, 0.25)] : [(0, 1)] + (head + 1 < lane.count ? [(-1, 1)] : [])
            for (back, alpha) in trail {
                let cell = lane[(head - back + lane.count * 4) % lane.count]
                context.fill(rect(cell.x, cell.y), with: .color(Color.busy.opacity(alpha)))
            }
        }
    }
}

/// A status in pixels: a square for ok / waiting / error, hollow when off, the braille spinner while busy.
struct StatusMark: View {
    let level: StatusLevel

    var body: some View {
        switch level {
        case .busy: BrailleSpinner()
        case .off: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .inkDim)
        default: PixelSprite(rows: PixelArt.square, pixel: 2, color: level.color)
        }
    }
}

/// In progress, everywhere the same (web page, Mac, phone): ⠋⠙⠹…; a still first frame under Reduce Motion. It turns
/// only while seen, every spinner on the same beat (ui-v0 §7.4, 2026-10-03).
struct BrailleSpinner: View {
    static let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onScreen) private var onScreen

    var body: some View {
        Group {
            if reduceMotion {
                glyph(0)
            } else if onScreen {
                TimelineView(.periodic(from: Motion.epoch, by: Motion.spinner)) { timeline in
                    glyph(Motion.step(at: timeline.date, every: Motion.spinner))
                }
            } else {
                glyph(Motion.step(at: Date(), every: Motion.spinner))
            }
        }
        .frame(width: 8)
        .accessibilityLabel("Busy")
    }

    private func glyph(_ step: Int) -> some View {
        Text(Self.frames[step % Self.frames.count]).font(.system(size: 12, design: .monospaced)).foregroundStyle(Color.busy)
    }
}

/// `// Status`: a group's label in title case (docs/ui-v0.md §7.2.7), monospaced, spaced out.
struct SectionLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text("// \(text)")
            .font(.system(size: 10.5, design: .monospaced))
            .tracking(1.4)
            .foregroundStyle(.secondary)
            .textCase(nil)
    }
}

/// `████░░░░ 62%` in characters: the used part in green (red from Usage.highPercent), the rest faint.
struct CharMeter: View {
    let fraction: Double
    var high = false
    var cells = 10

    var body: some View {
        let used = max(0, min(cells, Int((fraction * Double(cells)).rounded())))
        (Text(String(repeating: "█", count: used)).foregroundStyle(high ? Color.failed : Color.ok)
            + Text(String(repeating: "░", count: cells - used)).foregroundStyle(Color.inkDim))
            .font(.system(size: 10, design: .monospaced))
            .kerning(-0.5)
            .accessibilityHidden(true)
    }
}

/// A 1 px dotted rule (2 on, 2 off), where a system divider would be.
struct DottedRule: View {
    var color: Color = .inkDim

    var body: some View {
        Canvas { context, size in
            var x: CGFloat = 0
            while x < size.width {
                context.fill(Path(CGRect(x: x, y: 0, width: 2, height: 1)), with: .color(color))
                x += 4
            }
        }
        .frame(height: 1)
        .accessibilityHidden(true)
    }
}

extension View {
    /// Short words (states, labels, values): monospaced (§7.2.7).
    func mono(_ size: CGFloat = 12, weight: Font.Weight = .regular) -> some View {
        font(.system(size: size, weight: weight, design: .monospaced))
    }
}
