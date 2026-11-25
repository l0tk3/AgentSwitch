import XCTest
@testable import AgentSwitchMacCore

/// What the service's streams share (StreamTransport.swift): a silent connection counts as dropped, more streams
/// than a URL session gives a host by default, the reconnect timing.
final class StreamTransportTests: XCTestCase {
    func testSilenceCountsAsADroppedConnection() async {
        let (silent, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        defer { sink.finish() }
        do {
            for try await _ in DaemonClient.idleGuarded(silent, limit: .milliseconds(50)) {}
            XCTFail("expected the idle limit")
        } catch {
            XCTAssertEqual(error as? DaemonError, .unreachable(DaemonClient.idleMessage))
            XCTAssertTrue((error as? DaemonError)?.isNetworkFailure == true, "silence reconnects rather than failing the page")
        }
    }

    /// Every stream the app follows goes to one host and holds its connection. A URL session left as it comes gives a
    /// host six: the seventh stream waited for one until its time ran out, and the pane it was for stood still
    /// (2026-11-10, user: 简略模式我刚才发的消息被吃掉了).
    func testMoreStreamsThanAURLSessionGivesAHostByDefault() async throws {
        XCTAssertGreaterThanOrEqual(URLSessionStreamTransport.configuration().httpMaximumConnectionsPerHost, 64)
        let server = HoldingServer()
        defer { server.stop() }
        let transport = URLSessionStreamTransport()
        let wanted = 12
        let answered = DispatchLock(0)
        let streams = (0..<wanted).map { n in
            Task {
                var request = URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/stream/\(n)")!)
                request.timeoutInterval = 20
                guard let (response, body) = try? await transport.stream(request), response.statusCode == 200 else { return }
                for try await _ in body { answered.withLock { $0 += 1 }; break }
                // Held open, as a followed stream is, until the test is over.
                try? await Task.sleep(for: .seconds(30))
            }
        }
        defer { streams.forEach { $0.cancel() } }
        let all = await TestSupport.waitUntil(timeout: 10) { answered.withLock { $0 } == wanted }
        XCTAssertTrue(all, "only \(answered.withLock { $0 }) of \(wanted) streams were answered while the others were held")
    }

    func testBackoff() {
        let p = DispatchReconnectPolicy(initial: .seconds(1), maximum: .seconds(15))
        XCTAssertEqual((1...6).map { p.delay(afterFailures: $0) }, [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(15)])
        XCTAssertEqual(p.delay(afterFailures: 0), .zero)
    }
}

/// A loopback server that answers every connection as an event stream and never ends it: one comment at once, then
/// silence, the connection held until the server stops.
final class HoldingServer: @unchecked Sendable {
    let port: Int
    private let fd: Int32
    private let lock = NSLock()
    private var clients: [Int32] = []

    init() {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        var one: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        listen(sock, 64)
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(sock, $0, &len) } }
        fd = sock
        port = Int(UInt16(bigEndian: addr.sin_port))
        Thread { [self] in serve() }.start()
    }

    private func serve() {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 { return }
            var one: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            lock.withLock { clients.append(client) }
            Thread {
                _ = LoopbackSocket.readHead(client, limit: 8192, timeout: 2)
                let ping = ": ping\n\n"
                let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n\(String(ping.utf8.count, radix: 16))\r\n\(ping)\r\n"
                _ = LoopbackSocket.sendAll(client, Data(head.utf8))
            }.start()
        }
    }

    func stop() {
        shutdown(fd, SHUT_RDWR)
        close(fd)
        lock.withLock { clients.forEach { close($0) }; clients = [] }
    }
}
