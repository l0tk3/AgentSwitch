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
    static let panel = Color(nsColor: .dynamic(light: 0xECE8DF, dark: 0x0B0B0B, classicLight: 0xF5F6F8, classicDark: 0x17181C, name: "AgentSwitchDispatchPanel"))
    /// What you said: a raised box (the signal colour is not for text backgrounds).
    static let raised = Color(nsColor: .dynamic(light: 0xE4DFD4, dark: 0x151515, classicLight: 0xF0F1F4, classicDark: 0x1F2025, name: "AgentSwitchDispatchRaised"))
    static let hover = Color(nsColor: .dynamic(light: 0xE9E5DC, dark: 0x121212, classicLight: 0xE9EBF0, classicDark: 0x24252B, name: "AgentSwitchDispatchHover"))
    /// What you said, as its ground: the raised box of the pixel look; in the classic look a wash of the ink under
    /// ink text — as both agents' own desktop apps set a user's message (about 5% of the text's colour), no longer the
    /// accent's bubble with white text (docs/ui-v0.md §8, 2026-10-07).
    static let said = Color(nsColor: .dynamic(light: 0xE4DFD4, dark: 0x151515, classicLight: 0xF0F1F4, classicDark: 0x1F2025, name: "AgentSwitchDispatchSaid"))

    /// The highest thinking level's own colour (docs/terminal-v0.md §1 “滑块”, 2026-10-07): violet, and the deeper blue
    /// its line begins in. Nothing else is this colour.
    static let top = Color(nsColor: .dynamic(light: 0x7A3CF0, dark: 0xA98BFF, classicLight: 0x8E5CF7, classicDark: 0xA58BFF, name: "AgentSwitchEffortTop"))
    static let topDeep = Color(nsColor: .dynamic(light: 0x3B3FD8, dark: 0x4B4FE0, classicLight: 0x2F3DC8, classicDark: 0x3D4BE0, name: "AgentSwitchEffortTopDeep"))

    /// How an answer is set in this look — its size, the room between its lines and between its blocks (docs/ui-v0.md
    /// §8 “对话的字号”): the classic look sets what the agent says at 13, with a little more room between lines and
    /// blocks than a label has, so that it reads as text to read. It was 15, then 14 (the size both agents' own apps
    /// set prose); with the size his to set, the user tried them and chose 13 (2026-10-07: 经过我的测试 13pt的字体正合适，
    /// 作为默认字体吧). The pixel look keeps its own.
    static func prose(_ look: InterfaceLook) -> (size: CGFloat, lineSpacing: CGFloat, blockSpacing: CGFloat) {
        let own: (size: CGFloat, lineSpacing: CGFloat, blockSpacing: CGFloat) = look.isClassic ? (13, 5, 10) : (13.5, 4, 8)
        return (scaled(own.size), own.lineSpacing, own.blockSpacing)
    }

    /// The size an answer is set at in this look before the setting moves it: what the setting names a step by.
    static func proseBase(_ look: InterfaceLook) -> CGFloat { look.isClassic ? 13 : 13.5 }

    /// The size of what you type and of what you said, in the look in force: an answer's in the classic look, 14 in
    /// the pixel one.
    static var typed: CGFloat { scaled(InterfaceLook.current.isClassic ? 13 : 14) }

    /// A size of the conversation's text moved by the step set in 设置 › General (`TextSize`).
    static func scaled(_ size: CGFloat) -> CGFloat { CGFloat(TextSize.size(Double(size), step: TextScale.shared.step)) }

    /// A size of the conversation's text in this look (docs/ui-v0.md §8 “对话的字号”, 2026-10-07): the pixel look's own,
    /// set in its fixed-width letters; in the classic look three sizes — text 13, the steps and what is beside them
    /// 12, code and the small words 11 — a point under what both agents' own desktop apps set, as the user chose.
    static func size(_ pixel: CGFloat, _ look: InterfaceLook) -> CGFloat {
        guard look.isClassic else { return scaled(pixel) }
        switch pixel {
        case ..<11.75: return scaled(11)
        case ..<12.75: return scaled(12)
        case ..<13.75: return scaled(13)
        default: return scaled(pixel - 1)
        }
    }
    /// Code's ground (2026-10-03): a wash of ink, so a block or a span stands out on the page, a card and your raised
    /// box alike.
    static let code = ink.opacity(0.07)

    /// The reading column (docs/dispatch-v0.md §2): at most 760 pt with its 24 pt sides.
    static let column: CGFloat = 760
    static let side: CGFloat = 24

    /// The classic look's layers (§8.1, 2026-11-26; user #428: 加一些圆角和层级, #450 chose "C"): the window's ground
    /// is the content's — the terminal's own on Terminals, so the two stay of one piece (2026-10-04: classic不够黑，
    /// 不够一体化，和终端有些割裂) —, with the bar, the rail and the status bar drawn on it and no lines between; a side
    /// column (a page's list, Files, a room's members) is a card a step lighter that floats over it with round
    /// corners (`sideCard`). `sidebar` is such a card's ground; `chrome` what the put-away rail comes out on.
    static let chrome = Color(nsColor: .dynamic(light: 0xF3F4F7, dark: 0x191A1E, name: "AgentSwitchClassicChrome"))
    static let sidebar = Color(nsColor: .dynamic(light: 0xF3F4F7, dark: 0x191A1E, name: "AgentSwitchClassicSidebar"))
    /// The faint ring around a floating card.
    static let ring = Color(nsColor: .dynamic(light: 0xDFE1E6, dark: 0x2A2B31, name: "AgentSwitchClassicRing"))

    /// The classic look's corners (§8.1): a control's or a row's, a card's or a floating box's, a bubble's or the
    /// input's, the content panel's.
    static let controlRadius: CGFloat = 8
    static let cardRadius: CGFloat = 12
    static let bubbleRadius: CGFloat = 16
    /// What you said: a box with round corners.
    static let saidRadius: CGFloat = 12
    static let panelRadius: CGFloat = 12
    /// The room between the content panel and the window's edge, and between two panels.
    static let panelGap: CGFloat = 8
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
    /// A side column in the classic look (§8.1): a card that floats on the page — its own ground, round corners, a
    /// faint ring and a soft shadow —, this far from what is beside it. Nothing in the pixel look.
    func sideCard(leading: CGFloat = 0, trailing: CGFloat = 0, bottom: CGFloat = 2) -> some View {
        modifier(SideCard(leading: leading, trailing: trailing, bottom: bottom))
    }

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

private struct SideCard: ViewModifier {
    let leading: CGFloat
    let trailing: CGFloat
    let bottom: CGFloat
    @Environment(\.interfaceLook) private var look
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        if look.isClassic {
            let shape = RoundedRectangle(cornerRadius: Look.panelRadius, style: .continuous)
            content
                .background(Look.sidebar)
                .clipShape(shape)
                .overlay(shape.strokeBorder(Look.ring, lineWidth: 0.5))
                .shadow(color: .black.opacity(scheme == .dark ? 0.5 : 0.08), radius: scheme == .dark ? 12 : 8, y: 2)
                .padding(.leading, leading)
                .padding(.trailing, trailing)
                .padding(.bottom, bottom)
        } else {
            content
        }
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

/// A terminal's mark in a list: the amber square blinking while it waits for you (still under Reduce Motion),
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
