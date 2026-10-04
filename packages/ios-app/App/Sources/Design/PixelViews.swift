import AgentSwitchKit
import AgentSwitchLiveUI
import SwiftUI

// The pixel side of the visual language (docs/ui-v0.md §7), as on the Mac (mac-app PixelViews.swift): marks on
// whole-point cells, status squares, the busy spinner, `// labels`, character meters and solid rules. Text people
// read is left to the system font.
// In the classic look (§8) each of these draws its standard counterpart (ClassicViews.swift): a system symbol, a dot,
// the system's spinner, a plain label, a thin bar.

/// A 1-bit sprite on whole-point cells, in one colour; in the classic look the symbol that stands for it.
struct PixelSprite: View {
    let rows: [String]
    var pixel: CGFloat = 2
    var color: Color = .primary
    /// Set where the pixel look draws the sprite's shaded picture instead (docs/ui-v0.md §9: a lock, an agent's mark,
    /// the globe): how strongly — 1 for the one in use, less for the others.
    var strength: Double? = nil
    /// The shaded picture's hard shadow, a cell down and right.
    var shadow = true
    /// The shaded picture's cell in points (drawn as a whole number of pixels).
    var cell: CGFloat = 1.5
    /// The shaded picture, where it is not the one that stands for `rows` (the small lock).
    var picture: ShadedSprite? = nil
    /// The ground the shaded picture sits on, where it is not the screen's (a button filled with a colour).
    var onDark: Bool? = nil
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let size = CGSize(width: CGFloat(rows.first?.count ?? 0) * pixel, height: CGFloat(rows.count) * pixel)
        Group {
            if look.isClassic, let icon = ClassicIcon(rows: rows) {
                icon.view(in: size, color: color).frame(width: size.width, height: size.height)
            } else if !look.isClassic, let strength, let picture = picture ?? ShadedSprite.standing(for: rows) {
                ShadedSpriteView(sprite: picture, strength: strength, shadow: shadow, cell: cell, onDark: onDark)
            } else {
                let lit = PixelArt.sprite(rows)
                // A status square is a small key: a light edge above and left, a dark one below and right (§9). A
                // hollow one is the key's empty seat: dark above and left, light below and right.
                let key = rows == PixelArt.square, seat = rows == PixelArt.hollow
                Canvas { context, _ in
                    for cell in lit {
                        context.fill(Path(CGRect(x: CGFloat(cell.x) * pixel, y: CGFloat(cell.y) * pixel, width: pixel, height: pixel)), with: .color(color))
                    }
                    if key || seat { ShadedPaint.keyEdges(in: &context, side: size.width, edge: max(1, pixel / 2), raised: key) }
                }
                .frame(width: size.width, height: size.height)
            }
        }
        .accessibilityHidden(true)
    }
}

/// A shaded sprite (docs/ui-v0.md §9, ShadedSprite): each cell a whole number of pixels, in its tone of the ink, over a hard
/// shadow a cell down and right.
struct ShadedSpriteView: View {
    let sprite: ShadedSprite
    var strength: Double = 1
    var shadow = true
    var cell: CGFloat = 1.5
    var onDark: Bool? = nil
    @Environment(\.displayScale) private var displayScale
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = onDark ?? (scheme == .dark)
        let cell = CGFloat(ShadedSprite.cell(scale: Double(displayScale), points: Double(cell)))
        let pad: CGFloat = shadow ? 1 : 0
        Canvas { context, _ in ShadedPaint.draw(sprite, in: &context, cell: cell, dark: dark, shadow: shadow) }
            .frame(width: ((CGFloat(sprite.width) + pad) * cell).rounded(.up), height: ((CGFloat(sprite.height) + pad) * cell).rounded(.up), alignment: .topLeading)
            .opacity(strength)
            .accessibilityHidden(true)
    }
}

