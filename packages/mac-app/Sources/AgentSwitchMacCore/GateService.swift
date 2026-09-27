import Foundation

/// docs/gate-service-v0.md: the credential gate as two LaunchDaemons under the `_agentswitchgate` role account. The
/// logged-in user reaches it only through the public directory (`gate.sock`, `keys.json`, `ca.pem`); the private keys,
/// the mitmproxy CA key and the refs database sit in `<root>/gate/`, unreadable to this user.
public struct GateServicePaths: Sendable, Equatable {
    public static let defaultRoot = URL(fileURLWithPath: "/Library/Application Support/AgentSwitch")
    /// The role account (§2): no password, no login, not on the login window.
    public static let account = "_agentswitchgate"

    public let root: URL

    public init(root: URL = GateServicePaths.defaultRoot) {
        self.root = root
    }

    public var publicDir: URL { root.appendingPathComponent("gate-public") }
    public var socket: URL { publicDir.appendingPathComponent("gate.sock") }
    public var ca: URL { publicDir.appendingPathComponent("ca.pem") }
    public var keysFile: URL { publicDir.appendingPathComponent("keys.json") }
    /// `{ownerUid, proxyPort, runtimeVersion, installedAt}`, root:wheel 0644: present from the first install step on.
    public var record: URL { root.appendingPathComponent("gate-service.json") }
    /// The service's own home (keys, refs, logs). Only shown as a path; this user cannot list it.
    public var privateDir: URL { root.appendingPathComponent("gate") }
}

/// How the app runs the gate: its own `secret-gate proxy` child (no service installed, today's behaviour) or not at all,
/// leaving it to the system service and passing the public directory to everything that calls the gate.
public enum GateRunMode: Sendable, Equatable {
    case userProcess
    case service(publicDir: URL, proxyPort: Int)

    public var isService: Bool {
        if case .service = self { return true }
        return false
    }

    public var publicDir: URL? {
        if case .service(let dir, _) = self { return dir }
        return nil
    }

    /// The published CA certificate (`SECRET_GATE_CA`); nil for the user process, whose CA is `~/.secret-gate/ca.pem`.
    public var ca: URL? { publicDir?.appendingPathComponent("ca.pem") }
}

/// `secret-gate system status --json` (no root, always exit 0): gate-service.json read, then `status` asked over
/// gate.sock. `runtimeVersion` is `<secret-gate>+<built>` from the runtime's VERSIONS. The CLI also compares it with the
/// runtime it runs from (`updateAvailable`) and says why it is not running (`error`); both optional here.
public struct GateServiceStatus: Sendable, Equatable, Decodable {
    public let installed: Bool
    public let running: Bool
    public let proxyPort: Int?
    public let runtimeVersion: String?
    public let ownerUid: Int?
    public let publicDir: String?
    public let updateAvailable: Bool?
    public let error: String?

