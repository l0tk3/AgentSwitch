import Foundation

/// 设置 › 用量 (docs/ui-v0.md §4.2): `GET /quota` as one row per executor. Claude Code and Codex always show the same two
/// windows, 5h and 7d, from `detail.windows`; OpenCode shows its DeepSeek balance from `detail.balances`. A window
/// without a reading, or one whose reset time has passed, has no percent (the row draws an empty bar and "—").
public enum Usage {
    /// The executors in the order the rows are shown; readings for anything else are left out.
    public static let harnesses = ["claude-code", "codex", "opencode"]
    /// The two windows of every Claude Code and Codex row, in this order; others (Claude's "7d opus") are not shown.
    public static let windowLabels = ["5h", "7d"]
    /// From this much used the bar turns red.
    public static let alertPercent = 90
    static let missing = "—"

    public struct Slot: Sendable, Hashable, Identifiable {
        public let label: String
        /// Used, 0...100; nil without a reading, or once the window has reset.
        public let percent: Int?
        /// When the window resets; nil when unknown or already past.
        public let resetsAt: Date?

        public var id: String { label }
        public var percentText: String { percent.map { "\($0)%" } ?? Usage.missing }
        public var isHigh: Bool { (percent ?? 0) >= Usage.alertPercent }
        /// "5 小时" / "7 天", for VoiceOver.
        public var spokenLabel: String {
            guard let unit = label.last, let n = Int(label.dropLast()) else { return label }
            switch unit {
            case "h": return "\(n) 小时"
            case "d": return "\(n) 天"
            case "m": return "\(n) 分钟"
            default: return label
            }
        }
    }

    public struct Row: Sendable, Hashable, Identifiable {
        public let harness: String
        /// "Claude Code", "Codex · Pro", "OpenCode".
        public let title: String
        /// Claude Code and Codex: 5h and 7d. OpenCode: none (a balance instead).
        public let slots: [Slot]
        /// OpenCode: "¥96.23"; nil for the others, or when the balance is unknown.
        public let balance: String?

        public var id: String { harness }
        public var showsBalance: Bool { slots.isEmpty }
        public var balanceText: String { "余额 " + (balance ?? Usage.missing) }
    }

    public static func rows(_ readings: [QuotaReading], now: Date = Date()) -> [Row] {
        harnesses.compactMap { harness in
            readings.first { $0.harness == harness }.map { row($0, now: now) }
        }
    }

    /// When the numbers shown were read: the oldest of the rows' readings.
    public static func readAt(_ readings: [QuotaReading]) -> Date? {
        readings.filter { harnesses.contains($0.harness) }.map(\.fetched).min()
    }

    static func row(_ reading: QuotaReading, now: Date) -> Row {
        let name = ModelName.harness(reading.harness)
        if reading.harness == "opencode" {
            return Row(harness: reading.harness, title: name, slots: [], balance: balance(reading.detail))
        }
        let plan = reading.harness == "codex" ? reading.detail?["planType"]?.string.flatMap(planName) : nil
        return Row(harness: reading.harness, title: plan.map { "\(name) · \($0)" } ?? name,
                   slots: windowLabels.map { slot($0, in: reading.detail, now: now) }, balance: nil)
    }

    static func slot(_ label: String, in detail: JSONValue?, now: Date) -> Slot {
        let window = detail?["windows"]?.array?.first { $0["label"]?.string == label }
        let resetsAt = window?["resetsAt"]?.number.map { Date(timeIntervalSince1970: $0) }
        if let resetsAt, resetsAt <= now { return Slot(label: label, percent: nil, resetsAt: nil) }
        let percent = window?["usedPercent"]?.number.map { Int(min(max($0, 0), 100).rounded()) }
        return Slot(label: label, percent: percent, resetsAt: percent == nil ? nil : resetsAt)
    }

    /// "pro" → "Pro".
    static func planName(_ plan: String) -> String? {
        let trimmed = plan.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first else { return nil }
        return first.uppercased() + trimmed.dropFirst()
    }

    /// Every balance, "¥96.23 · $5.00"; nil when there is none.
    static func balance(_ detail: JSONValue?) -> String? {
        let amounts = (detail?["balances"]?.array ?? []).compactMap { item -> String? in
            guard let total = item["total"]?.string ?? item["total"]?.number.map({ String($0) }) else { return nil }
            return money(total, currency: item["currency"]?.string ?? "")
        }
        return amounts.isEmpty ? nil : amounts.joined(separator: " · ")
    }

    static func money(_ amount: String, currency: String) -> String {
        let value = Double(amount).map { String(format: "%.2f", $0) } ?? amount
        switch currency.uppercased() {
        case "CNY", "RMB": return "¥" + value
        case "USD": return "$" + value
        case "": return value
        default: return "\(value) \(currency)"
        }
    }
}
