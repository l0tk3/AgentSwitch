import AgentSwitchMacCore
import AppKit
import SwiftUI

// The Dispatch page's look (docs/ui-v0.md §7, demo `mac-window.html`): the inks of §7.3, square 1 px frames, `[ Word ]`
// buttons that invert under the pointer (the primary one turns signal), floating boxes with a dithered hard shadow, the
// progress blocks and the agents' sprites. Text people read stays in the system font.

/// The page's colours, dark / light (ui-v0 §7.3; the panel and raised greys from the demo).
enum Look {
    static let ground = Color(nsColor: .dispatchGround)
    static let ink = Color(nsColor: .dynamic(light: 0x151413, dark: 0xE9E6DF, name: "AgentSwitchDispatchInk"))
    static let ink2 = Color(nsColor: .dynamic(light: 0x5F5B54, dark: 0x8D8A84, name: "AgentSwitchDispatchInk2"))
    static let faint = Color.inkDim
    static let line = Color(nsColor: .barEdge)
    /// A card's ground.
    static let panel = Color(nsColor: .dynamic(light: 0xECE8DF, dark: 0x0B0B0B, name: "AgentSwitchDispatchPanel"))
    /// What you said: a raised box (the signal colour is not for text backgrounds).
    static let raised = Color(nsColor: .dynamic(light: 0xE4DFD4, dark: 0x151515, name: "AgentSwitchDispatchRaised"))
    static let hover = Color(nsColor: .dynamic(light: 0xE9E5DC, dark: 0x121212, name: "AgentSwitchDispatchHover"))

    /// The reading column (docs/dispatch-v0.md §2): at most 760 pt with its 24 pt sides.
    static let column: CGFloat = 760
    static let side: CGFloat = 24
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
            PixelSprite(rows: PixelArt.agents[harness] ?? PixelArt.agents["pi"]!, pixel: 2, color: Look.ink2)
                .help(HarnessName.display(harness))
        }
    }
}

/// Ended and not opened yet: a small signal square (never mistaken for the status mark).
struct UnreadSquare: View {
    var body: some View {
        Rectangle().fill(Color.signal).frame(width: 6, height: 6).accessibilityLabel("未读")
    }
}

/// `▮▮▮▯▯ 3/5`: the step a multi-step task is on.
struct ProgressBlocks: View {
    let progress: DispatchProgress

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 2) {
                ForEach(Array(progress.blocks.enumerated()), id: \.offset) { _, on in
                    Rectangle().fill(on ? Color.busy : Look.line).frame(width: 12, height: 8)
                }
            }
            Text(progress.text).mono(11.5).foregroundStyle(Look.ink2)
        }
        .accessibilityElement()
        .accessibilityLabel("Step \(progress.text)")
    }
}

// MARK: - buttons

/// `[ Allow ⌘↩ ]`: a short word in brackets, the key hint faint.
struct BracketLabel: View {
    let word: String
    var key: String?

    var body: some View {
        HStack(spacing: 0) {
            Text("[ \(word) ")
            if let key { Text(key).font(.system(size: 11, design: .monospaced)).foregroundStyle(Look.faint); Text(" ") }
            Text("]")
        }
    }
}

/// The page's text buttons (the demo's `.btn`): monospaced, inverted under the pointer; the primary one filled with ink
/// and signal under the pointer; a destructive one red under the pointer.
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

    var body: some View {
        let lit = enabled && (hovering || configuration.isPressed)
        configuration.label
            .font(.system(size: size, design: .monospaced))
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(foreground(lit))
            .padding(.horizontal, role == .primary ? 2 : 0)
            .background(background(lit))
            .opacity(enabled ? 1 : 0.4)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
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

    func body(content: Content) -> some View {
        content
            .overlay(Rectangle().strokeBorder(hovering ? Look.faint : color, lineWidth: 1))
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
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(title).lineLimit(1)
                Spacer(minLength: 8)
                Text(trailing).lineLimit(1).truncationMode(.middle)
            }
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(waiting ? Color.black : Look.ground)
            .padding(.horizontal, 10)
            .frame(height: 24)
            .background(waiting ? Color.waiting : Look.ink)
            content
        }
        .background(Look.ground)
        .overlay(Rectangle().strokeBorder(waiting ? Color.waiting : Look.ink, lineWidth: 1))
        .background(Checker().offset(x: 6, y: 6))
        .padding(.trailing, 7)
        .padding(.bottom, 7)
    }
}

// MARK: - small labels

/// `// Process`: a page part's label (the demo's `.lbl`).
struct PartLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text("// \(text)").font(.system(size: 11, design: .monospaced)).tracking(0.44).foregroundStyle(Look.faint)
    }
}
