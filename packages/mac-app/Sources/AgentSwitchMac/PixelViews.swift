import AgentSwitchMacCore
import AppKit
import SwiftUI

// The pixel side of the visual language (docs/ui-v0.md §7): marks on whole-point cells, status squares, the busy
// spinner, `// labels`, character meters and solid rules. Text people read is left to the system font.
//
// Each of them draws itself by the look (§8, `\.interfaceLook`): in the classic one a line icon for the sprite, a dot
// for the square, the system's spinner, a plain small title, a thin bar for the meter (ClassicViews.swift). The pages
// are the same in both looks; only these parts differ.

/// A 1-bit sprite on whole-point cells, in the foreground style; in the classic look the line icon that stands for it,
/// in the same frame.
struct PixelSprite: View {
    let rows: [String]
    var pixel: CGFloat = 2
    var color: Color = .primary
    /// Set where the pixel look draws the sprite's shaded picture instead (docs/ui-v0.md §9: the rail, the bar, a lock,
    /// an agent's mark): how strongly — 1 for the one in use or under the pointer, less for the others.
    var strength: Double? = nil
    /// The shaded picture's hard shadow, a cell down and right.
    var shadow = true
    /// The shaded picture's cell in points (drawn as a whole number of pixels).
    var cell: CGFloat = 1.5
    /// The shaded picture, where it is not the one that stands for `rows` (the small lock).
    var picture: ShadedSprite? = nil
    /// The ground the shaded picture sits on, where it is not the window's (a panel that is always dark).
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
                    if key || seat { context.keyEdges(side: size.width, edge: max(1, pixel / 2), raised: key) }
                }
                .frame(width: size.width, height: size.height)
            }
        }
        .accessibilityHidden(true)
    }
}

/// A shaded sprite (docs/ui-v0.md §9, ShadedSprite): cells of 1.5 pt on a 2× screen — a whole number of pixels on any —
/// each in its tone of the ink, over a hard shadow a cell down and right. Its frame is a whole, even number of points, so centred
/// in a button it lands on whole pixels.
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
        let cells = sprite.cells(dark: dark)
        let pad: CGFloat = shadow ? 1 : 0
        let even = { (points: CGFloat) -> CGFloat in (points / 2).rounded(.up) * 2 }
        let under = Color.shadedShadow(dark: dark)
        Canvas { context, _ in
            func rect(_ x: Int, _ y: Int) -> Path { Path(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)) }
            if shadow { for c in cells { context.fill(rect(c.x + 1, c.y + 1), with: .color(under)) } }
            for c in cells { context.fill(rect(c.x, c.y), with: .color(Color(nsColor: .rgb(c.rgb)))) }
        }
        .frame(width: even((CGFloat(sprite.width) + pad) * cell), height: even((CGFloat(sprite.height) + pad) * cell), alignment: .topLeading)
        .opacity(strength)
        .accessibilityHidden(true)
    }
}

extension GraphicsContext {
    /// A status square's edges (§9): a key has a light one above and left and a dark one below and right; its empty
    /// seat the other way round.
    func keyEdges(side: CGFloat, edge: CGFloat, raised: Bool) {
        let light = Shading.color(.white.opacity(raised ? 0.45 : 0.3)), shade = Shading.color(.black.opacity(0.35))
        let (above, below) = raised ? (light, shade) : (shade, light)
        fill(Path(CGRect(x: 0, y: 0, width: side - edge, height: edge)), with: above)
        fill(Path(CGRect(x: 0, y: edge, width: edge, height: side - 2 * edge)), with: above)
        fill(Path(CGRect(x: edge, y: side - edge, width: side - edge, height: edge)), with: below)
        fill(Path(CGRect(x: side - edge, y: edge, width: edge, height: side - 2 * edge)), with: below)
    }
}

/// A status square of any size as a small key: its colour, and the key's edges.
struct KeySquare: View {
    let color: Color
    var side: CGFloat = 8

    var body: some View {
        Canvas { context, _ in
            context.fill(Path(CGRect(x: 0, y: 0, width: side, height: side)), with: .color(color))
            context.keyEdges(side: side, edge: 1, raised: true)
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }
}

extension Color {
    /// A shaded picture's hard shadow: a step off the ground.
    static func shadedShadow(dark: Bool) -> Color { Color(nsColor: .rgb(dark ? 0x2C2A28 : 0xCFC9BC)) }
}

/// The app's mark in a state: the shaded picture (§9) with a block running along its nearest lane while busy (a fading
/// trail, a little glow; still under Reduce Motion), that lane's end amber while something waits and red on an error,
/// every other cell gone when off. `depth`: the hard shadow. In the classic look the mark as lines. Only a busy or
/// waiting mark that is seen moves (ui-v0 §7.4, 2026-10-03): idle, off and error are one picture, and nothing ticks.
struct PixelMarkView: View {
    let state: PixelArt.MarkState
    var pixel: CGFloat = 2
    var depth = true
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            ClassicMarkView(state: state, height: CGFloat(PixelArt.markHeight) * pixel)
        } else {
            ShadedMarkView(state: state, cell: pixel * 0.75, depth: depth).accessibilityLabel("AgentSwitch")
        }
    }
}

