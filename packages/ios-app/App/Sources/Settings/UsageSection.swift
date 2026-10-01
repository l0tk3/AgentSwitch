import AgentSwitchKit
import SwiftUI

/// Settings › Usage (docs/ui-v0.md §4.2, §7.3), right under the Mac: one row per executor — its 5 × 5 pixel mark, the
/// name, then the 5h and 7d windows as character meters (OpenCode: its balance). Hidden until the Mac has answered once;
/// a failed re-read keeps the last numbers, and the footer says when they were read.
struct UsageSection: View {
    let readings: [QuotaReading]

    var body: some View {
        let rows = Usage.rows(readings)
        if !rows.isEmpty {
            Section {
                ForEach(rows) { UsageRowView(row: $0) }
            } header: {
                SectionLabel("Usage")
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
                    Text(row.balanceText).mono(12).foregroundStyle(.secondary)
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

/// `5h ██░░░░░░ 20%`: the label and the percent keep fixed widths (the widest they can be), so the meters of every row
/// start and end in the same place.
private struct UsageSlotView: View {
    let slot: Usage.Slot

    var body: some View {
        HStack(spacing: 6) {
            Fixed(widest: "7d", alignment: .leading) { Text(slot.label).foregroundStyle(.secondary) }
            CharMeter(fraction: Double(slot.percent ?? 0) / 100, high: (slot.percent ?? 0) >= Usage.alertPercent, cells: 8)
            Fixed(widest: "100%", alignment: .trailing) {
                Text(slot.percentText).foregroundStyle(slot.percent == nil ? .tertiary : .primary)
            }
        }
        .mono(11)
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

/// The executor's 5 × 5 pixel mark (§7.3: Claude Code's spark, Codex's >_, OpenCode's brackets), flat, in the text
/// colour; a plain square for anything else.
private struct HarnessTile: View {
    let harness: String

    var body: some View {
        PixelSprite(rows: PixelArt.agents[harness] ?? PixelArt.square, pixel: 3, color: Theme.ink)
            .frame(width: 24, height: 24)
            .accessibilityHidden(true)
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
