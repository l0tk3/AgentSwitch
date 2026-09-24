import Foundation

/// Where "a task needs you / a task finished" goes. Push is out of scope for v0 (app-v0 §5): the app refreshes live over
/// SSE while open, and this is the seam a later APNs or local-notification sink plugs into.
public protocol NotificationSink: Sendable {
    func needsAttention(taskId: String, approval: Approval) async
    func finished(task: AgentTask) async
}

/// v0: drops everything.
public struct NoNotifications: NotificationSink {
    public init() {}
    public func needsAttention(taskId: String, approval: Approval) async {}
    public func finished(task: AgentTask) async {}
}
