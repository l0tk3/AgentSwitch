import Darwin
import Foundation

/// When a process started, to the microsecond (`proc_bsdinfo.pbi_start_tvsec/usec`). Together with the pid it names
/// one process: a pid the kernel hands out again belongs to a process with a later start time.
public struct ProcessStart: Sendable, Equatable {
    public let seconds: UInt64
    public let microseconds: UInt64

    public init(seconds: UInt64, microseconds: UInt64) {
        self.seconds = seconds
        self.microseconds = microseconds
    }

    /// `seconds.microseconds`, six digits after the dot.
    public var text: String {
        let micros = String(microseconds)
        return "\(seconds).\(String(repeating: "0", count: max(0, 6 - micros.count)))\(micros)"
    }

    public init?(text: String) {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[1].count == 6, parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
              let seconds = UInt64(parts[0]), let micros = UInt64(parts[1]) else { return nil }
        self.init(seconds: seconds, microseconds: micros)
    }
}

/// Children outlive an app that crashed or was force-quit. Each child's pid and start time go into a file; on the
/// next start the recorded process is stopped before its port is judged "taken", but only when it is still that
/// same process (same start time, so a reused pid is never hit) and its executable lives in this app's own runtime
/// (compared as real paths). Another copy's runtime, anything else, or a pid file without a start time (written by
/// an older build): left alone, whatever the pid file says.
public enum Leftovers {
    /// A pid file: `<pid> <start seconds>.<microseconds>`.
    public struct Record: Sendable, Equatable {
        public let pid: Int32
        public let started: ProcessStart?

        public init(pid: Int32, started: ProcessStart?) {
            self.pid = pid
            self.started = started
        }

        public var text: String {
            started.map { "\(pid) \($0.text)\n" } ?? "\(pid)\n"
        }

        public static func parse(_ text: String) -> Record? {
            let fields = text.split(whereSeparator: \.isWhitespace)
            guard let first = fields.first, let pid = Int32(first), pid > 0 else { return nil }
            return Record(pid: pid, started: fields.count > 1 ? ProcessStart(text: String(fields[1])) : nil)
        }
    }

    public static func readRecord(_ url: URL) -> Record? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return Record.parse(text)
    }

    public static func readPid(_ url: URL) -> Int32? {
        readRecord(url)?.pid
    }

    /// Records `pid` with its start time, read now (right after the spawn).
    public static func writePid(_ pid: Int32, to url: URL) {
        write(Record(pid: pid, started: startTime(of: pid)), to: url)
    }

    public static func write(_ record: Record, to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        try? record.text.write(to: url, atomically: true, encoding: .utf8)
    }

    public static func removePid(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    public static func isAlive(_ pid: Int32) -> Bool {
        pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
    }

    /// Start time of a live process (`proc_pidinfo(PROC_PIDTBSDINFO)`), nil when it is gone or not ours to inspect.
    public static func startTime(of pid: Int32) -> ProcessStart? {
        guard pid > 0 else { return nil }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return ProcessStart(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
    }

    /// The recorded process is still running: same pid and same start time. A record without a start time never is.
    public static func isSameProcess(_ record: Record) -> Bool {
        guard let started = record.started, isAlive(record.pid) else { return false }
        return startTime(of: record.pid) == started
    }

    /// Absolute path of a process's executable (`proc_pidpath`), nil when it is gone or not ours to inspect.
    public static func executablePath(of pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let n = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard n > 0 else { return nil }
        return String(decoding: buffer.prefix(Int(n)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    /// Whether `executablePath` lies inside this runtime, both sides resolved with realpath(3) (proc_pidpath reports
    /// /private/var, not the /var symlink). A runtime that no longer exists owns nothing; neither does another copy's
    /// `AgentSwitch.app/Contents/Resources/runtime`: that copy looks after its own children.
    public static func isOurs(executablePath: String, runtimeRoot: URL) -> Bool {
        guard let root = realPath(runtimeRoot.path) else { return false }
        let exe = realPath(executablePath) ?? executablePath
        return exe.hasPrefix(root.hasSuffix("/") ? root : root + "/")
    }

    /// realpath(3), nil when the path does not exist.
    public static func realPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// Stops the process named by `pidFile` when it is ours: `signal`, then SIGKILL after `timeout`, each only while
    /// the recorded process (pid and start time) is still there. Returns the pid it stopped, nil when there was
    /// nothing of ours to stop. The pid file is removed either way.
    public static func reap(pidFile: URL, runtimeRoot: URL, signal: Int32, timeout: TimeInterval) async -> Int32? {
        defer { removePid(pidFile) }
        guard let record = readRecord(pidFile), isSameProcess(record),
              let exe = executablePath(of: record.pid), isOurs(executablePath: exe, runtimeRoot: runtimeRoot) else { return nil }
        kill(record.pid, signal)
        let deadline = Date().addingTimeInterval(timeout)
        while isSameProcess(record) && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
        if isSameProcess(record) { kill(record.pid, SIGKILL) }
        return record.pid
    }
}
