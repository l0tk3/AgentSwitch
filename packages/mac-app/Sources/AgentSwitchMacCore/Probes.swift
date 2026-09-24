import Darwin
import Foundation

/// Loopback TCP helpers with deadlines (blocking; call off the main thread).
enum LoopbackSocket {
    /// A connected socket to host:port within `timeout`, or nil.
    static func connect(host: String, port: Int, timeout: TimeInterval) -> Int32? {
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(truncatingIfNeeded: port).bigEndian)
        guard inet_pton(AF_INET, host, &addr.sin_addr) == 1 else { return nil }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        let flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if rc != 0 && errno != EINPROGRESS { close(fd); return nil }
        if rc != 0 {
            guard wait(fd, events: Int16(POLLOUT), timeout: timeout) else { close(fd); return nil }
            var err: Int32 = 0
            var len = socklen_t(MemoryLayout<Int32>.size)
            getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
            guard err == 0 else { close(fd); return nil }
        }
        _ = fcntl(fd, F_SETFL, flags)
        return fd
    }

    static func wait(_ fd: Int32, events: Int16, timeout: TimeInterval) -> Bool {
        var pfd = pollfd(fd: fd, events: events, revents: 0)
        let ms = Int32(max(0, timeout * 1000))
        return poll(&pfd, 1, ms) > 0 && (pfd.revents & (events | Int16(POLLHUP))) != 0
    }

    static func sendAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            var offset = 0
            while offset < raw.count {
                let n = send(fd, raw.baseAddress! + offset, raw.count - offset, 0)
                if n <= 0 { return false }
                offset += n
            }
            return true
        }
    }

    /// Reads until the end of the HTTP head, EOF, `limit` bytes or the deadline.
    static func readHead(_ fd: Int32, limit: Int, timeout: TimeInterval) -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        let deadline = Date().addingTimeInterval(timeout)
        let marker = Data("\r\n\r\n".utf8)
        while data.count < limit && data.range(of: marker) == nil {
            let left = deadline.timeIntervalSinceNow
            guard left > 0, wait(fd, events: Int16(POLLIN), timeout: left) else { break }
            let n = recv(fd, &buffer, buffer.count, 0)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

public enum PortProbe {
    /// Something accepts TCP connections on host:port.
    public static func isListening(port: Int, host: String = "127.0.0.1", timeout: TimeInterval = 1) -> Bool {
        guard let fd = LoopbackSocket.connect(host: host, port: port, timeout: timeout) else { return false }
        close(fd)
        return true
    }
}

/// The secret-gate listener probe, byte-for-byte the one `secret-gate bootstrap` sends
/// (packages/secret-gate/secret_gate/proxy_probe.py): an absolute-form request for the loopback discard port
/// carrying a well-formed but undecryptable `enc:v1:` value. Only the gate answers `403` + `X-Secret-Gate: denied`.
public enum GateProbe {
    public enum Verdict: String, Sendable {
        case gate, mitmproxy, otherHTTP = "other-http", notHTTP = "not-http", unreachable
    }

    public struct Result: Sendable, Equatable {
        public let verdict: Verdict
        public let detail: String
        public var isGate: Bool { verdict == .gate }
    }

    public static let token = "enc:v1:" + String(repeating: "A", count: 24)
    static let target = "127.0.0.1:9"
    static let maxHeadBytes = 8192

    public static func request() -> Data {
        Data(("GET http://\(target)/secret-gate-probe HTTP/1.1\r\n"
            + "Host: \(target)\r\n"
            + "X-Secret-Gate-Probe: \(token)\r\n"
            + "Connection: close\r\n\r\n").utf8)
    }

    /// Pure: what answered, from the response head alone.
    public static func classify(_ raw: Data) -> Result {
        let headBytes = raw.range(of: Data("\r\n\r\n".utf8)).map { raw[..<$0.lowerBound] } ?? raw[...]
        let head = String(decoding: headBytes, as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let statusLine = lines.isEmpty ? "" : lines.removeFirst()
        let parts = statusLine.split(separator: " ", maxSplits: 2).map(String.init)
        guard parts.count >= 2, parts[0].hasPrefix("HTTP/1."), let status = Int(parts[1]) else {
            return Result(verdict: .notHTTP, detail: "监听者不说 HTTP/1.x")
        }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            if headers[name] == nil {
                headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
        }
        let server = headers["server"] ?? ""
        if status == 403 && headers["x-secret-gate"]?.lowercased() == "denied" {
            return Result(verdict: .gate, detail: "以 403 X-Secret-Gate: denied 拒绝了探测值")
        }
        if server.lowercased().hasPrefix("mitmproxy") {
            return Result(verdict: .mitmproxy, detail: "没有 secret-gate 插件的 mitmproxy 回了 \(status)（\(server)）")
        }
        return Result(verdict: .otherHTTP, detail: "其他 HTTP 服务回了 \(status)" + (server.isEmpty ? "" : "（Server: \(server)）"))
    }

    /// Blocking; call off the main thread.
    public static func probe(port: Int, host: String = "127.0.0.1", timeout: TimeInterval = 2) -> Result {
        guard let fd = LoopbackSocket.connect(host: host, port: port, timeout: timeout) else {
            return Result(verdict: .unreachable, detail: "\(host):\(port) 没有监听")
        }
        defer { close(fd) }
        guard LoopbackSocket.sendAll(fd, request()) else {
            return Result(verdict: .notHTTP, detail: "连接在发送探测时断开")
        }
        let raw = LoopbackSocket.readHead(fd, limit: maxHeadBytes, timeout: timeout)
        guard !raw.isEmpty else { return Result(verdict: .notHTTP, detail: "监听者没有回应就关闭了连接") }
        return classify(raw)
    }
}
