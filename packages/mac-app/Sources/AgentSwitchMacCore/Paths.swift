import Foundation

/// The bundled runtime under `AgentSwitch.app/Contents/Resources/runtime` (docs/app-v0.md §4 打包).
public struct RuntimeLayout: Sendable, Equatable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    public var node: URL { root.appendingPathComponent("node/bin/node") }
    public var daemonDir: URL { root.appendingPathComponent("daemon") }
    public var daemonCLI: URL { daemonDir.appendingPathComponent("dist/cli.js") }
    public var pythonBin: URL { root.appendingPathComponent("python/bin") }
    /// Wrapper script that runs `python -m secret_gate.cli`, so no shebang hard-codes the build path.
    public var secretGate: URL { pythonBin.appendingPathComponent("secret-gate") }
    /// Written by scripts/build-app.sh: one `name=version` line per component.
    public var versionsFile: URL { root.appendingPathComponent("VERSIONS") }
    /// The AgentSwitch.app this runtime is inside; nil for a development runtime elsewhere (no bundle to update).
    public var appBundle: URL? {
        let parts = root.standardizedFileURL.pathComponents
        guard parts.suffix(3) == ["Contents", "Resources", "runtime"], parts.count > 3, parts[parts.count - 4].hasSuffix(".app") else { return nil }
        return root.standardizedFileURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    /// Pieces that are absent, as display paths; empty means the runtime is complete.
    public func missing(fileManager: FileManager = .default) -> [String] {
        [node, daemonCLI, secretGate]
            .filter { !fileManager.isExecutableFile(atPath: $0.path) && !fileManager.fileExists(atPath: $0.path) }
            .map(\.path)
    }

    /// `name=version` lines of the VERSIONS file.
    public func versions(fileManager: FileManager = .default) -> [String: String] {
        guard let text = try? String(contentsOf: versionsFile, encoding: .utf8) else { return [:] }
        return RuntimeLayout.parseVersions(text)
    }

    public static func parseVersions(_ text: String) -> [String: String] {
        var out: [String: String] = [:]
        for line in text.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.count == 2, !parts[0].isEmpty { out[parts[0]] = parts[1] }
        }
        return out
    }
}

/// Every location the app reads or writes. Environment overrides exist so a smoke test can run the real app
/// against throw-away homes without touching the user's own (`AGENTSWITCH_HOME`, `SECRET_GATE_HOME`,
/// `AGENTSWITCH_APP_LOGS`). Pointing the app at another runtime (`AGENTSWITCH_APP_RUNTIME`, the `runtimeRoot` user
/// default) is for development only: a Release build always runs the runtime inside its own signed bundle.
public struct AppPaths: Sendable, Equatable {
    public let userHome: URL
    public let agentswitchHome: URL
    public let gateHome: URL
    public let logsDir: URL
    public let runtime: RuntimeLayout
    /// The system service (docs/gate-service-v0.md §2), `/Library/Application Support/AgentSwitch`.
    public let gateService: GateServicePaths

    public init(userHome: URL, agentswitchHome: URL, gateHome: URL, logsDir: URL, runtime: RuntimeLayout,
                gateService: GateServicePaths = GateServicePaths()) {
        self.userHome = userHome
        self.agentswitchHome = agentswitchHome
        self.gateHome = gateHome
        self.logsDir = logsDir
        self.runtime = runtime
        self.gateService = gateService
    }

    public static let homeOverride = "AGENTSWITCH_HOME"
    public static let gateHomeOverride = "SECRET_GATE_HOME"
    public static let logsOverride = "AGENTSWITCH_APP_LOGS"
    public static let runtimeOverride = "AGENTSWITCH_APP_RUNTIME"
    /// A service installed with `system install --root <prefix>` (development). Debug builds only, like the runtime:
    /// in Release a same-user process could otherwise point the app, and the daemon after it, at a public directory
    /// with keys of its own.
    public static let gateServiceRootOverride = "AGENTSWITCH_GATE_SERVICE_ROOT"

