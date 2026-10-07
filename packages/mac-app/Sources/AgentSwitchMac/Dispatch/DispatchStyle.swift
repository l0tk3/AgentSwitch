import AgentSwitchMacCore
import AppKit
import SwiftUI

// The Dispatch page's look (docs/ui-v0.md §7, demo `mac-window.html`): the inks of §7.3, square 1 px frames, `[ Word ]`
// buttons that invert under the pointer (the primary one turns signal), floating boxes with a dithered hard shadow, the
// progress blocks and the agents' sprites. Text people read stays in the system font.
//
// In the classic look (§8, `\.interfaceLook`) the same parts are a standard app's: the system's greys, buttons with
// round corners (the primary one filled with the accent), cards with a soft shadow, a thin progress bar.

/// The page's colours, dark / light (ui-v0 §7.3; the panel and raised greys from the demo).
enum Look {
    static let ground = Color(nsColor: .dispatchGround)
    static let ink = Color(nsColor: .dynamic(light: 0x151413, dark: 0xE9E6DF, classicLight: 0x1D1D1F, classicDark: 0xEDEDF0, name: "AgentSwitchDispatchInk"))
    static let ink2 = Color(nsColor: .dynamic(light: 0x5F5B54, dark: 0x8D8A84, classicLight: 0x6E6E73, classicDark: 0xA2A2A8, name: "AgentSwitchDispatchInk2"))
    static let faint = Color.inkDim
    static let line = Color(nsColor: .barEdge)
    /// A card's ground.
    static let panel = Color(nsColor: .dynamic(light: 0xECE8DF, dark: 0x0B0B0B, classicLight: 0xFFFFFF, classicDark: 0x141416, name: "AgentSwitchDispatchPanel"))
    /// What you said: a raised box (the signal colour is not for text backgrounds).
    static let raised = Color(nsColor: .dynamic(light: 0xE4DFD4, dark: 0x151515, classicLight: 0xF0F0F2, classicDark: 0x232326, name: "AgentSwitchDispatchRaised"))
    static let hover = Color(nsColor: .dynamic(light: 0xE9E5DC, dark: 0x121212, classicLight: 0xEDEDEF, classicDark: 0x18181B, name: "AgentSwitchDispatchHover"))
    /// What you said, as its ground: the raised box of the pixel look; in the classic look a wash of the ink under
    /// ink text — as both agents' own desktop apps set a user's message (about 5% of the text's colour), no longer the
    /// accent's bubble with white text (docs/ui-v0.md §8, 2026-10-07).
    static let said = Color(nsColor: .dynamic(light: 0xE4DFD4, dark: 0x151515, classicLight: 0xE8E8EB, classicDark: 0x1F1F22, name: "AgentSwitchDispatchSaid"))

    /// The highest thinking level's own colour (docs/terminal-v0.md §1 “滑块”, 2026-10-07): violet, and the deeper blue
    /// its line begins in. Nothing else is this colour.
    static let top = Color(nsColor: .dynamic(light: 0x7A3CF0, dark: 0xA98BFF, classicLight: 0x8E5CF7, classicDark: 0xA58BFF, name: "AgentSwitchEffortTop"))
    static let topDeep = Color(nsColor: .dynamic(light: 0x3B3FD8, dark: 0x4B4FE0, classicLight: 0x2F3DC8, classicDark: 0x3D4BE0, name: "AgentSwitchEffortTopDeep"))

    /// How an answer is set in this look — its size, the room between its lines and between its blocks (docs/ui-v0.md
    /// §8 “对话的字号”): the classic look sets what the agent says at 14, the size both agents' own apps set prose and
    /// this app's reply box is typed in, with a little more room between lines and blocks than a label has, so that
    /// it reads as text to read. Not larger: at 15 it stood out against everything around it (2026-10-07, user: Mac上的
    /// 字体太大了哥们 和其他的字体比起来). The pixel look keeps its own.
    static func prose(_ look: InterfaceLook) -> (size: CGFloat, lineSpacing: CGFloat, blockSpacing: CGFloat) {
        look.isClassic ? (14, 5, 10) : (13.5, 4, 8)
    }

