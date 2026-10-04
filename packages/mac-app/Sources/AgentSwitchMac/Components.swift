import AgentSwitchMacCore
import AppKit
import SwiftUI

// MARK: - colours (docs/ui-v0.md §7.3)

// Every colour is one of the pixel look's (§7.3) and, in the classic look (§8, docs/design/concepts/classic.html), the
// system's: its greys, its status colours, and the accent where the pixel look has its signal (the user: 蓝色 — the
// system's accent, blue unless it was changed in System Settings).

extension Color {
    /// The one signal color: selection, the brand mark, the primary action (and the system controls' tint). The
    /// system's accent in the classic look.
    static let signal = Color(nsColor: NSColor(name: "AgentSwitchSignal") { appearance in
        InterfaceLook.current.isClassic ? .controlAccentColor : .rgb(appearance.isDark ? 0xFF2E88 : 0xE0106E)
    })
    /// The tint of the app's controls: the signal.
    static let brand = signal
    /// Status colors, only ever for status and never alone (always with a shape or a word). In the classic look work
    /// under way is the accent's colour, as the system's own progress is.
    static let busy = Color(nsColor: NSColor(name: "AgentSwitchBusy") { appearance in
        InterfaceLook.current.isClassic ? .controlAccentColor : .rgb(appearance.isDark ? 0x2EE6FF : 0x0086A8)
    })
    static let waiting = Color(nsColor: .dynamic(light: 0xC27400, dark: 0xFFB000, classicLight: 0xFF9500, classicDark: 0xFF9F0A, name: "AgentSwitchWaiting"))
    static let ok = Color(nsColor: .dynamic(light: 0x3F8F00, dark: 0x9BE22D, classicLight: 0x34C759, classicDark: 0x30D158, name: "AgentSwitchOK"))
    static let failed = Color(nsColor: .dynamic(light: 0xD7261B, dark: 0xFF4A3D, classicLight: 0xFF3B30, classicDark: 0xFF453A, name: "AgentSwitchFailed"))
    /// Waiting on the user (the old name for it).
    static let attention = waiting
    /// Faint ink: dim lanes, hollow squares, the empty part of a meter, solid rules.
    static let inkDim = Color(nsColor: .dynamic(light: 0xA29D93, dark: 0x4D4B48, classicLight: 0xA6A6AB, classicDark: 0x6C6C72, name: "AgentSwitchInkDim"))
    /// A pixel mark's 1-pixel hard shadow.
    static let pixelShadow = Color(nsColor: .dynamic(light: 0xCFC9BC, dark: 0x2C2A28, name: "AgentSwitchPixelShadow"))
}

extension NSAppearance {
    var isDark: Bool { bestMatch(from: [.aqua, .darkAqua]) == .darkAqua }
}

extension NSColor {
    static func rgb(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    /// A colour by the appearance (light, dark) and by the look: the classic look's where it has its own, else the
    /// pixel look's. Asked at every draw, so a change of the look shows as soon as the views are drawn again.
    static func dynamic(light: UInt32, dark: UInt32, classicLight: UInt32? = nil, classicDark: UInt32? = nil, name: String) -> NSColor {
        NSColor(name: name) { appearance in
            let classic = InterfaceLook.current.isClassic
            return .rgb(appearance.isDark ? (classic ? classicDark ?? dark : dark) : (classic ? classicLight ?? light : light))
        }
    }
}

extension StatusLevel {
    var color: Color {
        switch self {
        case .ok: return .ok
        case .off: return .inkDim
        case .busy: return .busy
        case .warning: return .waiting
        case .error: return .failed
        }
    }
}

// MARK: - status

/// The status mark (a pixel square, the spinner while busy); the old name.
struct StatusDot: View {
    let level: StatusLevel

    var body: some View { StatusMark(level: level) }
}

/// `■ OK`: the mark and one word, the word monospaced in secondary text.
struct StatusBadge: View {
    let line: StatusLine

    var body: some View {
        HStack(spacing: 6) {
            StatusMark(level: line.level)
            Text(line.text).mono(12).foregroundStyle(.secondary)
        }
    }
}

/// A settings row: label on the left, the status (mark + text) on the right; the full text on hover.
struct StatusRow: View {
    let label: String
    let line: StatusLine

    var body: some View {
        LabeledContent(label) {
            HStack(spacing: 6) {
                StatusMark(level: line.level)
                Text(line.text).mono(12).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            }
            .help(line.text)
        }
    }
}

// MARK: - settings pages

/// A section footer: one short sentence, leading-aligned (a grouped Form puts footers on the trailing edge).
struct Footer: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A page that cannot show its content yet (daemon not running, nothing added): one line and what to do.
struct EmptyPage<Actions: View>: View {
    let title: String
    let symbol: String
    let message: String
    @ViewBuilder var actions: Actions

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(message)
        } actions: {
            actions
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension EmptyPage where Actions == EmptyView {
    init(title: String, symbol: String, message: String) {
        self.init(title: title, symbol: symbol, message: message) { EmptyView() }
    }
}

// MARK: - helpers

enum Clipboard {
    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

extension AppModel {
    /// A path with the home folder as `~`.
    func shortPath(_ path: String) -> String { DisplayPath.short(path, home: paths.userHome.path) }
    func shortPath(_ url: URL) -> String { shortPath(url.path) }
}

/// Opens a Privacy & Security pane of System Settings (the anchors are the documented x-apple.systempreferences ones).
@MainActor
func openPrivacyPane(_ anchor: String) {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
        NSWorkspace.shared.open(url)
    }
}

/// 选择…: one folder, new folders allowed (docs/control-v0.md §2). Nil when cancelled.
@MainActor
enum FolderPanel {
    static func choose(message: String, startingAt path: String?) -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.message = message
        if let path { panel.directoryURL = URL(fileURLWithPath: path, isDirectory: true) }
        return panel.runModal() == .OK ? panel.url : nil
    }
}

/// `ios` → `iOS`.
func platformName(_ platform: String) -> String {
    switch platform.lowercased() {
    case "ios", "iphone": return "iOS"
    case "ipados": return "iPadOS"
    case "android": return "Android"
    case "macos", "mac": return "macOS"
    default: return platform
    }
}
