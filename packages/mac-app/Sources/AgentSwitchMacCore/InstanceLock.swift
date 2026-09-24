import Darwin
import Foundation

/// One AgentSwitch per `AGENTSWITCH_HOME`: an exclusive flock(2) on `run/app.lock`, held for the app's lifetime and
/// dropped by the kernel when the process exits, crash included. Two copies of the app (say build/ and
/// /Applications) would otherwise share the pid files in `run/` and the ports, and stop each other's children.
/// The holder writes its pid into the file so a second copy can hand over to it.
public final class InstanceLock {
    public enum Outcome {
        case acquired(InstanceLock)
        /// Another process holds the lock; its pid when it has written one.
        case held(by: Int32?)
        case failed(String)
    }

    public static let fileName = "app.lock"

    public let url: URL
    private var descriptor: Int32

    private init(url: URL, descriptor: Int32) {
        self.url = url
        self.descriptor = descriptor
    }

    deinit { release() }

    /// Takes the lock without waiting. The descriptor is close-on-exec, so no child ever inherits the lock.
    public static func acquire(at url: URL) -> Outcome {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        } catch {
            return .failed("没能创建 \(url.deletingLastPathComponent().path)：\(error.localizedDescription)")
        }
        let fd = open(url.path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { return .failed("打不开 \(url.path)：\(String(cString: strerror(errno)))") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let reason = errno
            let holder = readPid(fd)
            close(fd)
            if reason == EWOULDBLOCK { return .held(by: holder) }
            return .failed("没能锁住 \(url.path)：\(String(cString: strerror(reason)))")
        }
        // The pid is only a hint for a second copy's hand-over; the lock holds without it.
        let text = Array("\(getpid())\n".utf8)
        _ = ftruncate(fd, 0)
        _ = pwrite(fd, text, text.count, 0)
        return .acquired(InstanceLock(url: url, descriptor: fd))
    }

    /// The pid the current holder wrote, nil when there is none (or no holder).
    public static func holder(of url: URL) -> Int32? {
        let fd = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        return readPid(fd)
    }

    /// Unlocks now instead of at exit (tests; the app keeps the lock until it quits).
    public func release() {
        guard descriptor >= 0 else { return }
        flock(descriptor, LOCK_UN)
        close(descriptor)
        descriptor = -1
    }

    private static func readPid(_ fd: Int32) -> Int32? {
        var buffer = [UInt8](repeating: 0, count: 32)
        let n = pread(fd, &buffer, buffer.count, 0)
        guard n > 0 else { return nil }
        let text = String(decoding: buffer.prefix(n), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return Int32(text).flatMap { $0 > 0 ? $0 : nil }
    }
}
