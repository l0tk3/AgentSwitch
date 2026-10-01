import Foundation

/// The root-only steps of gate-service-v0 §4 (安装 · 程序更新 · 改端口 · 卸载), run by the bundled secret-gate after one
/// administrator prompt.
public enum GateServiceOperation: Sendable, Equatable {
    case install
    case update
    /// The service does not answer: the same `system update`, which replaces the program and restarts both services.
    case repair
    case changePort(Int)
    case uninstall(deleteKeys: Bool)

    /// What the row says while it runs.
    public var progressText: String {
        switch self {
        case .install: return "Installing"
        case .update, .repair, .changePort: return "Updating"
        case .uninstall: return "Uninstalling"
        }
    }

    /// The text of macOS's administrator prompt (`with prompt`).
    public var prompt: String {
        switch self {
        case .install: return "AgentSwitch 将安装凭据网关服务。"
        case .update, .repair: return "AgentSwitch 将更新凭据网关服务。"
        case .changePort(let port): return "AgentSwitch 将把凭据网关服务的端口改为 \(port)。"
        case .uninstall: return "AgentSwitch 将卸载凭据网关服务。"
        }
    }

    /// One line for the result: 凭据网关服务已安装。
    public var doneText: String {
        switch self {
        case .install: return "凭据网关服务已安装。"
        case .update, .repair: return "凭据网关服务已更新。"
        case .changePort(let port): return "凭据网关服务已改用端口 \(port)。"
        case .uninstall(let deleteKeys): return deleteKeys ? "凭据网关服务已卸载，密钥已删除。" : "凭据网关服务已卸载。"
        }
    }

    public var failedText: String {
        switch self {
        case .install: return "Install Failed"
        case .update, .repair, .changePort: return "Update Failed"
        case .uninstall: return "Uninstall Failed"
        }
    }
}

/// What the bundled CLI is asked, as argv; nothing here runs anything.
public enum GateServiceCommand {
    /// `do shell script` starts `/bin/sh` as root with its own environment; the command gets only this.
    public static let environment = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=en_US.UTF-8"]
    /// Last line of the output: the command's exit status (the line itself always exits 0, so the output survives).
    public static let exitMarker = "__AGENTSWITCH_EXIT__="
    public static let osascript = URL(fileURLWithPath: "/usr/bin/osascript")

    /// `secret-gate system install --owner-uid <uid> --port <port> --runtime <runtime> --migrate-from <~/.secret-gate>`,
    /// `system update --runtime <runtime> [--port N]`, `system uninstall [--delete-keys]`.
    public static func argv(_ operation: GateServiceOperation, gate: URL, runtime: URL, ownerUid: Int, port: Int,
                            migrateFrom: URL) -> [String] {
        switch operation {
        case .install:
            return [gate.path, "system", "install", "--owner-uid", String(ownerUid), "--port", String(port),
                    "--runtime", runtime.path, "--migrate-from", migrateFrom.path]
        case .update, .repair:
            return [gate.path, "system", "update", "--runtime", runtime.path]
        case .changePort(let newPort):
            return [gate.path, "system", "update", "--runtime", runtime.path, "--port", String(newPort)]
        case .uninstall(let deleteKeys):
            return [gate.path, "system", "uninstall"] + (deleteKeys ? ["--delete-keys"] : [])
        }
    }

    /// The line `/bin/sh` runs as root: a clean environment, every word single-quoted where needed, stderr folded into
    /// stdout, and the exit status appended so a failure still returns its output (`do shell script` drops stdout on a
    /// non-zero exit).
    public static func shellLine(_ argv: [String]) -> String {
        (["/usr/bin/env", "-i"] + environment + argv).map(ShellQuote.quote).joined(separator: " ")
            + " 2>&1; echo \"\(exitMarker)$?\""
    }

    /// `osascript` arguments: the line and the prompt go in as `argv`, never into the script text, so neither needs
    /// AppleScript escaping. `without altering line endings` keeps `\n` (the default turns it into `\r`).
    public static func osascriptArguments(shellLine: String, prompt: String) -> [String] {
        let script = [
            "on run argv",
            "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges without altering line endings",
            "end run",
        ]
        return script.flatMap { ["-e", $0] } + [shellLine, prompt]
    }

    /// osascript's result: cancelled at the password prompt (-128), the command's own exit status and output, or
    /// osascript's error.
    public static func interpret(_ result: CommandResult?) -> AdminOutcome {
        guard let result else { return .failed(reason: "无法启动 osascript", output: "") }
        if result.timedOut { return .failed(reason: "等待管理员授权或执行超时", output: trimmed(result.stdoutText)) }
        guard result.ok else {
            let stderr = result.stderrText
            if stderr.contains("(-128)") { return .cancelled }
            return .failed(reason: osascriptMessage(stderr) ?? "osascript 退出码 \(result.status)", output: "")
        }
        let lines = result.stdoutText.components(separatedBy: "\n")
        guard let index = lines.lastIndex(where: { $0.hasPrefix(exitMarker) }),
              let status = Int(lines[index].dropFirst(exitMarker.count).trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return .failed(reason: "无法确认执行结果", output: trimmed(result.stdoutText))
        }
        let output = trimmed(lines[..<index].joined(separator: "\n"))
        if status == 0 { return .succeeded(output: output) }
        let reason = output.components(separatedBy: "\n").last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return .failed(reason: reason.map(trimmed) ?? "退出码 \(status)", output: output)
    }

    /// `0:170: execution error: <message> (<number>)` → `<message>`.
    static func osascriptMessage(_ stderr: String) -> String? {
        var text = trimmed(stderr)
        if let range = text.range(of: "execution error: ") { text = String(text[range.upperBound...]) }
        if let range = text.range(of: #"\s*\(-?\d+\)$"#, options: .regularExpression) { text.removeSubrange(range) }
        return text.isEmpty ? nil : text
    }

    private static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
}

public enum AdminOutcome: Sendable, Equatable {
    case succeeded(output: String)
    case failed(reason: String, output: String)
    /// The user closed the administrator prompt: nothing ran, nothing to report.
    case cancelled

    public var succeeded: Bool {
        if case .succeeded = self { return true }
        return false
    }
}

/// Runs one operation through `osascript … with administrator privileges`; the runner is injectable for tests.
public struct GateServiceAdmin: Sendable {
    public typealias Runner = @Sendable (_ executable: URL, _ arguments: [String], _ timeout: TimeInterval) async throws -> CommandResult

    /// The prompt waits for the user, then the install copies the runtime and starts two services.
    public static let timeout: TimeInterval = 20 * 60

    private let runner: Runner

    public init(runner: @escaping Runner = { try await ProcessRunner.run($0, $1, timeout: $2) }) {
        self.runner = runner
    }

    public func perform(_ argv: [String], prompt: String) async -> AdminOutcome {
        let arguments = GateServiceCommand.osascriptArguments(shellLine: GateServiceCommand.shellLine(argv), prompt: prompt)
        let result = try? await runner(GateServiceCommand.osascript, arguments, GateServiceAdmin.timeout)
        return GateServiceCommand.interpret(result)
    }
}
