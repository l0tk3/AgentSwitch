import Foundation

public struct CommandResult: Sendable, Equatable {
    public let status: Int32
    public let stdout: Data
    public let stderr: Data
    public let timedOut: Bool

    public var ok: Bool { status == 0 && !timedOut }
    public var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
    public var stderrText: String { String(decoding: stderr, as: UTF8.self) }
}

public struct CommandError: LocalizedError, Sendable, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// One-shot commands with a deadline. Output is collected through readability handlers rather than
/// read-to-EOF, so a grandchild that keeps a pipe open (a login shell starting an agent) cannot hang us.
public enum ProcessRunner {
    public static func run(_ executable: URL, _ arguments: [String], environment: [String: String]? = nil,
                           stdin: Data? = nil, timeout: TimeInterval = 10) async throws -> CommandResult {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result {
                    try runBlocking(executable, arguments, environment: environment, stdin: stdin, timeout: timeout)
                })
            }
        }
    }

    public static func runBlocking(_ executable: URL, _ arguments: [String], environment: [String: String]? = nil,
                                   stdin: Data? = nil, timeout: TimeInterval = 10) throws -> CommandResult {
        let proc = Process()
        proc.executableURL = executable
        proc.arguments = arguments
        if let environment { proc.environment = environment }
        let out = Collector(), err = Collector()
        let outPipe = Pipe(), errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        outPipe.fileHandleForReading.readabilityHandler = { Collector.pump($0, into: out) }
        errPipe.fileHandleForReading.readabilityHandler = { Collector.pump($0, into: err) }
        let inPipe = stdin.map { _ in Pipe() }
        proc.standardInput = inPipe ?? FileHandle.nullDevice

        let exited = DispatchSemaphore(value: 0)
        proc.terminationHandler = { _ in exited.signal() }
        do {
            try proc.run()
        } catch {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            throw CommandError("无法启动 \(executable.path)：\(error.localizedDescription)")
        }
        if let stdin, let inPipe {
            inPipe.fileHandleForWriting.write(stdin)
            try? inPipe.fileHandleForWriting.close()
        }
        var timedOut = false
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            timedOut = true
            proc.terminate()
            if exited.wait(timeout: .now() + 1) == .timedOut {
                kill(proc.processIdentifier, SIGKILL)
                _ = exited.wait(timeout: .now() + 1)
            }
        }
        // Let the last chunks arrive, then stop listening whatever a grandchild still holds.
        Thread.sleep(forTimeInterval: 0.05)
        outPipe.fileHandleForReading.readabilityHandler = nil
        errPipe.fileHandleForReading.readabilityHandler = nil
        out.append(drain(outPipe.fileHandleForReading))
        err.append(drain(errPipe.fileHandleForReading))
        let status = proc.isRunning ? -1 : proc.terminationStatus
        return CommandResult(status: status, stdout: out.data, stderr: err.data, timedOut: timedOut)
    }

    /// Whatever is buffered right now, without blocking on a writer that never closes.
    private static func drain(_ handle: FileHandle) -> Data {
        let fd = handle.fileDescriptor
        let flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
            let n = read(fd, &buffer, buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

/// Thread-safe byte accumulator for pipe handlers.
final class Collector: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()

    func append(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        lock.lock()
        buffer.append(chunk)
        lock.unlock()
    }

    /// Readability handler body: an empty read is EOF, after which the handler must stop or it spins.
    static func pump(_ handle: FileHandle, into collector: Collector) {
        let chunk = handle.availableData
        if chunk.isEmpty { handle.readabilityHandler = nil } else { collector.append(chunk) }
    }

    var data: Data {
        lock.lock()
        defer { lock.unlock() }
        return buffer
    }
}
