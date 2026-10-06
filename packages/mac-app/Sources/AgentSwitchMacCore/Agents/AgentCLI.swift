import Foundation

extension Harness {
    /// The same program as 设置 › Agents knows it (pi is an agent there and not one of the three executors here).
    public var agent: AgentCLI {
        switch self {
        case .claude: return .claude
        case .codex: return .codex
        case .opencode: return .opencode
        }
    }
}

/// The agent CLIs AgentSwitch runs and looks after (docs/agents-v0.md): the three harnesses and pi. The raw value is
/// the daemon's name for it.
public enum AgentCLI: String, CaseIterable, Sendable, Identifiable, Codable {
    case claude = "claude-code"
    case codex, opencode, pi

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .opencode: return "OpenCode"
        case .pi: return "pi"
        }
    }

    /// The name on the command line: what the vendor's own install answers to.
    public var command: String {
        switch self {
        case .claude: return "claude"
        case .codex: return "codex"
        case .opencode: return "opencode"
        case .pi: return "pi"
        }
    }

    /// The beta's name on the command line (user, 2026-10-06: 另起名字放到命令行); pi publishes no beta.
    public var betaCommand: String? { self == .pi ? nil : "\(command)-beta" }

    /// The variable the daemon reads this agent's program from.
    public var environmentKey: String {
        switch self {
        case .claude: return "CLAUDE_BIN"
        case .codex: return "CODEX_BIN"
        case .opencode: return "OPENCODE_BIN"
        case .pi: return "PI_BIN"
        }
    }

    /// The oldest version AgentSwitch was checked against (agents-v0 §3): an older one is not refused, only said.
    public var verifiedFloor: AgentVersion {
        switch self {
        case .claude: return AgentVersion("2.1.280")
        case .codex: return AgentVersion("0.158.0")
        case .opencode: return AgentVersion("2.0.18")
        case .pi: return AgentVersion("0.87.0")
        }
    }

    /// Variables that keep a stored copy from updating itself — it would otherwise replace the vendor's own install
    /// in the background (agents-v0 §1). Set by the store's launcher, never for the vendor's own install.
    public var noSelfUpdate: [String: String] {
        switch self {
        case .claude: return ["DISABLE_AUTOUPDATER": "1"]
        case .opencode: return ["OPENCODE_DISABLE_AUTOUPDATE": "1"]
        case .codex, .pi: return [:]
        }
    }
}

/// A version as the four vendors write them: `2.1.291`, `0.162.0-alpha.16`, `0.161.0-alpha.13.1`, `0.0.0-beta-19507`.
/// Ordered as semver orders them — numbers by value, a release after its own pre-releases — with one allowance:
/// a pre-release part like `beta-19507` is read as its word and its number.
public struct AgentVersion: Sendable, Hashable, Comparable, CustomStringConvertible {
    public let text: String
    let core: [Int]
    let pre: [Part]

    enum Part: Hashable, Comparable {
        case number(Int)
        case word(String)

        static func < (a: Part, b: Part) -> Bool {
            switch (a, b) {
            case let (.number(x), .number(y)): return x < y
            case let (.word(x), .word(y)): return x < y
            case (.number, .word): return true      // semver: numeric identifiers sort before words
            case (.word, .number): return false
            }
        }
    }

    public init(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let bare = trimmed.hasPrefix("v") ? String(trimmed.dropFirst()) : trimmed
        self.text = bare
        let noBuild = bare.split(separator: "+", maxSplits: 1).first.map(String.init) ?? bare
        let halves = noBuild.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        core = (halves.first ?? "").split(separator: ".").map { Int($0) ?? 0 }
        pre = halves.count > 1 ? halves[1].split(whereSeparator: { $0 == "." || $0 == "-" }).map { Int($0).map(Part.number) ?? .word(String($0)) } : []
    }

    /// Text that is a version and nothing else (what goes into a path or an address): digits and dots, then an
    /// optional pre-release of letters, digits, dots and hyphens.
    public static func isWellFormed(_ text: String) -> Bool {
        text.range(of: #"^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.\-]{0,40})?$"#, options: .regularExpression) != nil
    }

    public var isPrerelease: Bool { !pre.isEmpty }
    public var major: Int { core.first ?? 0 }
    public var description: String { text }

    public static func == (a: AgentVersion, b: AgentVersion) -> Bool { a.core == b.core && a.pre == b.pre }
    public func hash(into hasher: inout Hasher) { hasher.combine(core); hasher.combine(pre) }

    public static func < (a: AgentVersion, b: AgentVersion) -> Bool {
        let n = max(a.core.count, b.core.count)
        for i in 0..<n {
            let x = i < a.core.count ? a.core[i] : 0, y = i < b.core.count ? b.core[i] : 0
            if x != y { return x < y }
        }
        if a.pre.isEmpty || b.pre.isEmpty { return !a.pre.isEmpty && b.pre.isEmpty }
        for (x, y) in zip(a.pre, b.pre) where x != y { return x < y }
        return a.pre.count < b.pre.count
    }
}
