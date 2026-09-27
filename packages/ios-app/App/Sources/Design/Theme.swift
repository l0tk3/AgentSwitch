import AgentSwitchKit
import SwiftUI

/// The shared look (docs/ui-v0.md): one accent (AccentColor, #2F5BEA / #6D8BFF), status colours only for status,
/// greys for everything else; one spacing scale; hierarchy by type and space rather than boxes.
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

    enum Radius {
        static let card: CGFloat = 14
        static let bubble: CGFloat = 18
    }

    /// The accent as a filled surface under white (your bubbles, the send button): in dark mode deeper than the
    /// accent itself, which is light so text and icons read on black, and would leave white on it faint.
    static let fill = Color(light: 0x2F5BEA, dark: 0x3F66F0)
    /// Something waits for the user: the only other colour with weight.
    static let waiting = Color(light: 0xE8891C, dark: 0xF5A54A)
    static let done = Color.green
    static let failed = Color.red
    static let card = Color(.secondarySystemBackground)

    static func color(_ status: TaskStatus) -> Color {
        switch status {
        case .done: return done
        case .failed: return failed
        case .waitingApproval: return waiting
        case .partial, .blocked: return waiting
        case .cancelled, .other: return .secondary
        case .queued: return .secondary
        case .routing, .running: return .accentColor
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

/// A status: a small dot and its word, in the status colour. `waiting` overrides (a pending question on a running task).
struct StatusLabel: View {
    let task: AgentTask
    var waiting = false

    var body: some View {
        let color = waiting ? Theme.waiting : Theme.color(task.status)
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(waiting ? "等你处理" : task.statusLabel).foregroundStyle(color)
        }
        .font(.footnote.weight(.medium))
    }
}

/// One level of container: the grey card.
struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
    }
}

extension View {
    func card() -> some View { modifier(CardStyle()) }
}
