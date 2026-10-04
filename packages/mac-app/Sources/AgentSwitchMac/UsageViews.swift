import AgentSwitchMacCore
import AppKit
import SwiftUI

/// One harness of the usage block (docs/ui-v0.md §4.2, §7): the agent's pixel mark, the name, and either the two
/// windows `5h ██░░░░░░ 20%   7d ████████░░ 82%` in characters or OpenCode's `balance ¥96.23`. The menu panel uses the
/// compact size, 模型 the regular.
struct UsageRowView: View {
    let row: UsageRow
    var compact = false

    var body: some View {
        HStack(alignment: .top, spacing: compact ? 10 : 12) {
            PixelSprite(rows: row.harness.pixelMark, pixel: 2, color: .secondary, strength: 0.8, shadow: false)
                .padding(.top, compact ? 3 : 4)
            VStack(alignment: .leading, spacing: compact ? 2 : 4) {
                Text(row.title).mono(compact ? 12 : 13).lineLimit(1)
                if row.showsBalance {
                    Text(row.balanceText).mono(compact ? 11 : 12).foregroundStyle(.secondary)
                } else {
                    HStack(spacing: compact ? 12 : 22) {
                        ForEach(row.slots, id: \.label) { UsageSlotView(slot: $0, compact: compact) }
                    }
                }
            }
        }
        .padding(.vertical, compact ? 0 : 2)
    }
}

/// `5h ██░░░░░░ 20%`: the label, a character meter, the value at a fixed width so rows line up.
private struct UsageSlotView: View {
    let slot: UsageSlot
    let compact: Bool

    var body: some View {
        HStack(spacing: 5) {
            Text(slot.label).foregroundStyle(.secondary)
            CharMeter(fraction: slot.fraction, high: slot.isHigh, cells: compact ? 8 : 12)
            Text(slot.valueText)
                .foregroundStyle(.secondary)
                .frame(width: compact ? 28 : 34, alignment: .trailing)
        }
        .mono(compact ? 10.5 : 11.5)
        .contentShape(Rectangle())
        .help(slot.note)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(slot.label) \(slot.valueText)")
    }
}

extension Harness {
    /// The agent's 5 × 5 pixel mark (docs/ui-v0.md §7.3), the same as the terminal window's.
    var pixelMark: [String] {
        switch self {
        case .claude: return PixelArt.agents["claude-code"]!
        case .codex: return PixelArt.agents["codex"]!
        case .opencode: return PixelArt.agents["opencode"]!
        }
    }
}
