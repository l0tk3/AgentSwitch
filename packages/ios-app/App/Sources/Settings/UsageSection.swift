import AgentSwitchKit
import SwiftUI

/// 设置 › 用量 (docs/ui-v0.md §4.2), right under the Mac: one row per executor — a monochrome symbol in a small tile,
/// the name, then the 5h and 7d windows as thin bars (OpenCode: its balance). Hidden until the Mac has answered once;
/// a failed re-read keeps the last numbers, and the footer says when they were read.
struct UsageSection: View {
    let readings: [QuotaReading]

    var body: some View {
        let rows = Usage.rows(readings)
        if !rows.isEmpty {
            Section {
                ForEach(rows) { UsageRowView(row: $0) }
            } header: {
                Text("用量")
            } footer: {
                if let at = Usage.readAt(readings) { Text("读数更新于 \(Self.time(at))") }
            }
        }
    }

    /// "12:04" today, else "9月26日 12:04".
    static func time(_ date: Date) -> String {
        let clock = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        guard !Calendar.current.isDateInToday(date) else { return clock }
        return date.formatted(.dateTime.month(.defaultDigits).day()) + " " + clock
    }
}

private struct UsageRowView: View {
    let row: Usage.Row
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            HarnessTile(harness: row.harness)
            VStack(alignment: .leading, spacing: 6) {
                Text(row.title).font(.subheadline.weight(.medium))
                if row.showsBalance {
                    Text(row.balanceText).font(.footnote).monospacedDigit().foregroundStyle(.secondary)
                } else {
                    // Side by side as in the reference; one above the other at the accessibility sizes.
                    let layout = typeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                        : AnyLayout(HStackLayout(spacing: Theme.Space.l))
                    layout { ForEach(row.slots) { UsageSlotView(slot: $0) } }
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// `5h ▬▬▬▬ 20%`: the label and the percent keep fixed widths (the widest they can be), so the bars of every row
/// start and end in the same place.
private struct UsageSlotView: View {
    let slot: Usage.Slot

    var body: some View {
        HStack(spacing: 6) {
            Fixed(widest: "7d", alignment: .leading) { Text(slot.label).foregroundStyle(.secondary) }
            UsageBar(percent: slot.percent)
            Fixed(widest: "100%", alignment: .trailing) {
                Text(slot.percentText).foregroundStyle(slot.percent == nil ? .tertiary : .primary)
            }
        }
        .font(.caption.monospacedDigit())
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    private var spoken: String {
        guard let percent = slot.percent else { return "\(slot.spokenLabel)，无读数" }
        let reset = slot.resetsAt.map { "，\($0.formatted(date: .abbreviated, time: .shortened)) 重置" } ?? ""
        return "\(slot.spokenLabel)，已用 \(percent)%\(reset)"
    }
}

/// The thin capsule: a tertiary-fill track, green up to 90 % used, red from there; empty without a reading.
private struct UsageBar: View {
    let percent: Int?
    @ScaledMetric(relativeTo: .caption) private var height: CGFloat = 4

    var body: some View {
        Capsule()
            .fill(Color(.tertiarySystemFill))
            .overlay(alignment: .leading) {
                GeometryReader { box in
                    if let percent, percent > 0 {
                        Capsule()
                            .fill(percent >= Usage.alertPercent ? Theme.failed : Theme.done)
                            .frame(width: max(box.size.height, box.size.width * CGFloat(percent) / 100))
                    }
                }
            }
            .frame(height: height)
            .frame(minWidth: 24)
    }
}

/// The executor's symbol, single colour like the text, in a small rounded tile (no brand marks).
private struct HarnessTile: View {
    let harness: String
    @ScaledMetric(relativeTo: .subheadline) private var side: CGFloat = 30

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: side * 0.47, weight: .medium))
            .foregroundStyle(.primary)
            .frame(width: side, height: side)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: side * 0.26, style: .continuous))
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch harness {
        case "claude-code": return "terminal"
        case "codex": return "curlybraces"
        case "opencode": return "chevron.left.forwardslash.chevron.right"
        default: return "cpu"
        }
    }
}

/// Content in the width of `widest` (in the same font), so columns line up whatever the value.
private struct Fixed<Content: View>: View {
    let widest: String
    let alignment: Alignment
    @ViewBuilder let content: Content

    var body: some View {
        Text(widest).hidden().overlay(alignment: alignment) { content }
    }
}
