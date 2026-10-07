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

    /// Sessions whose words (prompts and replies) contain `query` (docs/terminal-v0.md §1 搜索); none from a Mac that
    /// cannot search them.
    public func searchSessions(_ query: String) async throws -> [SessionHit] {
        do {
            return (try await get(["sessions", "search"], query: [URLQueryItem(name: "q", value: query)]) as SessionHits).hits
        } catch APIError.http(let status, _) where status == 404 {
            return []
        }
    }

    /// One session and its latest `limit` messages.
    public func session(harness: String, id: String, limit: Int = 80) async throws -> SessionDetail {
        try await get(["sessions", harness, id], query: [URLQueryItem(name: "limit", value: String(limit))])
    }

    /// A session's record for the simple view (docs/simple-view-v0.md §4): the last `limit` items, or the ones before
    /// a page's `cursor`. A Mac from before this route gives the session's messages instead: the same record, coarser
    /// (one line per tool, no changes, no plan).
    public func sessionRecord(harness: String, id: String, limit: Int = 60, before: Int64? = nil) async throws -> SessionRecord {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: String(before))) }
        do {
            return try await get(["sessions", harness, id, "record"], query: query)
        } catch APIError.http(status: 404, message: _) where before == nil {
            return SessionRecord(coarse: try await session(harness: harness, id: id, limit: 200))
        }
    }

    /// What a session changed, file by file: in one run of work (`work`, the item's id), else in its last turn. None
    /// when the Mac has no changes for it (an agent read coarsely, an older Mac).
    public func sessionChanges(harness: String, id: String, work: String? = nil) async throws -> [FileDiff] {
        do {
            return (try await get(["sessions", harness, id, "changes"], query: work.map { [URLQueryItem(name: "work", value: $0)] } ?? []) as FileDiffList).files
        } catch APIError.http(status: 404, message: _) {
            return []
        }
    }

    /// Deletes a session's record on the Mac (terminal-v0 §5): refused while it is open anywhere (409); OpenCode's
    /// cannot be deleted there yet (400).
    public func deleteSession(harness: String, id: String) async throws {
        let _: OKReply = try await perform("DELETE", ["sessions", harness, id], query: [], body: nil)
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
