import AgentSwitchMacCore
import AppKit
import Foundation
import Observation
import SystemConfiguration

/// App state and the runtime: two supervised children (gate, daemon), a poll loop, Bonjour, environment checks.
/// Everything the views show lives here; every mutation replaces whole values.
@MainActor
@Observable
final class AppModel {
    // MARK: configuration

    let paths: AppPaths
    let options: DaemonOptions
    let computerName: String
    private(set) var ports: PortSettings
    /// 通用 › 允许 iPhone 连接 (RemoteAccess): the daemon's remote listener and the Bonjour advertisement.
    private(set) var remoteEnabled: Bool
    private let baseEnvironment: [String: String]

    // MARK: runtime state

    private(set) var gateState = SupervisorState.initial
    private(set) var daemonState = SupervisorState.initial
    private(set) var gateHealthy = false
    private(set) var daemonReady = false
    private(set) var remote: RemoteInfo?
    private(set) var remoteProblem: String?
    private(set) var devices: [Device] = []
    private(set) var loginPath: LoginShellPath.Resolution?
    private(set) var harnesses: [HarnessReport] = []
    private(set) var tailscale: TailscaleStatus?
    private(set) var caCopy: GateCA.CopyResult?
    private(set) var caTrusted = false
    private(set) var keys: [Keypair] = []
    private(set) var bonjourStatus = StatusLine("未发布", .off)
    private(set) var detecting = false
    /// First-run facts worth telling once (keypair created, CA copied).
    private(set) var notices: [String] = []
    /// The build time of a newer AgentSwitch.app staged next to this one (assistant-v0 §5), if any.
    private(set) var stagedUpdate: String?
    /// Folders a phone task may run in (assistant-v0 §5), as the daemon has them.
    private(set) var projects: [ProjectEntry] = []
    /// An install is being checked or started: a second request waits for its outcome.
    @ObservationIgnored private var installing = false
    var errorMessage: String?
    let pairingSession = PairingSession()

    // MARK: plumbing

    @ObservationIgnored private let config: Locked<RuntimeConfig>
    @ObservationIgnored private var gate: ProcessSupervisor!
    @ObservationIgnored private var daemon: ProcessSupervisor!
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private let bonjour = BonjourAdvertiser()
    @ObservationIgnored private var gateMisses = 0
    @ObservationIgnored private var daemonMisses = 0
    static let pollInterval: Duration = .seconds(3)
    /// Consecutive failed checks before a running child is restarted (after its start-up grace).
    static let gateMissLimit = 5
    static let daemonMissLimit = 10
    /// The daemon discovers models before it listens; a Claude CLI that waits on a Keychain prompt takes its full
    /// 30 s discovery timeout, so the grace must cover that plus start-up.
    static let startupGrace: TimeInterval = 120

    /// `-runtimeRoot` / `AGENTSWITCH_APP_RUNTIME` point a development build (`swift run`, Xcode Debug) at a runtime
    /// outside the bundle. A Release build ignores both and runs only the runtime it was signed with (AppPaths).
    #if DEBUG
    static let allowsRuntimeOverride = true
    #else
    static let allowsRuntimeOverride = false
    #endif

