import Foundation

/// control-v0's routes: the permission mode and default folder (read-only on the phone), the Mac's coding sessions,
/// marking a task read, and search.
extension AgentSwitchAPI {
    public func approvalPolicy() async throws -> ApprovalPolicyInfo { try await get(["approvals", "policy"]) }

    public func workdir() async throws -> WorkdirSetting { try await get(["settings", "workdir"]) }

    /// Claude Code, Codex and OpenCode sessions on the Mac, newest first.
    public func sessions(limit: Int = 60) async throws -> [SessionSummary] {
        (try await get(["sessions"], query: [URLQueryItem(name: "limit", value: String(limit))]) as SessionList).sessions
    }

    /// One session and its latest `limit` messages.
    public func session(harness: String, id: String, limit: Int = 80) async throws -> SessionDetail {
        try await get(["sessions", harness, id], query: [URLQueryItem(name: "limit", value: String(limit))])
    }

    /// Records the task as read now; returns the time the Mac recorded, when it says.
    @discardableResult
    public func acknowledge(taskId: String) async throws -> Int64? {
        (try await post(["tasks", taskId, "ack"], body: EmptyBody()) as AckReply).acknowledgedAt
    }

    public func search(query: String, limit: Int = 30) async throws -> [SearchResult] {
        let items = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: String(limit))]
        return (try await get(["search"], query: items) as SearchResults).results
    }
}