    public init(installed: Bool, running: Bool, proxyPort: Int? = nil, runtimeVersion: String? = nil, ownerUid: Int? = nil,
                publicDir: String? = nil, updateAvailable: Bool? = nil, error: String? = nil) {
        self.installed = installed
        self.running = running
        self.proxyPort = proxyPort
        self.runtimeVersion = runtimeVersion
        self.ownerUid = ownerUid
        self.publicDir = publicDir
        self.updateAvailable = updateAvailable
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        installed = try c.require(Bool.self, "installed")
        running = c.first(Bool.self, "running") ?? false
        proxyPort = c.first(Int.self, "proxyPort", "proxy_port")
        runtimeVersion = c.first(String.self, "runtimeVersion", "runtime_version")
        ownerUid = c.first(Int.self, "ownerUid", "owner_uid")
        publicDir = c.first(String.self, "publicDir", "public_dir")
        updateAvailable = c.first(Bool.self, "updateAvailable", "update_available")
        error = c.first(String.self, "error").flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// `<root>/gate-service.json`, read directly: world-readable and owned by root, so no process of this user can make it
/// appear or vanish. It decides "installed" even when the status command cannot run.
public struct GateServiceRecord: Sendable, Equatable, Decodable {
    public let ownerUid: Int?
    public let proxyPort: Int?
    public let runtimeVersion: String?

    public init(ownerUid: Int? = nil, proxyPort: Int? = nil, runtimeVersion: String? = nil) {
        self.ownerUid = ownerUid
        self.proxyPort = proxyPort
        self.runtimeVersion = runtimeVersion
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        ownerUid = c.first(Int.self, "ownerUid", "owner_uid")
        proxyPort = c.first(Int.self, "proxyPort", "proxy_port")
        runtimeVersion = c.first(String.self, "runtimeVersion", "runtime_version")
    }

    /// Nil when the file is absent; a file that exists but does not parse still means installed (empty record).
    public static func read(_ url: URL, fileManager: FileManager = .default) -> GateServiceRecord? {
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        guard let data = try? Data(contentsOf: url), let record = try? JSONDecoder().decode(GateServiceRecord.self, from: data) else {
            return GateServiceRecord()
        }
        return record
    }
}

/// What `system status --json` said, or why it said nothing.
public enum GateServiceStatusOutcome: Sendable, Equatable {
    case status(GateServiceStatus)
    /// The bundled secret-gate predates `system` (argparse: invalid choice).
    case unsupported
    case failed(String)

    public static func interpret(_ result: CommandResult) -> GateServiceStatusOutcome {
        if result.timedOut { return .failed("secret-gate system status 超时") }
        let stderr = result.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard result.ok else {
            if result.status == 2 && stderr.contains("invalid choice") { return .unsupported }
            return .failed(stderr.isEmpty ? "secret-gate system status 退出码 \(result.status)" : stderr)
        }
        do {
            return .status(try JSONDecoder().decode(GateServiceStatus.self, from: result.stdout))
        } catch {
            return .failed("无法解析 secret-gate system status 的输出：\(error.localizedDescription)")
        }
    }
}

/// The service as far as the app knows it: the status command's answer combined with what is on disk.
public struct GateServiceState: Sendable, Equatable {
    public enum Availability: Sendable, Equatable {
        /// Not checked yet.
        case unknown
        /// The bundled secret-gate has no `system` commands, and nothing is installed.
        case unsupported
        case notInstalled
        case installed
    }

    public let availability: Availability
    /// nil when the status command gave no answer.
    public let running: Bool?
    public let socketPresent: Bool
    public let proxyPort: Int?
    public let runtimeVersion: String?
    public let ownerUid: Int?
    /// The status command failed, or said why the service is not running: its reason.
    public let problem: String?
    /// The CLI's own comparison with the runtime it runs from (the App bundle's); nil when it gave none.
    public let updateAvailable: Bool?

    public static let unknown = GateServiceState(availability: .unknown, running: nil, socketPresent: false, proxyPort: nil,
                                                 runtimeVersion: nil, ownerUid: nil, problem: nil)

    public init(availability: Availability, running: Bool?, socketPresent: Bool, proxyPort: Int?, runtimeVersion: String?,
                ownerUid: Int?, problem: String?, updateAvailable: Bool? = nil) {
        self.availability = availability
        self.running = running
        self.socketPresent = socketPresent
        self.proxyPort = proxyPort
        self.runtimeVersion = runtimeVersion
        self.ownerUid = ownerUid
        self.problem = problem
        self.updateAvailable = updateAvailable
    }

    public var isInstalled: Bool { availability == .installed }

    /// Installed for another macOS user: gate.sock turns this one away.
    public func ownedByAnotherUser(uid: Int) -> Bool {
        isInstalled && ownerUid.map { $0 != uid } == true
    }

    /// Service mode as soon as anything says installed: the record, the socket (the CLI's own test) or the status
    /// command. Never the user process while the service is there, even when it does not answer: starting
    /// `secret-gate proxy` as this user would quietly undo the isolation (gate-service-v0 §4).
    public static func evaluate(_ outcome: GateServiceStatusOutcome?, socketPresent: Bool,
                                record: GateServiceRecord?) -> GateServiceState {
        let onDisk = record != nil || socketPresent
        switch outcome {
        case .status(let s):
            let installed = s.installed || onDisk
            return GateServiceState(availability: installed ? .installed : .notInstalled, running: installed ? s.running : false,
                                    socketPresent: socketPresent, proxyPort: s.proxyPort ?? record?.proxyPort,
                                    runtimeVersion: s.runtimeVersion ?? record?.runtimeVersion,
                                    ownerUid: s.ownerUid ?? record?.ownerUid, problem: installed ? s.error : nil,
                                    updateAvailable: installed ? s.updateAvailable : nil)
        case .unsupported:
            return GateServiceState(availability: onDisk ? .installed : .unsupported, running: nil, socketPresent: socketPresent,
                                    proxyPort: record?.proxyPort, runtimeVersion: record?.runtimeVersion,
                                    ownerUid: record?.ownerUid, problem: nil)
        case .failed(let why):
            return GateServiceState(availability: onDisk ? .installed : .notInstalled, running: nil, socketPresent: socketPresent,
                                    proxyPort: record?.proxyPort, runtimeVersion: record?.runtimeVersion,
                                    ownerUid: record?.ownerUid, problem: why)
        case .none:
            return GateServiceState(availability: onDisk ? .installed : .unknown, running: nil, socketPresent: socketPresent,
                                    proxyPort: record?.proxyPort, runtimeVersion: record?.runtimeVersion,
                                    ownerUid: record?.ownerUid, problem: nil)
        }
    }

    /// The service's proxy port wins over the app's setting (it is what the service listens on).
    public func runMode(paths: GateServicePaths, fallbackPort: Int) -> GateRunMode {
        isInstalled ? .service(publicDir: paths.publicDir, proxyPort: proxyPort ?? fallbackPort) : .userProcess
    }
}

/// Reads the facts: the socket and the record from disk, the rest from the bundled CLI.
public enum GateServiceProbe {
    /// Whether anything of an installed service is on disk. Cheap; the supervisors ask it before every launch.
    public static func installedOnDisk(_ paths: GateServicePaths, fileManager: FileManager = .default) -> Bool {
        fileManager.fileExists(atPath: paths.record.path) || fileManager.fileExists(atPath: paths.socket.path)
    }

    public static func detect(cli: GateCLI, paths: GateServicePaths) async -> GateServiceState {
        let outcome = await cli.systemStatus()
        let socket = FileManager.default.fileExists(atPath: paths.socket.path)
        return GateServiceState.evaluate(outcome, socketPresent: socket, record: GateServiceRecord.read(paths.record))
    }
}

/// Whether the App bundle carries another gate program than the one installed (gate-service-v0 §4 程序更新).
public enum GateServiceUpdate {
    /// The bundled runtime's identity from runtime/VERSIONS: `built=` (new on every build), else `secret-gate=`.
    public static func bundledIdentity(_ versions: [String: String]) -> String? {
        [versions["built"], versions["secret-gate"]].compactMap { $0?.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
    }

    /// The bundled runtime as `system install|update` records it: `<secret-gate>+<built>`.
    public static func bundledRuntimeVersion(_ versions: [String: String]) -> String? {
        guard let gate = versions["secret-gate"]?.trimmingCharacters(in: .whitespaces), !gate.isEmpty else { return bundledIdentity(versions) }
        let built = versions["built"]?.trimmingCharacters(in: .whitespaces) ?? ""
        return built.isEmpty ? gate : "\(gate)+\(built)"
    }

    /// `runtimeVersion` is `<secret-gate>+<built>` from `<runtime>/VERSIONS`; it matches when it contains the bundle's
    /// `built=` value (exactly the bare value matches too). Unknown on either side: no update offered.
    public static func isAvailable(installed: String?, bundled versions: [String: String]) -> Bool {
        guard let installed = installed?.trimmingCharacters(in: .whitespaces), !installed.isEmpty,
              let bundled = bundledIdentity(versions) else { return false }
        return installed != bundled && !installed.contains(bundled)
    }
}

/// Consecutive answers of the service (gate.sock present, the proxy passing the bootstrap probe). One miss is not yet
/// "无响应": launchd restarts a crashed service within seconds.
public struct GateServiceHealth: Sendable, Equatable {
    public enum Verdict: Sendable, Equatable { case checking, responding, notResponding }

    public static let missLimit = 2
    public static let initial = GateServiceHealth(checks: 0, misses: 0)

    public let checks: Int
    public let misses: Int

    public init(checks: Int, misses: Int) {
        self.checks = checks
        self.misses = misses
    }

    public func recording(_ ok: Bool) -> GateServiceHealth {
        GateServiceHealth(checks: checks + 1, misses: ok ? 0 : misses + 1)
    }

    public var verdict: Verdict {
        if checks == 0 { return .checking }
        if misses == 0 { return .responding }
        return misses >= GateServiceHealth.missLimit ? .notResponding : .checking
    }
}

/// Trust of the gate CA in the login keychain across the install: the old certificate (its key was readable by this
/// user, gate-service-v0 §5.5) and the regenerated one. Only known when the old one was trusted before installing.
public struct PreviousCATrust: Sendable, Equatable {
    public let oldTrusted: Bool
    public let newTrusted: Bool

    public init(oldTrusted: Bool, newTrusted: Bool) {
        self.oldTrusted = oldTrusted
        self.newTrusted = newTrusted
    }

    /// Nothing left to do: the saved copy of the old certificate can go.
    public var settled: Bool { !oldTrusted && newTrusted }
}