    /// A size of the conversation's text in this look (docs/ui-v0.md §8 “对话的字号”, 2026-10-07): the pixel look's own,
    /// set in its fixed-width letters; in the classic look no smaller than both agents' own desktop apps set theirs —
    /// text 14, code and the small words 12.
    static func size(_ pixel: CGFloat, _ look: InterfaceLook) -> CGFloat {
        guard look.isClassic else { return pixel }
        switch pixel {
        case ..<11.75: return 12
        case ..<12.75: return 13
        case ..<13.75: return 14
        default: return pixel
        }
    }
    /// Code's ground (2026-10-03): a wash of ink, so a block or a span stands out on the page, a card and your raised
    /// box alike.
    static let code = ink.opacity(0.07)

    /// The reading column (docs/dispatch-v0.md §2): at most 760 pt with its 24 pt sides.
    static let column: CGFloat = 760
    static let side: CGFloat = 24

    /// The classic look's window chrome (§8, the concept page's `--chrome` and `--side`): the bar's and the status
    /// bar's ground, and the rail's. The pixel look has none of its own: the page's ground runs under all of them. On
    /// the main window's dark pages they are the terminal's black too — one surface, parted by hairlines, the cards and
    /// what is raised a little lighter (2026-10-04; user: classic不够黑，不够一体化，和终端有些割裂; two greys before).
    static let chrome = Color(nsColor: .dynamic(light: 0xF6F6F7, dark: 0x000000, name: "AgentSwitchClassicChrome"))
    static let sidebar = Color(nsColor: .dynamic(light: 0xF2F2F4, dark: 0x000000, name: "AgentSwitchClassicSidebar"))

    /// The classic look's corners (§8): a control's, a card's or a floating box's, a bubble's or the input's.
    static let controlRadius: CGFloat = 6
    static let cardRadius: CGFloat = 10
    static let bubbleRadius: CGFloat = 15
}

extension StatusLevel {
    /// A status word's colour: Busy and the hollow states stay secondary, the rest in their status colour.
    var wordColor: Color {
        switch self {
        case .ok: return .ok
        case .warning: return .waiting
        case .error: return .failed
        case .busy, .off: return Look.ink2
        }
    }
}

extension View {
    /// One reading column, centred.
    func dispatchColumn() -> some View {
        frame(maxWidth: Look.column - 2 * Look.side, alignment: .leading)
            .padding(.horizontal, Look.side)
            .frame(maxWidth: .infinity)
    }
}

// MARK: - by the look

extension View {
    /// A frame around a part: 1 px and square in the pixel look; a hairline with round corners in the classic one, the
    /// part clipped to them.
    func framed(_ color: Color = Look.line, radius: CGFloat = Look.cardRadius) -> some View {
        modifier(LookFrame(color: color, radius: radius))
    }

    /// A ground under a part: square in the pixel look, with round corners in the classic one.
    func grounded(_ color: Color, radius: CGFloat = Look.cardRadius) -> some View {
        modifier(LookGround(color: color, radius: radius))
    }
}

private struct LookFrame: ViewModifier {
    let color: Color
    let radius: CGFloat
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        if look.isClassic {
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            content.clipShape(shape).overlay(shape.strokeBorder(color, lineWidth: 0.5))
        } else {
            content.overlay(Rectangle().strokeBorder(color, lineWidth: 1))
        }
    }
}

private struct LookGround: ViewModifier {
    let color: Color
    let radius: CGFloat
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        if look.isClassic {
            content.background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(color))
        } else {
            content.background(color)
        }
    }
}

/// A short word as the look writes it (ClassicWords: `Waiting` is `Needs You` in the classic look).
struct LookWord: View {
    let word: String
    @Environment(\.interfaceLook) private var look

    init(_ word: String) { self.word = word }

    var body: some View { Text(ClassicWords.word(word, in: look)) }
}

/// A character the pixel look uses as a mark (`›`, `×`, `▸`), or the system symbol that stands for it in the classic one.
struct LookGlyph: View {
    let glyph: String
    let symbol: String
    var size: CGFloat = 12
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            Image(systemName: symbol).font(.system(size: size * 0.82, weight: .semibold))
        } else {
            Text(glyph).font(.system(size: size, design: .monospaced))
        }
    }
}

/// A choice's mark: `<x>` `< >` for one of several and `[x]` `[ ]` for several in the pixel look; the system's filled
/// or empty circle and square in the classic one.
struct LookChoice: View {
    let on: Bool
    var multi = false
    var size: CGFloat = 13
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            Image(systemName: multi ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                .font(.system(size: size))
        } else {
            Text(multi ? (on ? "[x]" : "[ ]") : (on ? "<x>" : "< >")).font(.system(size: size, design: .monospaced))
        }
    }
}

