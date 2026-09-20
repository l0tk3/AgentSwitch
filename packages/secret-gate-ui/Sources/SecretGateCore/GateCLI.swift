import Foundation

/// Bridge to the Python `secret-gate` CLI. Every call spawns one process with
/// SECRET_GATE_HOME set; secret values travel only over stdin, never argv.
public struct GateCLI: Sendable {
    public let executable: URL
    public let home: URL

    public init(executable: URL, home: URL) {
        self.executable = executable
        self.home = home
    }

    /// Candidate locations for the CLI, first existing one wins.
    public static func defaultExecutable() -> URL {
        let fm = FileManager.default
        let candidates = [
            "~/Desktop/WorkSpace/Projects/AgentSwitch/packages/secret-gate/.venv/bin/secret-gate",
            "~/.local/bin/secret-gate",
            "/opt/homebrew/bin/secret-gate",
        ].map { URL(fileURLWithPath: NSString(string: $0).expandingTildeInPath) }
        return candidates.first { fm.isExecutableFile(atPath: $0.path) } ?? candidates[0]
    }

    public static func defaultHome() -> URL {
        URL(fileURLWithPath: NSString(string: "~/.secret-gate").expandingTildeInPath)
    }

    // MARK: commands

    public func listKeys() throws -> [Keypair] {
        let out = try run(["keys", "--json"])
        return try JSONDecoder().decode([Keypair].self, from: out)
    }

    public func newKey(named name: String, makeCurrent: Bool) throws -> [Keypair] {
        var args = ["keys", "--json", "new", name]
        if makeCurrent { args.append("--use") }
        return try JSONDecoder().decode([Keypair].self, from: try run(args))
    }

    public func useKey(named name: String) throws -> [Keypair] {
        try JSONDecoder().decode([Keypair].self, from: try run(["keys", "--json", "use", name]))
    }

    /// Encrypts every entry for the *current* keypair. Per-entry errors come back in the result.
    public func encrypt(_ entries: [TokenEntry]) throws -> [TokenResult] {
        let payload = try JSONSerialization.data(withJSONObject: entries.map(\.batchObject))
        let out = try run(["enc", "--batch"], stdin: payload, acceptExit: [0, 1])
        return try JSONDecoder().decode([TokenResult].self, from: out)
    }

    // MARK: process plumbing

    public struct CLIError: LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }

    func run(_ args: [String], stdin: Data? = nil, acceptExit: Set<Int32> = [0]) throws -> Data {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw CLIError(message: "找不到 secret-gate 命令：\(executable.path)\n在设置里指定路径。")
        }
        let proc = Process()
        proc.executableURL = executable
        proc.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["SECRET_GATE_HOME"] = home.path
        proc.environment = env

        let outPipe = Pipe(), errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        let inPipe = Pipe()
        proc.standardInput = inPipe
        try proc.run()
        if let stdin { inPipe.fileHandleForWriting.write(stdin) }
        try? inPipe.fileHandleForWriting.close()
        let out = outPipe.fileHandleForReading.readDataToEndOfFile()
        let err = errPipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        guard acceptExit.contains(proc.terminationStatus) else {
            let text = String(data: err, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw CLIError(message: text.isEmpty ? "secret-gate 退出码 \(proc.terminationStatus)" : text)
        }
        return out
    }
}
