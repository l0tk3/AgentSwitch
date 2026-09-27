import Foundation

/// 登录 (docs/control-v0.md §6): the harness's own login command, run in a new Terminal window so the user signs in
/// there (browser, device code, API key prompts). The app never sees the credentials; it only checks again afterwards.
public enum HarnessLogin {
    public static func arguments(_ harness: Harness) -> [String] {
        switch harness {
        case .claude: return ["auth", "login"]
        case .codex: return ["login"]
        case .opencode: return ["auth", "login"]
        }
    }

    /// What the user would type themselves: `claude auth login`.
    public static func displayCommand(_ harness: Harness) -> String {
        ([harness.rawValue] + arguments(harness)).joined(separator: " ")
    }

    /// The line Terminal runs: the binary detection found (or the bare name), under the login-shell PATH the daemon gets
    /// (an npm-installed codex needs `node` on it). `/usr/bin/env` scopes PATH to this one command in any shell.
    public static func shellCommand(_ harness: Harness, binary: String?, path: String) -> String {
        let executable = binary?.isEmpty == false ? binary! : harness.rawValue
        return (["/usr/bin/env", "PATH=" + path, executable] + arguments(harness)).map(ShellQuote.quote).joined(separator: " ")
    }

    public static let osascript = URL(fileURLWithPath: "/usr/bin/osascript")

    /// `osascript` arguments that open a Terminal window running `command`. The command goes in as `argv`, never into
    /// the script text, so nothing in it needs AppleScript escaping.
    public static func terminalScriptArguments(command: String) -> [String] {
        let script = ["on run argv", "tell application \"Terminal\"", "activate", "do script (item 1 of argv)", "end tell", "end run"]
        return script.flatMap { ["-e", $0] } + [command]
    }

    /// Nil when Terminal opened; otherwise what went wrong and how to do it by hand.
    public static func problem(_ harness: Harness, result: CommandResult?) -> String? {
        let byHand = "也可在终端中手动运行 \(displayCommand(harness))。"
        guard let result else { return "无法打开“终端”。" + byHand }
        if result.ok { return nil }
        if result.timedOut { return "“终端”无响应。" + byHand }
        let stderr = result.stderrText
        if stderr.contains("-1743") || stderr.localizedCaseInsensitiveContains("not authorized") || stderr.localizedCaseInsensitiveContains("not allowed") {
            return "AgentSwitch 无权控制“终端”。请在“系统设置 › 隐私与安全性 › 自动化”中允许。" + byHand
        }
        let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        return "无法打开“终端”" + (detail.isEmpty ? "（退出码 \(result.status)）" : "：\(detail)") + "。" + byHand
    }
}

/// The install command a 复制命令 button puts on the clipboard (the first option HarnessEvaluator.guidance names).
public enum HarnessInstall {
    public static func command(_ harness: Harness) -> String {
        switch harness {
        case .claude: return "curl -fsSL https://claude.ai/install.sh | bash"
        case .codex: return "brew install codex"
        case .opencode: return "curl -fsSL https://opencode.ai/install | bash"
        }
    }
}

/// POSIX single quoting for a line typed into a shell.
public enum ShellQuote {
    static let plain = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@%+=:,./_-")

    /// Words of plain characters stay bare; anything else is single-quoted, a `'` inside becoming `'\''`.
    public static func quote(_ word: String) -> String {
        if !word.isEmpty && word.unicodeScalars.allSatisfy(plain.contains) { return word }
        return "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

/// Logins started in Terminal. While one is open, coming back to the app checks the environment again, until that
/// harness reports a login or `window` has passed.
public struct LoginWatch: Equatable, Sendable {
    public static let window: TimeInterval = 15 * 60
    public let started: [Harness: Date]

    public init(started: [Harness: Date] = [:]) { self.started = started }

    public func starting(_ harness: Harness, at date: Date) -> LoginWatch {
        LoginWatch(started: started.merging([harness: date]) { _, new in new })
    }

    public func dropping(_ harness: Harness) -> LoginWatch {
        LoginWatch(started: started.filter { $0.key != harness })
    }

    public func shouldRecheck(now: Date) -> Bool {
        started.values.contains { now.timeIntervalSince($0) < LoginWatch.window }
    }

    /// The app came to the front: check the environment again while a login is open, or while the checklist still has
    /// something missing (something may have been installed meanwhile), at most every `throttle` seconds for the latter.
    public func recheckDue(now: Date, unmet: Int, lastDetected: Date?, throttle: TimeInterval = 30) -> Bool {
        if shouldRecheck(now: now) { return true }
        guard unmet > 0 else { return false }
        return lastDetected.map { now.timeIntervalSince($0) >= throttle } ?? true
    }

    /// Without the harnesses now logged in and the logins started too long ago.
    public func settled(by reports: [HarnessReport], now: Date) -> LoginWatch {
        let ready = Set(reports.filter { $0.state == .ready }.map(\.harness))
        return LoginWatch(started: started.filter { !ready.contains($0.key) && now.timeIntervalSince($0.value) < LoginWatch.window })
    }
}
