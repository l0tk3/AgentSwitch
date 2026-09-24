import Darwin
import Foundation
@testable import AgentSwitchMacCore

enum TestSupport {
    static let packageRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let repoRoot = packageRoot.deletingLastPathComponent().deletingLastPathComponent()
    /// The monorepo's dev install of secret-gate; integration tests skip without it.
    static let devGate = repoRoot.appendingPathComponent("packages/secret-gate/.venv/bin/secret-gate")

    static func tempDir(_ name: String = "t") -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("asm-\(name)-\(UUID().uuidString.prefix(8))")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static var searchPath: String {
        LoginShellPath.merge(shellPath: ProcessInfo.processInfo.environment["PATH"], home: NSHomeDirectory())
    }

    static func findNode() -> String? {
        ExecutableLookup.find("node", path: searchPath)
    }

    /// A port nothing listens on right now (bind to 0, read it back, close).
    static func freePort() -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        return Int(UInt16(bigEndian: addr.sin_port))
    }

    /// SIGTERM, then SIGKILL after `grace`. Never `waitUntilExit()`: it spins the current run loop, and a Swift
    /// concurrency thread has none running, so the exit notification may never arrive.
    static func stop(_ proc: Process, grace: TimeInterval = 5) async {
        guard proc.isRunning else { return }
        proc.terminate()
        let gone = await waitUntil(timeout: grace) { !proc.isRunning }
        if !gone { kill(proc.processIdentifier, SIGKILL) }
        _ = await waitUntil(timeout: 2) { !proc.isRunning }
    }

    static func waitUntil(timeout: TimeInterval, _ condition: () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return await condition()
    }
}

/// A loopback server that answers every connection with a canned response (after reading the request head).
final class CannedServer: @unchecked Sendable {
    let port: Int
    private let fd: Int32
    private let response: Data
    private let lock = NSLock()
    private var received: [Data] = []

    init(response: String) {
        self.response = Data(response.utf8)
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        var one: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        listen(sock, 8)
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(sock, $0, &len) } }
        fd = sock
        port = Int(UInt16(bigEndian: addr.sin_port))
        let thread = Thread { [self] in serve() }
        thread.start()
    }

    var requests: [Data] {
        lock.lock()
        defer { lock.unlock() }
        return received
    }

    private func serve() {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 { return }
            let head = LoopbackSocket.readHead(client, limit: 8192, timeout: 2)
            lock.lock()
            received.append(head)
            lock.unlock()
            _ = LoopbackSocket.sendAll(client, response)
            close(client)
        }
    }

    func stop() {
        shutdown(fd, SHUT_RDWR)
        close(fd)
    }
}