    init() {
        let defaults = UserDefaults.standard
        let env = ProcessInfo.processInfo.environment
        let home = URL(fileURLWithPath: NSHomeDirectory())
        let paths = AppPaths.resolve(environment: env, userHome: home, bundleResources: Bundle.main.resourceURL,
                                     runtimeRoot: defaults.string(forKey: "runtimeRoot"),
                                     allowRuntimeOverride: AppModel.allowsRuntimeOverride)
        let options = DaemonOptions.load { defaults.string(forKey: $0) }
        let ports = PortSettings.load { defaults.object(forKey: $0) == nil ? nil : defaults.integer(forKey: $0) }
        let remoteEnabled = RemoteAccess.load { defaults.object(forKey: $0) == nil ? nil : defaults.bool(forKey: $0) }
        // The Finder name, what the daemon itself would pick (`scutil --get ComputerName`).
        let name = (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? Host.current().localizedName ?? "Mac"
        let base = ChildEnvironment.base(from: env, userHome: home)
        self.paths = paths
        self.options = options
        self.ports = ports
        self.remoteEnabled = remoteEnabled
        computerName = name
        baseEnvironment = base
        config = Locked(RuntimeConfig(paths: paths, ports: ports, options: options, path: LoginShellPath.merge(shellPath: nil, home: home.path),
                                      baseEnvironment: base, remoteName: name, remoteEnabled: remoteEnabled))
        let box = config
        gate = ProcessSupervisor(name: "gate", preflight: { await RuntimePreflight.gate(box.get()) },
                                 observer: { [weak self] s in Task { @MainActor in self?.gateChanged(s) } })
        daemon = ProcessSupervisor(name: "daemon", preflight: { await RuntimePreflight.daemon(box.get()) },
                                   observer: { [weak self] s in Task { @MainActor in self?.daemonChanged(s) } })
        bonjour.onStatus = { [weak self] line in self?.bonjourStatus = line }
    }

    var client: DaemonClient { DaemonClient(port: ports.local) }
    var gateCLI: GateCLI { config.get().gateCLI }

    // MARK: status lines

    var gateLine: StatusLine { StatusText.gate(gateState, healthy: gateHealthy, port: ports.gate) }
    var daemonLine: StatusLine { StatusText.daemon(daemonState, ready: daemonReady, port: ports.local) }
    var remoteLine: StatusLine { StatusText.remote(remote, problem: remoteProblem, daemonReady: daemonReady, enabled: remoteEnabled) }
    var devicesLine: StatusLine { StatusText.devices(devices, online: remote?.onlineDevices) }
    var bonjourLine: StatusLine { StatusText.bonjour(bonjourStatus, remoteEnabled: remoteEnabled) }
    var overallLevel: StatusLevel { StatusText.overall([gateLine, daemonLine]) }
    var lanAddresses: [String] { remote?.lan.isEmpty == false ? remote!.lan : NetworkAddresses.lanIPv4() }
    var tailnetAddresses: [String] { remote?.tailnet ?? [] }
    var activeDevices: [Device] { devices.filter { !$0.isRevoked } }

    // MARK: lifecycle

    /// First run and every launch: login PATH, gate (keypair on first run), then the daemon, then polling.
    func launch() {
        Task {
            do {
                try paths.prepareDirectories()
            } catch {
                errorMessage = "没能创建目录：\(error.localizedDescription)"
            }
            let resolution = await LoginShellPath.resolve(shell: baseEnvironment["SHELL"], home: paths.userHome.path,
                                                          base: baseEnvironment)
            loginPath = resolution
            config.set(makeConfig(ports: ports, path: resolution.path))
            await ensureKeypair()
            await gate.start()
            _ = await waitFor(seconds: 20) { self.gateState.isServing && self.gateHealthy || self.gateState.phase.isFailed }
            await daemon.start()
            startPolling()
            detectEnvironment()
            refreshKeys()
        }
    }

    func shutdown() async {
        pollTask?.cancel()
        bonjour.update(nil)
        await daemon.stop()
        await gate.stop()
    }

    func restartAll() {
        Task {
            await gate.restart()
            _ = await waitFor(seconds: 20) { self.gateState.isServing && self.gateHealthy || self.gateState.phase.isFailed }
            await daemon.restart()
        }
    }

    func restartDaemon() {
        daemonReady = false
        Task { await daemon.restart() }
    }

    /// New ports take effect by restarting both children (the daemon also points at the gate port).
    func applyPorts(_ next: PortSettings) {
        let defaults = UserDefaults.standard
        for (key, value) in next.keyed { defaults.set(value, forKey: key) }
        ports = next
        config.set(makeConfig(ports: next, path: config.get().path))
        remote = nil
        restartAll()
    }

    /// 允许 iPhone 连接: persisted, then the daemon restarts with `AGENTSWITCH_REMOTE` set to match. Bonjour stops at
    /// once when turned off; it comes back on the first poll after the daemon reports its remote listener.
    func setRemoteAccess(_ on: Bool) {
        guard on != remoteEnabled else { return }
        UserDefaults.standard.set(on, forKey: RemoteAccess.key)
        remoteEnabled = on
        config.set(makeConfig(ports: ports, path: config.get().path))
        remote = nil
        remoteProblem = nil
        bonjour.update(nil)
        pairingSession.reset()
        restartDaemon()
    }

    private func makeConfig(ports: PortSettings, path: String) -> RuntimeConfig {
        let opencode = ExecutableLookup.find("opencode", path: path, extra: Harness.opencode.knownLocations(home: paths.userHome.path))
        let claude = ExecutableLookup.find("claude", path: path, extra: Harness.claude.knownLocations(home: paths.userHome.path))
        return RuntimeConfig(paths: paths, ports: ports, options: options, path: path, baseEnvironment: baseEnvironment,
                             remoteName: computerName, opencodeBinary: opencode, claudeBinary: claude, remoteEnabled: remoteEnabled)
    }

    private func gateChanged(_ s: SupervisorState) {
        if !s.isServing { gateHealthy = false }
        gateState = s
    }

    private func daemonChanged(_ s: SupervisorState) {
        if !s.isRunning {
            daemonReady = false
            remote = nil
            bonjour.update(nil)
            pairingSession.reset()
        }
        daemonState = s
    }

    private func waitFor(seconds: TimeInterval, _ condition: @MainActor () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            await pollGate()
            try? await Task.sleep(for: .milliseconds(300))
        }
        return condition()
    }