// MARK: - marks

/// A task's mark: the spinner while busy, the amber square blinking while it waits for you (still under Reduce Motion),
/// else the status square.
struct TaskMark: View {
    let level: StatusLevel
    var waiting = false

    var body: some View {
        if waiting { BlinkingSquare() } else { StatusMark(level: level) }
    }
}

/// An agent's 5 × 5 sprite (ui-v0 §7.3), its name on hover.
struct AgentSprite: View {
    let harness: String?

    var body: some View {
        if let harness {
            PixelSprite(rows: PixelArt.agents[harness] ?? PixelArt.agents["pi"]!, pixel: 2, color: Look.ink2, strength: 0.8, shadow: false)
                .help(HarnessName.display(harness))
        }
    }
}

/// Ended and not opened yet: a small signal square (never mistaken for the status mark); a dot in the classic look.
struct UnreadSquare: View {
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Group {
            if look.isClassic { Circle().fill(Color.signal) } else { Rectangle().fill(Color.signal) }
        }
        .frame(width: 6, height: 6)
        .accessibilityLabel("未读")
    }
}

/// `▮▮▮▯▯ 3/5`: the step a multi-step task is on; a thin bar in the classic look.
struct ProgressBlocks: View {
    let progress: DispatchProgress
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 8) {
            if look.isClassic {
                let done = progress.blocks.filter { $0 }.count
                ClassicBar(fraction: progress.blocks.isEmpty ? 0 : Double(done) / Double(progress.blocks.count), color: .busy,
                           width: CGFloat(progress.blocks.count) * 14)
            } else {
                HStack(spacing: 2) {
                    ForEach(Array(progress.blocks.enumerated()), id: \.offset) { _, on in
                        Rectangle().fill(on ? Color.busy : Look.line).frame(width: 12, height: 8)
                    }
                }
            }
            Text(progress.text).mono(11.5).foregroundStyle(Look.ink2)
        }
        .accessibilityElement()
        .accessibilityLabel("Step \(progress.text)")
    }
}

// MARK: - buttons

/// `[ Allow ⌘↩ ]`: a short word in brackets, the key hint faint. In the classic look the word and, smaller, its key.
struct BracketLabel: View {
    let word: String
    var key: String?
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            HStack(spacing: 5) {
                Text(ClassicWords.word(word, in: look))
                if let key { Text(key).font(.system(size: 10.5)).opacity(0.6) }
            }
        } else {
            HStack(spacing: 0) {
                Text("[ \(word) ")
                if let key { Text(key).font(.system(size: 11, design: .monospaced)).foregroundStyle(Look.faint); Text(" ") }
                Text("]")
            }
        }
    }
}

/// The page's text buttons (the demo's `.btn`): monospaced, inverted under the pointer; the primary one filled with ink
/// and signal under the pointer; a destructive one red under the pointer. In the classic look standard buttons: round
/// corners, the primary one filled with the accent, the others a light ground and a hairline, a destructive one in red.
struct BracketButtonStyle: ButtonStyle {
    enum Role { case normal, primary, destructive }
    var role: Role = .normal
    var size: CGFloat = 12.5

    func makeBody(configuration: Configuration) -> some View {
        BracketButtonBody(configuration: configuration, role: role, size: size)
    }
}

private struct BracketButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let role: BracketButtonStyle.Role
    let size: CGFloat
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let lit = enabled && (hovering || configuration.isPressed)
        Group {
            if look.isClassic {
                classic(lit, pressed: configuration.isPressed)
            } else {
                configuration.label
                    .font(.system(size: size, design: .monospaced))
                    .lineLimit(1)
                    .fixedSize()
                    .foregroundStyle(foreground(lit))
                    .padding(.horizontal, role == .primary ? 2 : 0)
                    .background(background(lit))
            }
        }
        .opacity(enabled ? 1 : 0.4)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }

    private func classic(_ lit: Bool, pressed: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        let ground: Color = switch role {
        case .primary: Color.signal.opacity(pressed ? 0.75 : lit ? 0.88 : 1)
        case .destructive: lit ? Color.failed.opacity(0.16) : Look.raised.opacity(0.6)
        case .normal: lit ? Look.raised : Look.raised.opacity(0.6)
        }
        return configuration.label
            .font(.system(size: size - 0.5, weight: role == .primary ? .semibold : .medium))
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(role == .primary ? Color.white : role == .destructive ? Color.failed : Look.ink)
            .padding(.horizontal, 10)
            .padding(.vertical, 3.5)
            .background(shape.fill(ground))
            .overlay(shape.strokeBorder(role == .primary ? Color.clear : Look.line, lineWidth: 0.5))
    }

    private func foreground(_ lit: Bool) -> Color {
        switch role {
        case .primary: return lit ? .black : Look.ground
        case .destructive: return lit ? .black : Look.ink
        case .normal: return lit ? Look.ground : Look.ink
        }
    }

    private func background(_ lit: Bool) -> Color {
        switch role {
        case .primary: return lit ? .signal : Look.ink
        case .destructive: return lit ? .failed : .clear
        case .normal: return lit ? Look.ink : .clear
        }
    }
}

