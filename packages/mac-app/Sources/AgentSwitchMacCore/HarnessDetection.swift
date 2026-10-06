import Foundation

/// The three harnesses the user installs and logs in to themselves (app-v0 §4 首次运行).
public enum Harness: String, CaseIterable, Sendable, Identifiable {
    case claude, codex, opencode

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "Codex"
        case .opencode: return "OpenCode"
        }
    }

    /// Places installers use besides PATH.
    public func knownLocations(home: String) -> [String] {
        switch self {
        case .claude: return ["\(home)/.local/bin/claude", "\(home)/.claude/local/claude"]
        case .codex: return ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex"]
        case .opencode: return ["\(home)/.opencode/bin/opencode"]
        }
    }
}

/// What a probe found, before any judgement.
public struct HarnessFacts: Sendable, Equatable {
    public let harness: Harness
    public let binary: String?
    public let versionOutput: String?
    /// Human-readable proof of a login (a credential file, a keychain item), nil when none was found.
    public let loginEvidence: String?

    public init(harness: Harness, binary: String?, versionOutput: String?, loginEvidence: String?) {
        self.harness = harness
        self.binary = binary
        self.versionOutput = versionOutput
        self.loginEvidence = loginEvidence
    }
}

public enum HarnessState: String, Sendable, Equatable {
    case missing, notLoggedIn, ready
}

public struct HarnessReport: Sendable, Equatable, Identifiable {
    public let harness: Harness
    public let state: HarnessState
    public let binary: String?
    public let version: String?
    public let evidence: String?
    public let guidance: [String]

    public var id: String { harness.rawValue }
}

public enum HarnessEvaluator {
    /// First dotted version number in `--version` output (`2.1.278 (Claude Code)`, `codex-cli 0.155.0`, `2.0.8`).
    public static func parseVersion(_ output: String) -> String? {
        let pattern = #"\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.\-]+)?"#
        guard let range = output.range(of: pattern, options: .regularExpression) else { return nil }
        return String(output[range])
    }

    public static func evaluate(_ facts: HarnessFacts) -> HarnessReport {
        let state: HarnessState = facts.binary == nil ? .missing : (facts.loginEvidence == nil ? .notLoggedIn : .ready)
        return HarnessReport(harness: facts.harness, state: state, binary: facts.binary,
                             version: facts.versionOutput.flatMap(parseVersion), evidence: facts.loginEvidence,
                             guidance: guidance(facts.harness, state))
    }

    /// Install and login steps. Installing is 设置 › Agents (docs/agents-v0.md); logging in is the user's, in Terminal.
    public static func guidance(_ harness: Harness, _ state: HarnessState) -> [String] {
        switch (harness, state) {
        case (_, .ready):
            return []
        case (.claude, .missing):
            return ["可在 Agents 页安装。", "安装后在终端运行 claude，按提示登录"]
        case (.claude, .notLoggedIn):
            return ["在终端运行 claude，按提示登录（或在 claude 中输入 /login）"]
        case (.codex, .missing):
            return ["可在 Agents 页安装，也可使用 ChatGPT 桌面应用自带的 codex。", "安装后在终端运行 codex login，使用 ChatGPT 账户登录"]
        case (.codex, .notLoggedIn):
            return ["在终端运行 codex login，使用 ChatGPT 账户登录"]
        case (.opencode, .missing):
            return ["可在 Agents 页安装。", "安装后运行 opencode auth login，配置 DeepSeek 等模型提供商"]
        case (.opencode, .notLoggedIn):
            return ["在终端运行 opencode auth login，配置 DeepSeek 等模型提供商"]
        }
    }
}

/// PATH lookup the way a shell does it, plus known install locations.
public enum ExecutableLookup {
    public static func find(_ name: String, path: String, extra: [String] = [],
                            fileManager: FileManager = .default) -> String? {
        let candidates = path.split(separator: ":").map { "\($0)/\(name)" } + extra
        return candidates.first { fileManager.isExecutableFile(atPath: $0) }
    }
}
