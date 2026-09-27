import Foundation

/// A rate-limit window of a subscription (`detail.windows` of `GET /quota`): `5h`, `7d`, `7d opus` ….
public struct QuotaWindow: Equatable, Sendable {
    public let label: String
    public let usedPercent: Double
    public let resetsAt: Date?

    public init(label: String, usedPercent: Double, resetsAt: Date?) {
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
    }
}

/// A prepaid balance (`detail.balances`, DeepSeek for OpenCode). `total` stays as the provider wrote it.
public struct QuotaBalance: Equatable, Sendable {
    public let currency: String
    public let total: String

    public init(currency: String, total: String) {
        self.currency = currency
        self.total = total
    }
}

/// One reading of `GET /quota` (the daemon's quota/types.ts QuotaReading), the parts the Mac shows.
public struct QuotaReading: Decodable, Equatable, Sendable {
    /// The daemon's harness name: `claude-code`, `codex`, `opencode`.
    public let harness: String
    public let fetchedAt: Date?
    public let windows: [QuotaWindow]
    /// Codex's plan (`pro`, `plus` …).
    public let planType: String?
    public let balances: [QuotaBalance]
    /// Why the last read failed; the daemon keeps the previous values next to it.
    public let error: String?

    public init(harness: String, fetchedAt: Date?, windows: [QuotaWindow] = [], planType: String? = nil,
                balances: [QuotaBalance] = [], error: String? = nil) {
        self.harness = harness
        self.fetchedAt = fetchedAt
        self.windows = windows
        self.planType = planType
        self.balances = balances
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        harness = try c.require(String.self, "harness")
        fetchedAt = c.date("fetchedAt", "fetched_at")
        error = c.first(String.self, "error")
        let detail = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("detail"))
        windows = detail?.first([LenientWindow].self, "windows")?.compactMap(\.value) ?? []
        planType = detail?.first(String.self, "planType", "plan_type")
        balances = detail?.first([LenientBalance].self, "balances")?.compactMap(\.value) ?? []
    }

    /// `[...]` as the daemon sends it; an entry it cannot read is skipped, never the whole list.
    public static func decodeList(_ data: Data) throws -> [QuotaReading] {
        try JSONDecoder().decode([LenientReading].self, from: data).compactMap(\.value)
    }
}

private struct LenientReading: Decodable {
    let value: QuotaReading?
    init(from decoder: Decoder) throws { value = try? QuotaReading(from: decoder) }
}

private struct LenientWindow: Decodable {
    let value: QuotaWindow?

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: AnyKey.self),
              let label = c.first(String.self, "label"),
              let used = c.first(Double.self, "usedPercent", "used_percent") else {
            value = nil
            return
        }
        value = QuotaWindow(label: label, usedPercent: used, resetsAt: c.date("resetsAt", "resets_at"))
    }
}

private struct LenientBalance: Decodable {
    let value: QuotaBalance?

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: AnyKey.self),
              let total = c.first(String.self, "total", "total_balance") ?? c.first(Double.self, "total", "total_balance").map({ String($0) }) else {
            value = nil
            return
        }
        value = QuotaBalance(currency: c.first(String.self, "currency") ?? "", total: total)
    }
}

/// One slot of a usage row: `5h ▬▬ 20%`.
public struct UsageSlot: Equatable, Sendable {
    public let label: String
    /// Nil when there is no reading, or the window has reset since it was read.
    public let percent: Int?
    public let resetsAt: Date?
    /// The hover text: `12:30 重置`, `已重置`, `无读数`; empty when a reading has no reset time.
    public let note: String

    public init(label: String, percent: Int?, resetsAt: Date?, note: String) {
        self.label = label
        self.percent = percent
        self.resetsAt = resetsAt
        self.note = note
    }

    /// The bar's length, 0…1.
    public var fraction: Double { Double(percent ?? 0) / 100 }
    /// Drawn in red from `Usage.highPercent` on.
    public var isHigh: Bool { (percent ?? 0) >= Usage.highPercent }
    /// `20%`, or `—` without a reading.
    public var valueText: String { percent.map { "\($0)%" } ?? Usage.none }
}

/// One harness in the usage block (docs/ui-v0.md §4.2).
public struct UsageRow: Equatable, Sendable, Identifiable {
    public let harness: Harness
    /// `Claude Code`, `Codex · Pro`, `OpenCode`.
    public let title: String
    /// Claude Code and Codex: 5h and 7d, always both. OpenCode: none.
    public let slots: [UsageSlot]
    /// OpenCode: `¥96.23`; nil when unknown.
    public let balance: String?