/// A plain row or card that answers the pointer (its frame brightens) and opens on a click.
struct HoverFrame: ViewModifier {
    var color: Color = Look.line
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        content
            .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? Look.cardRadius : 0, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: look.isClassic ? Look.cardRadius : 0, style: .continuous)
                .strokeBorder(hovering ? Look.faint : color, lineWidth: look.isClassic ? 0.5 : 1))
            .onHover { hovering = $0 }
    }
}

// MARK: - floating boxes

/// A 50 % checkerboard of 1 pt cells: a floating box's hard shadow (ui-v0 §7.3).
struct Checker: View {
    var color: Color = Look.faint

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

/// A box inside a card (approval, question): 1 px frame — amber while it waits for you — a head bar, the content, and
/// the dithered 6 pt hard shadow; room on the right and below for the shadow.
struct FloatingBox<Content: View>: View {
    let title: String
    var trailing: String = ""
    var waiting = true
    /// The classic look's sign before the title: a warning while it waits for you unless another is named (a question's
    /// mark); none for a box that waits for nothing (a new tab).
    var symbol: String? = nil
    /// A colour of its own for the head bar and the frame (the sealed reply's box: the signal colour); in the classic
    /// look only its sign takes it.
    var tint: Color? = nil
    @ViewBuilder let content: Content
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic { classic } else { pixel }
    }

    /// The classic look's card: round corners, a warning sign and the title in place of the filled head bar, a tint of
    /// amber while it waits for you, a soft shadow.
    private var classic: some View {
        let shape = RoundedRectangle(cornerRadius: Look.cardRadius, style: .continuous)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                if let name = symbol ?? (waiting ? "exclamationmark.triangle" : nil) {
                    Image(systemName: name).font(.system(size: 12.5, weight: .medium)).foregroundStyle(tint ?? (waiting ? Color.waiting : Look.ink2))
                }
                Text(ClassicWords.word(title, in: look)).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Look.ink).lineLimit(1)
                Spacer(minLength: 8)
                Text(trailing).font(.system(size: 11.5)).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.middle)
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 2)
            content
        }
        .background(shape.fill(waiting ? Color.waiting.opacity(0.09) : Look.panel))
        .background(shape.fill(Look.panel))
        .overlay(shape.strokeBorder(waiting ? Color.waiting.opacity(0.45) : Look.line, lineWidth: 0.5))
        .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
        .padding(.trailing, 7)
        .padding(.bottom, 7)
    }

    private var pixel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(title).lineLimit(1)
                Spacer(minLength: 8)
                Text(trailing).lineLimit(1).truncationMode(.middle)
            }
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(waiting || tint != nil ? Color.black : Look.ground)
            .padding(.horizontal, 10)
            .frame(height: 24)
            .background(tint ?? (waiting ? Color.waiting : Look.ink))
            content
        }
        .background(Look.ground)
        .overlay(Rectangle().strokeBorder(tint ?? (waiting ? Color.waiting : Look.ink), lineWidth: 1))
        .background(Checker().offset(x: 6, y: 6))
        .padding(.trailing, 7)
        .padding(.bottom, 7)
    }
}

// MARK: - small labels

/// `// Process`: a page part's label (the demo's `.lbl`); a plain small title in the classic look.
struct PartLabel: View {
    let text: String
    @Environment(\.interfaceLook) private var look
    init(_ text: String) { self.text = text }

    var body: some View {
        if look.isClassic {
            Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(Look.ink2)
        } else {
            Text("// \(text)").font(.system(size: 11, design: .monospaced)).tracking(0.44).foregroundStyle(Look.faint)
        }
    }
}