    // MARK: polling

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollOnce()
                try? await Task.sleep(for: AppModel.pollInterval)
            }
        }
    }

    func pollOnce() async {
        await pollGate()
        await pollDaemon()
        pollUpdate()
    }

    // MARK: - updates (assistant-v0 §5)

    /// A staged newer bundle, and the phone's go-ahead to install it (the daemon leaves a request file).
    private func pollUpdate() {
        guard let app = paths.runtime.appBundle else { return }
        stagedUpdate = AppUpdate.newerStaged(than: app)
        let request = paths.agentswitchHome.appendingPathComponent(AppUpdate.requestFile)
        guard FileManager.default.fileExists(atPath: request.path) else { return }
        try? FileManager.default.removeItem(at: request)
        if stagedUpdate != nil { Task { await installUpdate() } }
    }

    /// The switch, all done by this app (macOS lets it touch its own folder; a helper left behind after it quit was held
    /// by the privacy checks): stop the children, swap the bundles, start the new copy and wait, hidden, for its daemon.
    /// It answers: this copy quits. It does not: this copy stops it, puts itself back and starts again. Nothing changes
    /// when the folder check fails; the reason goes to the menu and, through the daemon, to the conversation.
    func installUpdate() async {
        guard let app = paths.runtime.appBundle, let staged = stagedUpdate, !installing else { return }
        installing = true
        defer { installing = false }
        let from = AppUpdate.built(app)
        if let problem = await AppUpdate.folderAccessProblem(app: app) {
            errorMessage = problem
            writeUpdateResult(ok: false, reverted: false, from: from, to: staged, reason: problem)
            return
        }
        await shutdown()
        releaseInstance()
        // Off the main thread with a deadline: a move macOS holds must not freeze the app with the services stopped.
        let giveUp = GiveUp()
        switch await AppUpdate.offMain(wait: AppUpdate.accessWait * 4, { try AppUpdate.swapIn(app: app, proceed: { giveUp.proceed }) }) {
        case .done: break
        case .failed(let error):
            writeUpdateResult(ok: false, reverted: false, from: from, to: staged, reason: "换版没做成：\(error.localizedDescription)")
            return await restart(app)
        case .timedOut:
            giveUp.now()
            writeUpdateResult(ok: false, reverted: false, from: from, to: staged, reason: "macOS 挡住了换版（App 管理权限？）")
            return await restart(app)
        }
        updating = true
        let started = try? await launchCopy(of: app)
        if started != nil, await newDaemonAnswers() {
            writeUpdateResult(ok: true, reverted: false, from: from, to: staged, reason: "")
            return exitApp()
        }
        if let started { await stopCopy(started, bundle: app) }
        let giveUpBack = GiveUp()
        let back = await AppUpdate.offMain(wait: AppUpdate.accessWait * 4, { try AppUpdate.swapBack(app: app, proceed: { giveUpBack.proceed }) })
        if case .timedOut = back { giveUpBack.now() }
        switch back {
        case .done:
            writeUpdateResult(ok: false, reverted: true, from: from, to: staged,
                              reason: "新版本 \(AppUpdate.healthWait) 秒内没有起来（本机端口 \(ports.local)），已留作 failed-AgentSwitch.app")
        case .failed(let error):
            writeUpdateResult(ok: false, reverted: false, from: from, to: staged, reason: "新版本没起来，退回也失败了：\(error.localizedDescription)")
        case .timedOut:
            writeUpdateResult(ok: false, reverted: false, from: from, to: staged, reason: "新版本没起来，退回被 macOS 挡住了")
        }
        await restart(app)
    }

    /// Set by the app delegate: frees the single-instance lock for the copy about to start, and quits once the
    /// children are already stopped.
    @ObservationIgnored var releaseInstance: @MainActor () -> Void = {}
    @ObservationIgnored var exitApp: @MainActor () -> Void = {}
    /// Hides the menu bar item while this copy only waits on the new one.
    private(set) var updating = false

    private func writeUpdateResult(ok: Bool, reverted: Bool, from: String?, to: String?, reason: String) {
        try? AppUpdate.result(ok: ok, reverted: reverted, from: from, to: to, reason: reason)
            .write(to: paths.agentswitchHome.appendingPathComponent(AppUpdate.resultFile), options: .atomic)
    }

    /// A second copy of the app at `bundle`, while this one still runs (same bundle id: a new instance).
    private func launchCopy(of bundle: URL) async throws -> NSRunningApplication {
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.activates = false
        return try await NSWorkspace.shared.openApplication(at: bundle, configuration: config)
    }

    private func newDaemonAnswers() async -> Bool {
        let client = client
        let deadline = Date().addingTimeInterval(TimeInterval(AppUpdate.healthWait))
        while Date() < deadline {
            if (try? await client.health())?.ok == true { return true }
            try? await Task.sleep(for: .seconds(2))
        }
        return false
    }

    /// The new copy's orderly quit (it stops its children), then force; then anything still running from its bundle.
    private func stopCopy(_ copy: NSRunningApplication, bundle: URL) async {
        copy.terminate()
        for _ in 0..<20 where !copy.isTerminated { try? await Task.sleep(for: .milliseconds(500)) }
        if !copy.isTerminated { copy.forceTerminate() }
        let pkill = Process()
        pkill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        pkill.arguments = ["-9", "-f", bundle.path + "/Contents/"]
        try? pkill.run()
        pkill.waitUntilExit()
    }

    /// Whatever is at `bundle` now starts afresh; this copy leaves.
    private func restart(_ bundle: URL) async {
        _ = try? await launchCopy(of: bundle)
        exitApp()
    }

    // MARK: - project folders (assistant-v0 §5)

    func refreshProjects() async {
        do { projects = try await client.projects() } catch { errorMessage = error.localizedDescription }
    }

    /// Adds folders picked on the Mac; the daemon checks each against its rules and refuses the list otherwise.
    func addProjects(_ folders: [URL]) async {
        var next = projects
        for folder in folders where !next.contains(where: { $0.path == folder.path }) {
            next.append(ProjectEntry(name: ProjectEntry.name(for: folder, taken: next.map(\.name)), path: folder.path))
        }
        await saveProjects(next)
    }

    func removeProject(_ project: ProjectEntry) async {
        await saveProjects(projects.filter { $0.name != project.name })
    }

    private func saveProjects(_ list: [ProjectEntry]) async {
        do { projects = try await client.saveProjects(list) } catch { errorMessage = error.localizedDescription }
    }

    private func pollGate() async {
        let port = ports.gate
        let result = await Task.detached { GateProbe.probe(port: port) }.value
        gateHealthy = gateState.isServing && result.isGate
        gateMisses = result.isGate ? 0 : gateMisses + 1
        switch gateState.phase {
        case .external where gateMisses >= 2:
            gateMisses = 0
            await gate.reportExternalLost()
        case .running(_, let since) where gateMisses >= AppModel.gateMissLimit && Date().timeIntervalSince(since) > AppModel.startupGrace:
            gateMisses = 0
            await gate.reportUnhealthy(result.detail)
        default:
            break
        }
        if gateHealthy, caCopy == nil || caCopy == .sourceMissing { syncCA() }
    }

    private func pollDaemon() async {
        guard case .running(_, let since) = daemonState.phase else { return }
        let client = client
        let healthy = (try? await client.health())?.ok == true
        daemonReady = healthy
        daemonMisses = healthy ? 0 : daemonMisses + 1
        if !healthy {
            if daemonMisses >= AppModel.daemonMissLimit && Date().timeIntervalSince(since) > AppModel.startupGrace {
                daemonMisses = 0
                await daemon.reportUnhealthy("healthz 连续失败")
            }
            return
        }
        do {
            let info = try await client.remoteInfo()
            remote = info
            remoteProblem = nil
        } catch {
            remote = nil
            remoteProblem = error.localizedDescription
        }
        await refreshDevices()
        bonjour.update(remoteEnabled ? BonjourRecord.advertisement(info: remote, fallbackPort: ports.remote, computerName: computerName) : nil)
    }

    func refreshDevices() async {
        guard daemonReady else { return }
        do {
            devices = try await client.devices()
        } catch DaemonError.notSupported {
            devices = []
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: environment

    func detectEnvironment() {
        guard !detecting else { return }
        detecting = true
        let path = config.get().path
        let home = paths.userHome.path
        let env = baseEnvironment
        let ca = paths.gateCA
        Task {
            async let reports = HarnessDetector(path: path, home: home, environment: env).detectAll()
            async let ts = Tailscale.detect(path: path, environment: env)
            harnesses = await reports
            tailscale = await ts
            caTrusted = await Task.detached { GateCA.isTrusted(ca) }.value
            detecting = false
        }
    }

    /// `~/.secret-gate/ca.pem` follows the CA mitmproxy wrote on the proxy's first start (no keychain change).
    func syncCA() {
        let source = paths.mitmproxyCA, target = paths.gateCA
        Task {
            do {
                let result = try await Task.detached { try GateCA.ensureCopy(from: source, to: target) }.value
                caCopy = result
                if result == .copied { notices.append("已把网关 CA 复制到 \(target.path)") }
                if result == .replaced { notices.append("网关 CA 已更新：\(target.path)") }
                caTrusted = await Task.detached { GateCA.isTrusted(target) }.value
            } catch {
                errorMessage = "复制网关 CA 失败：\(error.localizedDescription)"
            }
        }
    }

    // MARK: keys

    /// First run: a `default` keypair when the gate home has none (the gate preflight would make one too).
    private func ensureKeypair() async {
        guard paths.runtime.missing().isEmpty else { return }
        do {
            let (list, created) = try await gateCLI.ensureKeypair()
            keys = list
            if created { notices.append("已新建网关密钥对 default（\(paths.gateHome.path)）") }
        } catch {
            errorMessage = "没能准备网关密钥对：\(error.localizedDescription)"
        }
    }

    func refreshKeys() {
        let cli = gateCLI
        Task {
            do { keys = try await cli.listKeys() } catch { errorMessage = error.localizedDescription }
        }
    }

    func createKey(named name: String, makeCurrent: Bool) {
        let cli = gateCLI
        Task {
            do { keys = try await cli.newKey(named: name, makeCurrent: makeCurrent) } catch { errorMessage = error.localizedDescription }
        }
    }

    func useKey(_ key: Keypair) {
        let cli = gateCLI
        Task {
            do { keys = try await cli.useKey(named: key.name) } catch { errorMessage = error.localizedDescription }
        }
    }

    func addNotice(_ text: String) { notices.append(text) }
    func clearNotices() { notices = [] }
}

extension SupervisorPhase {
    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}