/// The app's mark in a state: its shaded picture (§10) with the state on the front window's title bar — cyan with a
/// light block running along it while busy (a fading trail and a little glow; still under Reduce Motion), amber while
/// something waits (it blinks) and red on an error, every other cell gone when off. `depth`: the hard shadow. In the
/// classic look the mark as lines. Only a busy or waiting mark moves, and only while the app is in front (ui-v0 §7.4,
/// 2026-10-03): idle, off and error are one picture, and nothing ticks for them.
struct PixelMarkView: View {
    let state: PixelArt.MarkState
    var pixel: CGFloat = 2
    var depth = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.interfaceLook) private var look
    @Environment(\.displayScale) private var displayScale
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if look.isClassic {
            ClassicMarkView(state: state, height: CGFloat(PixelArt.markHeight) * pixel).accessibilityHidden(true)
        } else {
            pixelMark
        }
    }

    private var pixelMark: some View {
        let interval = reduceMotion ? nil : state.motionInterval
        // Five sixths of the old mark's cell: 5 pixels where that was 2 pt, the picture as wide as the mark was.
        let cell = CGFloat(ShadedSprite.cell(scale: Double(displayScale), points: Double(pixel) * 5 / 6))
        let side = ((CGFloat(ShadedMark.picture.width) + (depth ? 1 : 0)) * cell).rounded(.up)
        return Group {
            if let interval, scenePhase == .active {
                TimelineView(.periodic(from: Motion.epoch, by: interval)) { timeline in
                    Canvas { context, _ in paint(frame: Motion.step(at: timeline.date, every: interval)).draw(&context, cell: cell) }
                }
                .id(interval)   // busy ↔ waiting: the other beat
            } else {
                let frame = interval.map { Motion.step(at: Date(), every: $0) } ?? 0
                Canvas { context, _ in paint(frame: frame).draw(&context, cell: cell) }
            }
        }
        .frame(width: side, height: side, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    private func paint(frame: Int) -> ShadedMarkPaint {
        ShadedMarkPaint(
            dark: scheme == .dark, depth: depth, glow: depth, off: state == .off,
            end: state == .waiting ? Theme.waiting : state == .error ? Theme.failed : state == .busy ? Theme.busy : nil,
            endLit: state == .waiting && frame % 2 == 1 ? 0.25 : 1,
            block: state == .busy ? ShadedMarkPaint.block(at: frame, trail: depth) : [], busy: .white)
    }
}

/// A task's status in pixels: the braille spinner while it runs, a square while it waits (blinking) or once done,
/// hollow once it ended otherwise (cancelled, incomplete, failed keep their colour).
/// In the classic look: the system's spinner, a dot (its ring breathing while it waits), a ring.
struct StatusMark: View {
    let status: TaskStatus
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch status {
        case .routing, .running: BrailleSpinner()
        case .queued, .cancelled, .other: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: Theme.color(status))
        case .waitingApproval:
            if look.isClassic { ClassicWaitingDot() } else { PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting).waitingBlink() }
        default: PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.color(status))
        }
    }
}

/// In progress, everywhere the same (web page, Mac, phone): ⠋⠙⠹…; a still first frame under Reduce Motion. It turns
/// only while the app is in front, every spinner on the same beat (ui-v0 §7.4, 2026-10-03).
struct BrailleSpinner: View {
    static let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    var color: Color = Theme.busy
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Group {
            if look.isClassic {
                ClassicSpinner()
            } else if reduceMotion {
                glyph(0)
            } else if scenePhase == .active {
                TimelineView(.periodic(from: Motion.epoch, by: Motion.spinner)) { timeline in
                    glyph(Motion.step(at: timeline.date, every: Motion.spinner))
                }
            } else {
                glyph(Motion.step(at: Date(), every: Motion.spinner))
            }
        }
        .frame(width: 9)
        .accessibilityHidden(true)
    }

    private func glyph(_ step: Int) -> some View {
        Text(Self.frames[step % Self.frames.count]).font(.system(size: 13, design: .monospaced)).foregroundStyle(color)
    }
}

/// `// Status`: a group's label in title case (§7.2.7), monospaced, spaced out.
struct SectionLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            // A plain small heading, as a standard app's group has.
            Text(text).font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary).textCase(nil)
        } else {
            Text("// \(text)")
                .font(.system(size: 11, design: .monospaced))
                .tracking(1.4)
                .foregroundStyle(.secondary)
                .textCase(nil)
        }
    }
}

/// `████░░░░ 62%` in characters: the used part in green (red from Usage.alertPercent), the rest faint.
struct CharMeter: View {
    let fraction: Double
    var high = false
    var cells = 10
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            ClassicBar(fraction: fraction, color: high ? Theme.failed : Theme.done, width: CGFloat(cells) * 6.5)
        } else {
            let used = max(0, min(cells, Int((fraction * Double(cells)).rounded())))
            (Text(String(repeating: "█", count: used)).foregroundStyle(high ? Theme.failed : Theme.done)
                + Text(String(repeating: "░", count: cells - used)).foregroundStyle(Theme.inkDim))
                .font(.system(size: 11, design: .monospaced))
                .kerning(-0.5)
                .accessibilityHidden(true)
        }
    }
}

/// A 1 pt solid rule, where a divider would be (2026-10-03, user: 分割线也别弄虚线了，改成实线吧，看着累人; two on, two off before).
struct HairRule: View {
    var body: some View {
        Theme.line.frame(height: 1).accessibilityHidden(true)
    }
}

extension Section where Parent == SectionLabel, Footer == EmptyView, Content: View {
    /// A form section headed `// label` (§7.2.7), in place of Section("title").
    init(label: String, @ViewBuilder content: () -> Content) {
        self.init(content: content, header: { SectionLabel(label) })
    }
}