    /// Defaults from app-v0 §4, each replaceable by its environment variable. With `allowRuntimeOverride` (Debug
    /// builds only; the app decides with `#if DEBUG`) `runtimeRoot` (a user default) wins over the bundle and
    /// `AGENTSWITCH_APP_RUNTIME` over both; without it both are ignored. A user default persists and any process of
    /// the user can write it, so honouring it in Release would let one point the app, and every later login-item
    /// launch, at a runtime of its choosing.
    public static func resolve(environment env: [String: String], userHome: URL, bundleResources: URL?,
                               runtimeRoot: String? = nil, allowRuntimeOverride: Bool = false) -> AppPaths {
        func dir(_ key: String, _ fallback: URL) -> URL {
            guard let value = env[key], !value.isEmpty else { return fallback }
            return URL(fileURLWithPath: NSString(string: value).expandingTildeInPath)
        }
        let library = userHome.appendingPathComponent("Library")
        let bundled = (bundleResources ?? URL(fileURLWithPath: "/nonexistent")).appendingPathComponent("runtime")
        let runtime: URL
        let serviceRoot: URL
        if allowRuntimeOverride {
            let preferred = runtimeRoot.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: NSString(string: $0).expandingTildeInPath) } ?? bundled
            runtime = dir(runtimeOverride, preferred)
            serviceRoot = dir(gateServiceRootOverride, GateServicePaths.defaultRoot)
        } else {
            runtime = bundled
            serviceRoot = GateServicePaths.defaultRoot
        }
        return AppPaths(
            userHome: userHome,
            agentswitchHome: dir(homeOverride, library.appendingPathComponent("Application Support/AgentSwitch")),
            gateHome: dir(gateHomeOverride, userHome.appendingPathComponent(".secret-gate")),
            logsDir: dir(logsOverride, library.appendingPathComponent("Logs/AgentSwitch")),
            runtime: RuntimeLayout(root: runtime),
            gateService: GateServicePaths(root: serviceRoot)
        )
    }

    public var runDir: URL { agentswitchHome.appendingPathComponent("run") }
    public var daemonLog: URL { logsDir.appendingPathComponent("daemon.log") }
    public var gateLog: URL { logsDir.appendingPathComponent("gate.log") }
    public var daemonPidFile: URL { runDir.appendingPathComponent("daemon.pid") }
    public var gatePidFile: URL { runDir.appendingPathComponent("gate.pid") }
    /// Held by the one running copy of the app for this home (InstanceLock).
    public var appLockFile: URL { runDir.appendingPathComponent(InstanceLock.fileName) }
    /// The copy harness configs point at (`secret-gate install-ca` writes the same file). The user process's CA; in
    /// service mode see `gateCA(in:)`.
    public var gateCA: URL { gateHome.appendingPathComponent("ca.pem") }
    /// The CA executors trust: the published `gate-public/ca.pem` in service mode (never synced from ~/.mitmproxy).
    public func gateCA(in mode: GateRunMode) -> URL { mode.ca ?? gateCA }
    /// A copy of the gate CA this user had trusted before the service regenerated it, for 移除 (gate-service-v0 §5.5).
    public var previousGateCA: URL { agentswitchHome.appendingPathComponent("gate-previous-ca.pem") }
    /// mitmproxy writes its CA here on the proxy's first start, independent of SECRET_GATE_HOME.
    public var mitmproxyCA: URL { userHome.appendingPathComponent(".mitmproxy/mitmproxy-ca-cert.pem") }
    /// Written by the daemon (`PUT /settings/models`), merged over targets.yaml at start.
    public var modelsOverride: URL { agentswitchHome.appendingPathComponent("models.json") }

    /// Creates the writable directories with owner-only permissions.
    public func prepareDirectories(fileManager: FileManager = .default) throws {
        for url in [agentswitchHome, runDir, logsDir] {
            try fileManager.createDirectory(at: url, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
        }
    }
}
