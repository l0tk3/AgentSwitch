import AgentSwitchMacCore
import AppKit
import SwiftUI

extension StatusLevel {
    var color: Color {
        switch self {
        case .ok: return .green
        case .off: return .secondary
        case .busy: return .blue
        case .warning: return .orange
        case .error: return .red
        }
    }
}

struct StatusDot: View {
    let level: StatusLevel

    var body: some View {
        Circle().fill(level.color).frame(width: 8, height: 8)
    }
}

/// `label  ● text` with the text selectable.
struct StatusRow: View {
    let label: String
    let line: StatusLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).foregroundStyle(.secondary).frame(width: 78, alignment: .leading)
            StatusDot(level: line.level).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            Text(line.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .font(.callout)
    }
}

enum Clipboard {
    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

enum Formatters {
    static func dateTime(_ date: Date?) -> String {
        guard let date else { return "—" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    static func relative(_ date: Date?) -> String {
        guard let date else { return "从未" }
        return date.formatted(.relative(presentation: .named))
    }
}
