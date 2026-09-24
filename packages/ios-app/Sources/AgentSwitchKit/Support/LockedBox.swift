import Foundation
import os

/// A value behind an unfair lock, for the few places callback-based system APIs (URLSession delegates, Network.framework
/// handlers) need shared mutable state across threads.
final class LockedBox<Value: Sendable>: Sendable {
    private let lock: OSAllocatedUnfairLock<Value>

    init(_ value: Value) { lock = OSAllocatedUnfairLock(initialState: value) }

    func withLock<R: Sendable>(_ body: @Sendable (inout Value) -> R) -> R { lock.withLock(body) }

    var value: Value { lock.withLock { $0 } }
}
