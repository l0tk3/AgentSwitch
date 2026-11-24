import Foundation

/// The new dispatch (2026-11-24, daemon `api/dispatchDesk.ts`): a session on the agent, profile and model the user
/// picks, seated as admin in the 调度台 room. What the user chose, and how it stands.
public struct DispatchDesk: Decodable, Equatable, Sendable {
    public struct Settings: Codable, Equatable, Sendable {
        public var on: Bool
        public var agent: String
        public var profile: String?
        public var model: String?
        /// The permission mode of the dispatch and of the sessions it starts: `manual`, `auto` or `bypass`.
        public var mode: String
        public var maxStarted: Int

        public init(on: Bool, agent: String, profile: String?, model: String?, mode: String, maxStarted: Int) {
            self.on = on; self.agent = agent; self.profile = profile; self.model = model; self.mode = mode; self.maxStarted = maxStarted
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(on, forKey: .on); try c.encode(agent, forKey: .agent)
            // nil is said as null: "the profile's own" / "the agent's default".
            try c.encode(profile, forKey: .profile); try c.encode(model, forKey: .model)
            try c.encode(mode, forKey: .mode); try c.encode(maxStarted, forKey: .maxStarted)
        }
    }
    public struct Terminal: Decodable, Equatable, Sendable { public let id: String; public let status: String; public let model: String? }

    public let settings: Settings
    public let folder: String
    public let instructions: String
    public let room: String?
    public let terminal: Terminal?
    public let problem: String?
    public let replacing: Bool

    /// How it stands, in a few words.
    public var state: String {
        if replacing { return "正在交接，换新的调度…" }
        if let problem { return problem }
        guard settings.on else { return "已关闭" }
        switch terminal?.status {
        case "working": return "工作中"
        case "waiting": return "等你处理"
        case "idle": return "空闲，在调度台等你说话"
        case "exited", nil: return "正在启动…"
        default: return terminal?.status ?? ""
        }
    }
}

public extension DaemonClient {
    func dispatchDesk() async throws -> DispatchDesk { try decode(DispatchDesk.self, try await call("GET", "/dispatch/desk", timeout: 10)) }

    func setDispatchDesk(_ settings: DispatchDesk.Settings) async throws -> DispatchDesk {
        try decode(DispatchDesk.self, try await call("PUT", "/dispatch/desk", body: try JSONEncoder().encode(settings), timeout: 60))
    }

    func replaceDispatch() async throws { _ = try await call("POST", "/dispatch/desk/replace", timeout: 10) }

    private struct Instructions: Decodable { let text: String }
    func dispatchInstructions() async throws -> String { try decode(Instructions.self, try await call("GET", "/dispatch/desk/instructions", timeout: 10)).text }
    func setDispatchInstructions(_ text: String) async throws {
        _ = try await call("PUT", "/dispatch/desk/instructions", body: try JSONSerialization.data(withJSONObject: ["text": text]), timeout: 10)
    }
}
