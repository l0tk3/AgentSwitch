import AgentSwitchKit
import SwiftUI

/// The shared look (docs/ui-v0.md §7, visual language v1): pixel / character / signal, restrained. One signal colour
/// (AccentColor, pink #E0106E / #FF2E88) for selection, the brand mark and the primary button; status colours only for
/// status, always with a shape or a word; square corners and 1 px lines outside the system's own controls.
/// In the classic look (§8) the same names give a standard app's values: the system's blue for the signal, the system's
/// status colours, grouped grounds, round corners.
enum Theme {
    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
        /// Between items of the conversation.
        static let item: CGFloat = 20
    }

    /// Square everywhere outside the system's own controls (§7.2.1); round in the classic look (§8: controls 6–8,
    /// cards 10–12, bubbles and the input 14–17).
    enum Radius {
        static var card: CGFloat { InterfaceLook.current.isClassic ? 12 : 0 }
        static var bubble: CGFloat { InterfaceLook.current.isClassic ? 17 : 0 }
        static var control: CGFloat { InterfaceLook.current.isClassic ? 8 : 0 }
    }

    // §7.3, dark / light; then the classic look's (§8: the system's blue, its status colours, its grouped grounds).
    static let signal = Color(light: 0xE0106E, dark: 0xFF2E88, classicLight: 0x007AFF, classicDark: 0x0A84FF)
    /// At work: cyan; the accent in the classic look (one colour for what is yours to see moving).
    static let busy = Color(light: 0x0086A8, dark: 0x2EE6FF, classicLight: 0x007AFF, classicDark: 0x0A84FF)
    static let waiting = Color(light: 0xC27400, dark: 0xFFB000, classicLight: 0xFF9500, classicDark: 0xFF9F0A)
    /// A profile's colour (docs/profiles-v0.md §3.2): who a terminal runs as, never a state.
    static func profile(_ color: ProfileColor) -> Color { Color(light: color.light, dark: color.dark) }
    static let done = Color(light: 0x3F8F00, dark: 0x9BE22D, classicLight: 0x34C759, classicDark: 0x30D158)
    static let failed = Color(light: 0xD7261B, dark: 0xFF4A3D, classicLight: 0xFF3B30, classicDark: 0xFF453A)
    /// The page under the conversation and a task: black, or paper in light mode.
    static let base = Color(light: 0xF3F1EA, dark: 0x000000, classicLight: 0xF2F2F7, classicDark: 0x000000)
    static let ink = Color(light: 0x151413, dark: 0xE9E6DF, classicLight: 0x1D1D1F, classicDark: 0xF2F2F7)
    static let inkDim = Color(light: 0xA29D93, dark: 0x4D4B48, classicLight: 0xA6A6AB, classicDark: 0x6C6C72)
    /// §7.3's 次 (second ink): the lower edge of a solid key cap, and the cap while it is pressed.
    static let secondaryInk = Color(light: 0x5F5B54, dark: 0x8D8A84, classicLight: 0x6E6E73, classicDark: 0xA2A2A8)
    /// 1 px lines: card frames, rules.
    static let line = Color(light: 0xD3CEC3, dark: 0x262524, classicLight: 0xDCDCE0, classicDark: 0x38383A)
    /// What you said: a raised box, not a coloured bubble (the signal colour is not for text backgrounds) — in the
    /// classic look too, since 2026-10-07: a quiet grey under ink text, as both agents' own apps set a user's message.
    static let raised = Color(light: 0xE6E2D8, dark: 0x161514, classicLight: 0xE9E9EB, classicDark: 0x2C2C2E)
    /// A card's or a floating layer's own ground in the classic look (the pixel look frames them on the page's).
    static let panel = Color(light: 0xF3F1EA, dark: 0x000000, classicLight: 0xFFFFFF, classicDark: 0x1C1C1E)
    /// Code's ground (2026-10-03): a wash of ink, so a block or a span stands out on the page and in your raised box
    /// alike.
    static let code = ink.opacity(0.07)
    static let pixelShadow = Color(light: 0xCFC9BC, dark: 0x2C2A28)
    /// The highest thinking level's own colour (docs/terminal-v0.md §1 “滑块”, 2026-10-07): violet, and the deeper blue
    /// its line begins in. Nothing else is this colour.
    static let top = Color(light: 0x7A3CF0, dark: 0xA98BFF, classicLight: 0x8E5CF7, classicDark: 0xA58BFF)
    static let topDeep = Color(light: 0x3B3FD8, dark: 0x4B4FE0, classicLight: 0x2F3DC8, classicDark: 0x3D4BE0)
    /// The primary button's fill: ink, with the page's colour on it; the signal colour only while pressed (§7.2.3, as
    /// the web page's hover). In the classic look the accent, with white on it.
    static let fill = Color(light: 0x151413, dark: 0xE9E6DF, classicLight: 0x007AFF, classicDark: 0x0A84FF)
    /// What is written on the primary button's fill.
    static let onFill = Color(light: 0xF3F1EA, dark: 0x000000, classicLight: 0xFFFFFF, classicDark: 0xFFFFFF)
    static let card = Color.clear

    static func color(_ status: TaskStatus) -> Color {
        switch status {
        case .done: return done
        case .failed: return failed
        case .waitingApproval: return waiting
        case .partial, .blocked: return waiting
        case .cancelled, .other: return .secondary
        case .queued: return .secondary
        case .routing, .running: return busy
        }
    }
}

