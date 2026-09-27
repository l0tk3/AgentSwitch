import Foundation

/// A coding session on the Mac, outside AgentSwitch (control-v0 §3): Claude Code, Codex or OpenCode, read from their own
/// local records by the daemon. Every field but the harness and id is optional on the wire, so one odd record never
/// empties the list.
public struct SessionSummary: Decodable, Sendable, Hashable, Identifiable {
    public let harness: String
    public let sessionId: String
    public let cwd: String
    public let title: String
    public let lastText: String
    public let updatedAt: Int64
    /// Updated within the last 90 seconds (the daemon decides).
    public let active: Bool
    /// Codex's originator: desktop, command line, editor.
    public let origin: String?
    public let branch: String?
    public let model: String?

    public init(harness: String, id: String, cwd: String, title: String, lastText: String = "", updatedAt: Int64, active: Bool = false,
                origin: String? = nil, branch: String? = nil, model: String? = nil) {
        self.harness = harness
        self.sessionId = id
        self.cwd = cwd
        self.title = title
        self.lastText = lastText
        self.updatedAt = updatedAt
        self.active = active
        self.origin = origin
        self.branch = branch
        self.model = model
    }

    /// Unique across harnesses (two tools could reuse an id).
    public var id: String { "\(harness)/\(sessionId)" }
    public var updated: Date { Date(milliseconds: updatedAt) }
    public var harnessName: String { ModelName.harness(harness) }
    /// The title, else the start of the last text, else a plain placeholder.
    public var displayTitle: String {
        let firstLine = { (s: String) in s.split(separator: "\n").first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? "" }
        let title = firstLine(self.title)
        if !title.isEmpty { return title }
        let last = firstLine(lastText)
        return last.isEmpty ? "未命名会话" : last
    }

    private enum CodingKeys: String, CodingKey { case harness, id, cwd, title, lastText, updatedAt, active, origin, branch, model }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        harness = try c.decode(String.self, forKey: .harness)
        sessionId = try c.decode(String.self, forKey: .id)
        cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        lastText = (try? c.decodeIfPresent(String.self, forKey: .lastText)) ?? ""
        updatedAt = (try? c.decodeIfPresent(Int64.self, forKey: .updatedAt)) ?? 0
        active = (try? c.decodeIfPresent(Bool.self, forKey: .active)) ?? false
        origin = try? c.decodeIfPresent(String.self, forKey: .origin)
        branch = try? c.decodeIfPresent(String.self, forKey: .branch)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
    }
}

/// One message of a session's transcript.
public struct SessionMessage: Decodable, Sendable, Hashable {
    public enum Role: String, Sendable {
        case user, assistant, tool, other
    }

    public let role: Role
    public let text: String
    public let ts: Int64
    /// The tool's name, for `tool` messages.
    public let tool: String?

    public init(role: Role, text: String, ts: Int64, tool: String? = nil) {
        self.role = role
        self.text = text
        self.ts = ts
        self.tool = tool
    }

    public var date: Date { Date(milliseconds: ts) }

    private enum CodingKeys: String, CodingKey { case role, text, ts, tool }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = Role(rawValue: (try? c.decodeIfPresent(String.self, forKey: .role)) ?? "") ?? .other
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        ts = (try? c.decodeIfPresent(Int64.self, forKey: .ts)) ?? 0
        tool = try? c.decodeIfPresent(String.self, forKey: .tool)
    }
}

/// `GET /sessions/:harness/:id`: the session and its latest messages, oldest first.
public struct SessionDetail: Decodable, Sendable, Hashable {
    public let session: SessionSummary
    public let messages: [SessionMessage]

    public init(session: SessionSummary, messages: [SessionMessage]) {
        self.session = session
        self.messages = messages
    }

    private enum CodingKeys: String, CodingKey { case session, messages }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = try c.decode(SessionSummary.self, forKey: .session)
        messages = ((try? c.decodeIfPresent([SessionMessage].self, forKey: .messages)) ?? []).sorted { $0.ts < $1.ts }
    }
}

struct SessionList: Decodable {
    let sessions: [SessionSummary]
}

/// The sessions screen's order: one group per folder, the folder with the latest activity first, each group newest
/// first.
public enum SessionGroups {
    public struct Group: Sendable, Hashable, Identifiable {
        public let folder: String
        public let sessions: [SessionSummary]
        public var id: String { folder }
    }

    public static func grouped(_ sessions: [SessionSummary]) -> [Group] {
        let newestFirst = sessions.sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }
        var order: [String] = []
        var byFolder: [String: [SessionSummary]] = [:]
        for session in newestFirst {
            if byFolder[session.cwd] == nil { order.append(session.cwd) }
            byFolder[session.cwd, default: []].append(session)
        }
        return order.map { Group(folder: $0, sessions: byFolder[$0] ?? []) }
    }
}
