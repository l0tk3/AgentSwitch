import Foundation

public struct NodeReleaseUpdate: Decodable, Sendable {
    public let current: String
    public let supported: Bool
    public let reason: String?
    public let phase: String
    public let available: String?
    public let staged: String?
    public let error: String?
    public struct Result: Decodable, Sendable {
        public let ok: Bool
        public let reverted: Bool
        public let version: String
        public let error: String?
    }
    public let last: Result?
}
extension DaemonClient {
    public func nodeReleaseUpdate(_ action: String? = nil, version: String? = nil) async throws -> NodeReleaseUpdate {
        let body = try version.map { try JSONEncoder().encode(["version": $0]) }
        return try decode(NodeReleaseUpdate.self, try await call(action == nil ? "GET" : "POST", "/update/release" + (action.map { "/\($0)" } ?? ""), body: body, timeout: 90))
    }
}
