import Foundation

/// When the Mac stays awake for AgentSwitch (docs/app-v0.md §4 "有终端开着就不睡"): while work is under way (a task, a
/// terminal at work or waiting for you) or a phone is connected; on mains power, also while a terminal is open, idle or
/// not (you will be back to it, often from the phone); and for `linger` after the last of these, since a task just done
/// or a phone just put away usually means someone comes back soon. On battery an open terminal alone does not count.
public struct AwakePolicy: Equatable, Sendable {
    public static let linger: TimeInterval = 15 * 60

    /// The last time there was a reason to stay awake.
    public private(set) var lastReason: Date?

    public init() {}

    public mutating func wantsAwake(working: Bool, openTerminals: Int, phoneOnline: Bool, onBattery: Bool, at now: Date) -> Bool {
        if working || phoneOnline || (openTerminals > 0 && !onBattery) {
            lastReason = now
            return true
        }
        guard let last = lastReason else { return false }
        if now.timeIntervalSince(last) < Self.linger { return true }
        lastReason = nil
        return false
    }
}