/// A status in pixels: a square for ok / waiting / error, hollow when off, the braille spinner while busy. In the
/// classic look a dot, a ring when off, the system's spinner while busy.
struct StatusMark: View {
    let level: StatusLevel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            ClassicDot(level: level)
        } else {
            switch level {
            case .busy: BrailleSpinner()
            case .off: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .inkDim)
            default: PixelSprite(rows: PixelArt.square, pixel: 2, color: level.color)
            }
        }
    }
}

/// A profile's mark (docs/profiles-v0.md §3.2, ui-v0 §7.2.11): a small lit dot in the profile's colour on what runs
/// under it. Told from a state's mark by more than its colour: it is smaller, flat, has a glow, and sits at the
/// row's end beside the agent, where a state's mark leads the row. A square in the pixel look.
struct ProfileDot: View {
    let color: ProfileColor
    var side: CGFloat = 6
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let fill = Color.profile(color)
        Group { if look.isClassic { Circle().fill(fill) } else { Rectangle().fill(fill) } }
            .frame(width: side, height: side)
            .shadow(color: fill.opacity(0.8), radius: side * 0.45)
            .accessibilityHidden(true)
    }
}

/// In progress, everywhere the same (web page, Mac, phone): ⠋⠙⠹…; a still first frame under Reduce Motion. It turns
/// only while seen, every spinner on the same beat (ui-v0 §7.4, 2026-10-03).
struct BrailleSpinner: View {
    static let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    /// The glyph's size: 12 in a line of words, smaller as a mark off an icon (the rail).
    var size: CGFloat = 12
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onScreen) private var onScreen
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            ClassicSpinner(size: size)
        } else {
            braille
        }
    }

    private var braille: some View {
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
        .frame(width: (size * 2 / 3).rounded())
        .accessibilityLabel("Busy")
    }

    private func glyph(_ step: Int) -> some View {
        Text(Self.frames[step % Self.frames.count]).font(.system(size: size, design: .monospaced)).foregroundStyle(Color.busy)
    }
}

/// `// Status`: a group's label in title case (docs/ui-v0.md §7.2.7), monospaced, spaced out. In the classic look a
/// plain small title.
struct SectionLabel: View {
    let text: String
    @Environment(\.interfaceLook) private var look

    init(_ text: String) { self.text = text }

    var body: some View {
        if look.isClassic {
            Text(ClassicWords.word(text, in: look)).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary).textCase(nil)
        } else {
            Text("// \(text)")
                .font(.system(size: 10.5, design: .monospaced))
                .tracking(1.4)
                .foregroundStyle(.secondary)
                .textCase(nil)
        }
    }
}

/// `████░░░░ 62%` in characters: the used part in green (red from Usage.highPercent), the rest faint. In the classic
/// look a thin bar of the same width.
struct CharMeter: View {
    let fraction: Double
    var high = false
    var cells = 10
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            ClassicBar(fraction: fraction, color: high ? .failed : .ok, width: CGFloat(cells) * 5.5)
        } else {
            let used = max(0, min(cells, Int((fraction * Double(cells)).rounded())))
            (Text(String(repeating: "█", count: used)).foregroundStyle(high ? Color.failed : Color.ok)
                + Text(String(repeating: "░", count: cells - used)).foregroundStyle(Color.inkDim))
                .font(.system(size: 10, design: .monospaced))
                .kerning(-0.5)
                .accessibilityHidden(true)
        }
    }
}

/// A 1 pt solid rule, where a system divider would be (2026-10-03, user: 分割线也别弄虚线了，改成实线吧，看着累人; two on, two off before).
struct HairRule: View {
    var color: Color = Color.primary.opacity(0.14)
    /// Down instead of across (the rail's edge, a list's edge).
    var vertical = false

    var body: some View {
        Rectangle()
            .fill(color)
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
            .accessibilityHidden(true)
    }
}

extension View {
    /// Short words (states, labels, values): monospaced (§7.2.7); the system font in the classic look (§8), where
    /// monospaced is left to code, commands and paths (`code`).
    func mono(_ size: CGFloat = 12, weight: Font.Weight = .regular) -> some View {
        modifier(ShortWordFont(size: size, weight: weight))
    }

    /// Code, a command, a path, a number in a column: monospaced in both looks.
    func code(_ size: CGFloat = 12, weight: Font.Weight = .regular) -> some View {
        font(.system(size: size, weight: weight, design: .monospaced))
    }
}

private struct ShortWordFont: ViewModifier {
    let size: CGFloat
    let weight: Font.Weight
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: look.isClassic ? .default : .monospaced))
    }
}