    public var id: String { harness.rawValue }
    /// OpenCode is prepaid: a balance instead of windows.
    public var showsBalance: Bool { harness == .opencode }
    /// `余额 ¥96.23`, or `余额 —`.
    public var balanceText: String { "余额 " + (balance ?? Usage.none) }

    public init(harness: Harness, title: String, slots: [UsageSlot], balance: String?) {
        self.harness = harness
        self.title = title
        self.slots = slots
        self.balance = balance
    }
}

/// `GET /quota` readings → the rows the menu panel and 模型 show, in the fixed harness order.
public enum Usage {
    /// The two windows each subscription row shows; others (`7d opus`, `7d sonnet`) stay out of the compact row.
    public static let slotLabels = ["5h", "7d"]
    public static let highPercent = 90
    public static let none = "—"

    /// No rows without readings (daemon not running, an older one without the route).
    public static func rows(_ readings: [QuotaReading], now: Date = Date(), calendar: Calendar = .current) -> [UsageRow] {
        guard !readings.isEmpty else { return [] }
        return Harness.allCases.map { harness in
            let reading = readings.first { Usage.harness(named: $0.harness) == harness }
            switch harness {
            case .opencode:
                return UsageRow(harness: harness, title: harness.title, slots: [], balance: reading.flatMap { balance($0.balances) })
            case .claude, .codex:
                let windows = reading?.windows ?? []
                let plan = harness == .codex ? reading?.planType : nil
                return UsageRow(harness: harness, title: title(harness, plan: plan),
                                slots: slotLabels.map { slot($0, windows: windows, now: now, calendar: calendar) }, balance: nil)
            }
        }
    }

    /// The daemon's harness names (`claude-code`, `codex`, `opencode`).
    public static func harness(named name: String) -> Harness? {
        switch name.lowercased() {
        case "claude-code", "claude": return .claude
        case "codex": return .codex
        case "opencode": return .opencode
        default: return nil
        }
    }

    /// A window by its label; one whose reset time has passed has reset and shows no reading.
    public static func slot(_ label: String, windows: [QuotaWindow], now: Date, calendar: Calendar = .current) -> UsageSlot {
        guard let window = windows.first(where: { $0.label.trimmingCharacters(in: .whitespaces).lowercased() == label }) else {
            return UsageSlot(label: label, percent: nil, resetsAt: nil, note: "无读数")
        }
        if let reset = window.resetsAt, reset <= now {
            return UsageSlot(label: label, percent: nil, resetsAt: nil, note: "已重置")
        }
        let percent = min(100, max(0, Int(window.usedPercent.rounded())))
        let note = window.resetsAt.map { resetText($0, now: now, calendar: calendar) } ?? ""
        return UsageSlot(label: label, percent: percent, resetsAt: window.resetsAt, note: note)
    }

    /// `Codex · Pro`; the harness name alone without a plan.
    public static func title(_ harness: Harness, plan: String?) -> String {
        guard let plan = plan?.trimmingCharacters(in: .whitespaces), !plan.isEmpty else { return harness.title }
        return "\(harness.title) · \(planName(plan))"
    }

    /// `pro` → `Pro`, `team_plus` → `Team Plus`.
    public static func planName(_ raw: String) -> String {
        raw.split(whereSeparator: { $0 == "_" || $0 == "-" || $0 == " " })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// `¥96.23`; several currencies joined with ` · `; nil when there is none.
    public static func balance(_ balances: [QuotaBalance]) -> String? {
        let parts = balances.compactMap(money)
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// CNY → `¥96.23`, USD → `$12.00`, anything else → `12.00 EUR`.
    public static func money(_ balance: QuotaBalance) -> String? {
        let raw = balance.total.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty else { return nil }
        let amount = Double(raw).map { String(format: "%.2f", $0) } ?? raw
        switch balance.currency.uppercased() {
        case "CNY", "RMB": return "¥" + amount
        case "USD": return "$" + amount
        case "": return amount
        default: return "\(amount) \(balance.currency.uppercased())"
        }
    }

    /// When the newest reading was taken, for 读数更新于.
    public static func readAt(_ readings: [QuotaReading]) -> Date? {
        readings.compactMap(\.fetchedAt).max()
    }

    /// `12:30 重置`, `明天 09:00 重置`, `9月30日 12:30 重置`.
    public static func resetText(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        TimeText.at(date, now: now, calendar: calendar) + " 重置"
    }
}
