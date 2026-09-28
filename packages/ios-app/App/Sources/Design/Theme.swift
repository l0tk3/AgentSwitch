import AgentSwitchKit
import SwiftUI

/// The shared look (docs/ui-v0.md §7, visual language v1): pixel / character / signal, restrained. One signal colour
/// (AccentColor, pink #E0106E / #FF2E88) for selection, the brand mark and the primary button; status colours only for
/// status, always with a shape or a word; square corners and 1 px lines outside the system's own controls.
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

    /// Square everywhere outside the system's own controls (§7.2.1).
    enum Radius {
        static let card: CGFloat = 0
        static let bubble: CGFloat = 0
    }

    // §7.3, dark / light.
    static let signal = Color(light: 0xE0106E, dark: 0xFF2E88)
    static let busy = Color(light: 0x0086A8, dark: 0x2EE6FF)
    static let waiting = Color(light: 0xC27400, dark: 0xFFB000)
    static let done = Color(light: 0x3F8F00, dark: 0x9BE22D)
    static let failed = Color(light: 0xD7261B, dark: 0xFF4A3D)
    /// The page under the conversation and a task: black, or paper in light mode.
    static let base = Color(light: 0xF3F1EA, dark: 0x000000)
    static let ink = Color(light: 0x151413, dark: 0xE9E6DF)
    static let inkDim = Color(light: 0xA29D93, dark: 0x4D4B48)
    /// 1 px lines: card frames, rules.
    static let line = Color(light: 0xD3CEC3, dark: 0x262524)
    /// What you said: a raised box, not a coloured bubble (the signal colour is not for text backgrounds).
    static let raised = Color(light: 0xE6E2D8, dark: 0x161514)
    static let pixelShadow = Color(light: 0xCFC9BC, dark: 0x2C2A28)
    /// The primary button's fill: ink, with the page's colour on it; the signal colour only while pressed (§7.2.3, as
    /// the web page's hover).
    static let fill = ink
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
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { trait in UIColor(rgb: trait.userInterfaceStyle == .dark ? dark : light) })
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
            Text(waiting ? TaskStatus.waitingApproval.label : task.statusLabel).mono(12, weight: .medium).foregroundStyle(color)
        }
    }
}

/// One level of container: a 1 px frame, square (§7.2.1).
struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
    }
}

extension View {
    func card() -> some View { modifier(CardStyle()) }
}

/// A square button in brackets, `[ allow ]` (as the web page's .btn): the primary one filled with ink and turning to
/// the signal colour while pressed; the others a 1 px frame; a destructive one says so in red. `expand` fills the width.
struct SquareButtonStyle: ButtonStyle {
    var prominent = false
    var destructive = false
    var expand = true
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
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

/// A square icon-sized button (send, +): ink when it can act, a 1 px frame when not; the signal colour while pressed.
struct SquareIconButtonStyle: ButtonStyle {
    var active = true
    var side: CGFloat = 38

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && active
        configuration.label
            .foregroundStyle(active ? (pressed ? Color.black : Theme.base) : Theme.inkDim)
            .frame(width: side, height: side)
            .background(active ? (pressed ? Theme.signal : Theme.fill) : Color.clear)
            .overlay(Rectangle().strokeBorder(active ? Color.clear : Theme.line, lineWidth: 1))
    }
}