extension Color {
    /// A colour by the system's light or dark; with classic values, also by the look kept in the settings, asked at
    /// every draw (the root rebuilds its views when the look changes: Look.swift).
    init(light: UInt32, dark: UInt32, classicLight: UInt32? = nil, classicDark: UInt32? = nil) {
        self.init(UIColor { trait in
            let classic = (classicLight != nil || classicDark != nil) && InterfaceLook.current.isClassic
            let isDark = trait.userInterfaceStyle == .dark
            return UIColor(rgb: isDark ? (classic ? classicDark ?? dark : dark) : (classic ? classicLight ?? light : light))
        })
    }
}

extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}

/// A status: its pixel mark (a square, hollow once ended without success, the spinner while busy) and its word, in
/// the status colour. `waiting` overrides (a pending question on a running task).
struct StatusLabel: View {
    let task: AgentTask
    var waiting = false

    var body: some View {
        let color = waiting ? Theme.waiting : Theme.color(task.status)
        HStack(spacing: 6) {
            StatusMark(status: waiting ? .waitingApproval : task.status)
            LookWord(waiting ? TaskStatus.waitingApproval.label : task.statusLabel).mono(12, weight: .medium).foregroundStyle(color)
        }
    }
}

/// One level of container: a 1 px frame, square (§7.2.1). In the classic look a round card on its own ground.
struct CardStyle: ViewModifier {
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        if look.isClassic {
            content
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        } else {
            content
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
        }
    }
}

extension View {
    func card() -> some View { modifier(CardStyle()) }
}

/// A square button in brackets, `[ allow ]` (as the web page's .btn): the primary one filled with ink and turning to
/// the signal colour while pressed; the others a 1 px frame; a destructive one says so in red. `expand` fills the width.
/// In the classic look a standard button: the primary one filled with the accent, the others on a quiet ground, round.
struct SquareButtonStyle: ButtonStyle {
    var prominent = false
    var destructive = false
    var expand = true
    @Environment(\.isEnabled) private var enabled
    @Environment(\.interfaceLook) private var look

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        if look.isClassic {
            configuration.label
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(prominent ? Theme.onFill : destructive ? Theme.failed : Theme.ink)
                .padding(.vertical, 10)
                .padding(.horizontal, expand ? 0 : 16)
                .frame(maxWidth: expand ? .infinity : nil)
                .background(prominent ? Theme.fill : Theme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .opacity(enabled ? (pressed ? 0.7 : 1) : 0.45)
        } else {
            let ink: Color = prominent ? (pressed ? .black : Theme.base) : destructive ? Theme.failed : Theme.ink
            let fill: Color = prominent ? (pressed ? Theme.signal : Theme.fill) : (pressed ? Theme.line : .clear)
            configuration.label
                .mono(14, weight: .medium)
                .foregroundStyle(ink)
                .padding(.vertical, 10)
                .padding(.horizontal, expand ? 0 : 12)
                .frame(maxWidth: expand ? .infinity : nil)
                .background(fill)
                .overlay(Rectangle().strokeBorder(prominent ? fill : Theme.line, lineWidth: 1))
                .opacity(enabled ? 1 : 0.45)
        }
    }
}

/// A square icon-sized button (send, +): ink when it can act, a 1 px frame when not; the signal colour while pressed.
/// In the classic look a disc: the accent when it can act, a quiet ground when not.
struct SquareIconButtonStyle: ButtonStyle {
    var active = true
    var side: CGFloat = 38
    @Environment(\.interfaceLook) private var look

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && active
        if look.isClassic {
            configuration.label
                .foregroundStyle(active ? Theme.onFill : Theme.inkDim)
                .frame(width: side - 6, height: side - 6)
                .background(Circle().fill(active ? Theme.fill : Theme.raised))
                .frame(width: side, height: side)
                .opacity(pressed ? 0.7 : 1)
        } else {
            configuration.label
                .foregroundStyle(active ? (pressed ? Color.black : Theme.base) : Theme.inkDim)
                .frame(width: side, height: side)
                .background(active ? (pressed ? Theme.signal : Theme.fill) : Color.clear)
                .overlay(Rectangle().strokeBorder(active ? Color.clear : Theme.line, lineWidth: 1))
        }
    }
}

