import Foundation

/// `GET /settings/workdir` (control-v0 §2): where a task without a folder works. `default` is read either way the
/// daemon may send it: the default path, or whether `path` is the default.
public struct WorkdirSetting: Decodable, Sendable, Hashable {
    public let path: String
    public let defaultPath: String?
    public let isDefault: Bool
    /// Why the folder cannot be used right now (missing, not writable…); nil when it can.
    public let problem: String?

    public init(path: String, defaultPath: String? = nil, isDefault: Bool = false, problem: String? = nil) {
        self.path = path
        self.defaultPath = defaultPath
        self.isDefault = isDefault || defaultPath == path
        self.problem = problem
    }

    private enum CodingKeys: String, CodingKey { case path, `default`, problem }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let path = try c.decode(String.self, forKey: .path)
        let fallback = try? c.decodeIfPresent(JSONValue.self, forKey: .default)
        let problem = (try? c.decodeIfPresent(String.self, forKey: .problem)).flatMap { $0.isEmpty ? nil : $0 }
        self.init(path: path, defaultPath: fallback?.string, isDefault: fallback?.bool ?? false, problem: problem)
    }
}
