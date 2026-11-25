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
