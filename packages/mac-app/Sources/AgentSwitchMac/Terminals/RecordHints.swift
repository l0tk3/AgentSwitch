import AgentSwitchMacCore
import SwiftUI

// What the reply box offers for what is being typed (docs/simple-view-v0.md §5.5): the agent's slash commands after a
// `/`, the folder's files after an `@`, a line on what another first character does. ↑ ↓ move, tab or return takes
// the one picked, esc puts the list away.

/// One thing offered: what a row says, and what taking it types in place of what was typed.
struct ReplyHintRow: Identifiable, Equatable {
    enum Kind: Equatable { case command, file }

    let kind: Kind
    let title: String
    let detail: String
    /// Yours (a command file or skill in your home or the project), said beside it.
    var tag: String?
    /// What is replaced (UTF-16, as the text view counts) and by what.
    let range: NSRange
    let typed: String

    var id: String { "\(kind)/\(title)/\(detail)" }
}

struct ReplyHintList: View {
    let record: PaneRecord
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let mark = record.hintMark {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(mark.sign).mono(Look.size(12, look), weight: .semibold).foregroundStyle(Color.signal)
                    Text(mark.word).mono(Look.size(11.5, look), weight: .semibold).foregroundStyle(Look.ink)
                    Text(mark.says).font(.system(size: Look.size(12, look))).foregroundStyle(Look.ink2).lineLimit(2)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12).padding(.vertical, 7)
            }
            ForEach(Array(record.hints.enumerated()), id: \.element.id) { index, row in
                let picked = index == record.hintPick
                Button { record.take(row) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        switch row.kind {
                        case .command:
                            Text("/\(row.title)").mono(Look.size(12, look), weight: .medium).foregroundStyle(Look.ink).lineLimit(1).layoutPriority(1)
                            Text(row.detail).font(.system(size: Look.size(12, look))).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.tail)
                        case .file:
                            if look.isClassic { Image(systemName: "doc").font(.system(size: 11)).foregroundStyle(Look.ink2).frame(width: 14) }
                            Text(row.title).mono(Look.size(12, look), weight: .medium).foregroundStyle(Look.ink).lineLimit(1).layoutPriority(1)
                            Text(row.detail).mono(Look.size(11, look)).foregroundStyle(Look.faint).lineLimit(1).truncationMode(.head)
                        }
                        Spacer(minLength: 6)
                        if let tag = row.tag { Text(tag).mono(Look.size(10.5, look)).foregroundStyle(Look.faint) }
                        if picked { Text("tab").mono(Look.size(10.5, look)).foregroundStyle(Look.faint) }
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(picked ? Look.said : .clear, in: RoundedRectangle(cornerRadius: look.isClassic ? 7 : 0, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 4)
        }
        .padding(.vertical, record.hints.isEmpty ? 0 : 4)
    }
}
