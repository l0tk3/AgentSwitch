import Foundation

/// The user's login-shell PATH for the daemon. An app started from Finder or launchd only gets
/// /usr/bin:/bin:/usr/sbin:/sbin and would not find codex / opencode / claude (app-v0 §4 环境).
public enum LoginShellPath {
    public struct Resolution: Sendable, Equatable {
        public enum Source: String, Sendable { case loginShell, fallback }
        public let path: String
        public let source: Source
        /// Why the fallback was used, for the 环境 tab.
        public let note: String?
        /// What the login shell itself said, before the fallback folders were added: the PATH a new terminal has.
        /// nil when it could not be asked.
        public let shell: String?

        public init(path: String, source: Source, note: String?, shell: String? = nil) {
            self.path = path
            self.source = source
            self.note = note
            self.shell = shell
        }
    }

    static let begin = "__AGENTSWITCH_PATH_BEGIN__"
    static let end = "__AGENTSWITCH_PATH_END__"
    public static let defaultTimeout: TimeInterval = 5
    public static let systemDirs = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

    /// Markers around the value: an interactive shell may print a banner or prompt noise on stdout too.
    public static var command: String { "printf '%s%s%s' '\(begin)' \"$PATH\" '\(end)'" }

    public static func extract(from output: String) -> String? {
        guard let start = output.range(of: begin),
              let stop = output.range(of: end, range: start.upperBound..<output.endIndex) else { return nil }
        let value = String(output[start.upperBound..<stop.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    /// Where installers put these CLIs when the shell profile does not say (app-v0 §4 and the task brief).
    public static func fallbackDirs(home: String) -> [String] {
        ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.opencode/bin"]
    }

    /// Shell entries first (the user's order wins), then fallbacks and system dirs not yet present.
    public static func merge(shellPath: String?, home: String) -> String {
        let shell = (shellPath ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty }
        var seen = Set<String>()
        var out: [String] = []
        for dir in shell + fallbackDirs(home: home) + systemDirs where !seen.contains(dir) {
            seen.insert(dir)
            out.append(dir)
        }
        return out.joined(separator: ":")
    }

    /// The environment the shell starts from: what launchd gives a GUI app, so the profile builds PATH as it
    /// would for a fresh Terminal window instead of extending whatever PATH launched us.
    public static func shellEnvironment(base: [String: String], home: String) -> [String: String] {
        var env = base
        env["HOME"] = home
        env["TERM"] = "dumb"
        env["PATH"] = systemDirs.joined(separator: ":")
        return env
    }

    /// Runs `$SHELL -lic` with stdin closed and a deadline. Never throws: the fallback PATH is always usable.
    public static func resolve(shell: String?, home: String, base: [String: String] = [:],
                               timeout: TimeInterval = defaultTimeout) async -> Resolution {
        let shellPath = (shell?.isEmpty == false ? shell : nil) ?? "/bin/zsh"
        do {
            let result = try await ProcessRunner.run(URL(fileURLWithPath: shellPath), ["-lic", command],
                                                     environment: shellEnvironment(base: base, home: home), timeout: timeout)
            if let found = extract(from: result.stdoutText) {
                return Resolution(path: merge(shellPath: found, home: home), source: .loginShell, note: nil, shell: found)
            }
            let why = result.timedOut ? "登录 shell 超过 \(Int(timeout)) 秒未返回" : "登录 shell 未输出 PATH（退出码 \(result.status)）"
            return Resolution(path: merge(shellPath: nil, home: home), source: .fallback, note: why)
        } catch {
            return Resolution(path: merge(shellPath: nil, home: home), source: .fallback, note: error.localizedDescription)
        }
    }
}
