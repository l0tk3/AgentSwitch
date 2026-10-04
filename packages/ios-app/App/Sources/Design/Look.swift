import AgentSwitchKit
import SwiftUI

// The interface's look on the phone (docs/ui-v0.md §8, 2026-10-04): `pixel`, the visual language of §7, or `classic`, a
// standard app's. The look is handed down the environment from the root; the shared parts (PixelViews, Theme, PixelBox,
// Effects) each draw by it, so the pages are written once. The colours ask where the look is kept at every draw, and the
// root rebuilds what is under it when the setting changes, so nothing keeps the other look's colours.

extension EnvironmentValues {
    /// The look the views under this draw in.
    @Entry var interfaceLook = InterfaceLook.pixel
}

/// The root of a screen: the look kept in the settings handed down, the system's blue as the tint in the classic look
/// (the user: 蓝色), and everything under it built again when the look changes. The Home Screen icon is the look's too
/// (HomeIcon): set when the app comes to the front and when the look changes.
private struct FollowsLook: ViewModifier {
    @AppStorage(InterfaceLook.key) private var raw = InterfaceLook.pixel.rawValue
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        let look = InterfaceLook.load(raw)
        content
            .environment(\.interfaceLook, look)
            .tint(look.isClassic ? Theme.signal : nil)
            .id(look)
            .onChange(of: scenePhase, initial: true) { _, phase in
                if phase == .active { HomeIcon.follow(look) }
            }
            .onChange(of: look) { _, look in HomeIcon.follow(look) }
    }
}

extension View {
    /// Drawn in the look kept in the settings, and again when it changes. Put where a screen starts: the app's root,
    /// and a sheet's content (what presents the sheet stays, so the sheet stays open across a change).
    func followsLook() -> some View { modifier(FollowsLook()) }
}

/// A short word as the look writes it (`Waiting` → `Needs You`; ClassicWords).
struct LookWord: View {
    let text: String
    @Environment(\.interfaceLook) private var look

    init(_ text: String) { self.text = text }

    var body: some View { Text(ClassicWords.word(text, in: look)) }
}

/// A button's word: `[ Allow ]`, or the word alone in the classic look.
struct ButtonWord: View {
    let word: String
    @Environment(\.interfaceLook) private var look

    init(_ word: String) { self.word = word }

    var body: some View { Text(ClassicWords.button(word, in: look)) }
}

/// A pixel glyph (`×`, `›`, `▾`) or the system symbol that stands for it in the classic look.
struct LookGlyph: View {
    let glyph: String
    let symbol: String
    var size: CGFloat = 13
    /// The symbol's weight and its size beside the glyph's: a chevron or a cross is small and firm, a bar's button plain.
    var weight: Font.Weight = .semibold
    var scale: CGFloat = 0.85
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            Image(systemName: symbol).font(.system(size: size * scale, weight: weight))
        } else {
            Text(glyph).font(.system(size: size, design: .monospaced))
        }
    }

    /// `⋯` in a navigation bar: the system's more button in the classic look.
    static var more: LookGlyph { LookGlyph(glyph: "⋯", symbol: "ellipsis.circle", size: 17, weight: .regular, scale: 1.05) }
    /// A row that leads on.
    static func onward(_ size: CGFloat = 13) -> LookGlyph { LookGlyph(glyph: "›", symbol: "chevron.right", size: size) }
    /// A part that folds: open or closed.
    static func fold(open: Bool, size: CGFloat = 12) -> LookGlyph {
        LookGlyph(glyph: open ? "▾" : "▸", symbol: open ? "chevron.down" : "chevron.right", size: size)
    }
}

/// Short words (states, labels, values): monospaced in the pixel look (§7.2.7), the system font in the classic one.
private struct ShortWordFont: ViewModifier {
    let size: CGFloat
    let weight: Font.Weight
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: look.isClassic ? .default : .monospaced))
    }
}

/// A 1 pt frame: square in the pixel look, round in the classic one.
private struct Framed: ViewModifier {
    let color: Color
    let radius: CGFloat
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        if look.isClassic {
            content.overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(color, lineWidth: 1))
        } else {
            content.overlay(Rectangle().strokeBorder(color, lineWidth: 1))
        }
    }
}

/// A ground: square in the pixel look, round in the classic one.
private struct Grounded: ViewModifier {
    let color: Color
    let radius: CGFloat
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        if look.isClassic {
            content.background(color, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        } else {
            content.background(color)
        }
    }
}

extension View {
    /// Short words: monospaced, or the system font in the classic look. What is code (a command, a path) keeps
    /// `code()`.
    func mono(_ size: CGFloat = 12, weight: Font.Weight = .regular) -> some View {
        modifier(ShortWordFont(size: size, weight: weight))
    }

    /// Code, commands and paths: monospaced in both looks.
    func code(_ size: CGFloat = 12, weight: Font.Weight = .regular) -> some View {
        font(.system(size: size, weight: weight, design: .monospaced))
    }

    /// A 1 pt frame, round by `radius` in the classic look.
    func framed(_ color: Color, radius: CGFloat = 10) -> some View { modifier(Framed(color: color, radius: radius)) }

    /// A ground, round by `radius` in the classic look.
    func grounded(_ color: Color, radius: CGFloat = 10) -> some View { modifier(Grounded(color: color, radius: radius)) }
}
