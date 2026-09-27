import AgentSwitchMacCore
import AppKit
import SwiftUI

/// One harness of the usage block (docs/ui-v0.md §4.2): a monochrome tile, the name, and below it either the two
/// windows `5h ▬▬ 20%   7d ▬▬ 82%` or OpenCode's `余额 ¥96.23`. The menu panel uses the compact size, 模型 the regular.
struct UsageRowView: View {
    let row: UsageRow
    var compact = false

    private var tile: CGFloat { compact ? 24 : 30 }

    var body: some View {
        HStack(alignment: .center, spacing: compact ? 10 : 12) {
            Image(systemName: row.harness.usageSymbol)
                .font(.system(size: compact ? 11 : 13, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: tile, height: tile)
                .background(Color(nsColor: .quaternarySystemFill), in: RoundedRectangle(cornerRadius: compact ? 6 : 7))
            VStack(alignment: .leading, spacing: compact ? 3 : 5) {
                Text(row.title).font(compact ? .callout : .body).lineLimit(1)
                if row.showsBalance {
                    Text(row.balanceText)
                        .font(compact ? .caption : .callout)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                } else {
                    HStack(spacing: compact ? 12 : 20) {
                        ForEach(row.slots, id: \.label) { UsageSlotView(slot: $0, compact: compact) }
                    }
                }
            }
        }
        .padding(.vertical, compact ? 0 : 2)
    }
}

/// `5h ▬▬▬ 20%`: the label, a thin bar filling the space between, the value at a fixed width so rows line up.
private struct UsageSlotView: View {
    let slot: UsageSlot
    let compact: Bool

    var body: some View {
        HStack(spacing: 6) {
            Text(slot.label)
                .foregroundStyle(.secondary)
                .frame(width: compact ? 15 : 18, alignment: .leading)
            UsageBar(fraction: slot.fraction, high: slot.isHigh, height: compact ? 4 : 5)
            Text(slot.valueText)
                .foregroundStyle(.secondary)
                .frame(width: compact ? 30 : 36, alignment: .trailing)
        }
        .font((compact ? Font.caption : .callout).monospacedDigit())
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .help(slot.note)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(slot.label) \(slot.valueText)")
    }
}

/// A capsule track in the tertiary fill; the used part in system green, red from Usage.highPercent on.
private struct UsageBar: View {
    let fraction: Double
    let high: Bool
    let height: CGFloat

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color(nsColor: .tertiarySystemFill))
                if fraction > 0 {
                    Capsule()
                        .fill(high ? Color.red : Color.green)
                        .frame(width: max(height, geometry.size.width * min(1, fraction)))
                }
            }
        }
        .frame(height: height)
    }
}

extension Harness {
    /// Generic SF Symbols (no product logos, docs/ui-v0.md §3); they follow the text colour.
    var usageSymbol: String {
        switch self {
        case .claude: return "terminal"
        case .codex: return "curlybraces"
        case .opencode: return "chevron.left.forwardslash.chevron.right"
        }
    }
}
