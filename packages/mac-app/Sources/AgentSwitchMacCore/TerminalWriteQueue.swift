import Foundation

/// What is typed on a terminal screen on its way to the service (`POST /terminals/:id/write`; docs/app-v0.md §4
/// 省电第二轮, 2026-10-05). One request is under way at a time; what is typed meanwhile waits and goes together in the
/// next. Typing alone is as before — a key goes at once. A pointer crossing an agent's screen with mouse tracking on
/// sends a report for every cell: those reach the service a request at a time, each carrying what gathered, instead of
/// a request each.
public struct TerminalWriteQueue: Sendable {
    private var waiting: [UInt8] = []
    private var underWay = false

    public init() {}

    public mutating func add<Bytes: Sequence>(_ bytes: Bytes) where Bytes.Element == UInt8 {
        waiting.append(contentsOf: bytes)
    }

    /// What to send now: everything that waits, unless a request is under way (its end asks again) or nothing waits.
    /// The caller sends it and calls `sent()` when the request is over, however it ended.
    public mutating func next() -> String? {
        guard !underWay, let text = take() else { return nil }
        underWay = true
        return text
    }

    /// The request `next()` gave is over.
    public mutating func sent() {
        underWay = false
    }

    /// Everything that waits, to go now whatever is under way: something that must come after it follows (a named
    /// key). The caller sends it in order behind the request under way; `sent()` is not for this one.
    public mutating func drain() -> String? {
        take()
    }

    /// Another terminal, or none: what waited was for the one before.
    public mutating func drop() {
        waiting.removeAll(keepingCapacity: true)
    }

    private mutating func take() -> String? {
        guard !waiting.isEmpty else { return nil }
        let text = String(decoding: waiting, as: UTF8.self)
        waiting.removeAll(keepingCapacity: true)
        return text
    }
}
