import AgentSwitchMacCore
import AppKit
import SwiftUI

// MARK: - colours (docs/ui-v0.md §2)

extension Color {
    /// The one accent: buttons, selection, things in progress.
    static let brand = Color(nsColor: .dynamic(light: 0x2F5BEA, dark: 0x6D8BFF, name: "AgentSwitchBrand"))
    /// The accent as a fill under white text (docs/ui-v0.md §2: darker than the accent in dark mode).
    static let brandFill = Color(nsColor: .dynamic(light: 0x2F5BEA, dark: 0x3F66F0, name: "AgentSwitchBrandFill"))
    /// 等你处理: only for things the user has to act on.
    static let attention = Color(nsColor: .dynamic(light: 0xE8891C, dark: 0xF5A54A, name: "AgentSwitchAttention"))
}

extension NSColor {
    static func dynamic(light: UInt32, dark: UInt32, name: String) -> NSColor {
        NSColor(name: name) { appearance in
            let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
    }
}

extension StatusLevel {
    var color: Color {
        switch self {
        case .ok: return .green
        case .off: return Color(nsColor: .tertiaryLabelColor)
        case .busy: return .brand
        case .warning: return .attention
        case .error: return .red
        }
    }
}

// MARK: - status

struct StatusDot: View {
    let level: StatusLevel

    var body: some View {
        Circle().fill(level.color).frame(width: 8, height: 8)
    }
}

/// `● 运行中`: the dot and one word, the word in secondary text.
struct StatusBadge: View {
    let line: StatusLine

    var body: some View {
        HStack(spacing: 6) {
            StatusDot(level: line.level)
            Text(line.text).foregroundStyle(.secondary)
        }
    }
}

/// A settings row: label on the left, the status (dot + text) on the right; the full text on hover.
struct StatusRow: View {
    let label: String
    let line: StatusLine

    var body: some View {
        LabeledContent(label) {
            HStack(spacing: 6) {
                StatusDot(level: line.level)
                Text(line.text).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
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
        panel.prompt = "选择"
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
