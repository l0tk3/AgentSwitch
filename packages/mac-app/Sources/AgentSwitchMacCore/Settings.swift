import Foundation

/// Ports the app hands to its children. Defaults follow app-v0 §4; all are editable because a developer's own
/// daemon may already hold 4711/4712 and a hand-started gate 8080.
public struct PortSettings: Codable, Equatable, Sendable {
    public let local: Int      // AGENTSWITCH_PORT, loopback HTTP
    public let remote: Int     // AGENTSWITCH_REMOTE_PORT, TLS for paired devices
    public let gate: Int       // secret-gate proxy
    public let opencode: Int   // AGENTSWITCH_OPENCODE_PORT, the daemon's resident router server

    public static let defaults = PortSettings(local: 4711, remote: 4713, gate: 8080, opencode: 4712)
    public static let validRange = 1024...65535

    public init(local: Int, remote: Int, gate: Int, opencode: Int) {
        self.local = local
        self.remote = remote
        self.gate = gate
        self.opencode = opencode
    }

    public func with(local: Int? = nil, remote: Int? = nil, gate: Int? = nil, opencode: Int? = nil) -> PortSettings {
        PortSettings(local: local ?? self.local, remote: remote ?? self.remote,
                     gate: gate ?? self.gate, opencode: opencode ?? self.opencode)
    }

    /// Named ports in display order.
    public var labelled: [(label: String, port: Int)] {
        [("本地接口", local), ("远程接口", remote), ("凭据网关", gate), ("OpenCode 路由", opencode)]
    }

    /// Human-readable problems; empty means the set can be applied.
    public func problems() -> [String] {
        var out: [String] = []
        for (label, port) in labelled where !PortSettings.validRange.contains(port) {
            out.append("\(label)端口 \(port) 不在 1024–65535 之间")
        }
        let ports = labelled.map(\.port)
        if Set(ports).count != ports.count { out.append("四个端口必须互不相同") }
        return out
    }

    /// Reads from a key-value store, falling back to the defaults key by key (so `-localPort 4811` on the
    /// command line, which lands in the argument domain of UserDefaults, overrides just that one).
    public static func load(_ lookup: (String) -> Int?) -> PortSettings {
        PortSettings(local: lookup(Keys.local) ?? defaults.local,
                     remote: lookup(Keys.remote) ?? defaults.remote,
                     gate: lookup(Keys.gate) ?? defaults.gate,
                     opencode: lookup(Keys.opencode) ?? defaults.opencode)
    }

    public var keyed: [String: Int] {
        [Keys.local: local, Keys.remote: remote, Keys.gate: gate, Keys.opencode: opencode]
    }

    public enum Keys {
        public static let local = "localPort"
        public static let remote = "remotePort"
        public static let gate = "gatePort"
        public static let opencode = "opencodePort"
    }
}

/// How the daemon runs. `executors` / `router` exist for smoke tests (`-executors echo -router echo`);
/// the shipped default is real executors with the daemon's own router choice.
public struct DaemonOptions: Equatable, Sendable {
    public let executors: String
    public let router: String?

    public static let standard = DaemonOptions(executors: "real", router: nil)

    public init(executors: String, router: String?) {
        self.executors = executors
        self.router = router
    }

    public static func load(_ lookup: (String) -> String?) -> DaemonOptions {
        let executors = lookup("executors").flatMap { ["real", "echo"].contains($0) ? $0 : nil } ?? standard.executors
        let router = lookup("router").flatMap { ["opencode", "echo"].contains($0) ? $0 : nil }
        return DaemonOptions(executors: executors, router: router)
    }
}

/// 通用 › 允许 iPhone 连接: the daemon's remote HTTPS listener (`AGENTSWITCH_REMOTE`) and the Bonjour advertisement,
/// on or off together. On by default; off, nothing on the network can reach or discover the daemon, and paired
/// devices stay paired for when it is turned back on.
public enum RemoteAccess {
    public static let key = "remoteAccess"
    public static let defaultValue = true

    public static func load(_ lookup: (String) -> Bool?) -> Bool {
        lookup(key) ?? defaultValue
    }
}
