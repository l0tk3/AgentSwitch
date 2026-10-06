import AgentSwitchMacCore
import AppKit
import Foundation
import Observation
import SystemConfiguration

/// App state and the runtime: two supervised children (gate, daemon), a poll loop, Bonjour, environment checks.
/// With the gate installed as a system service (docs/gate-service-v0.md) the gate child is never started: the app
/// watches the service and passes its public directory on (AppModel+GateService.swift).
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
    let baseEnvironment: [String: String]

    // MARK: runtime state

    private(set) var gateState = SupervisorState.initial
    private(set) var daemonState = SupervisorState.initial
    private(set) var gateHealthy = false
    private(set) var daemonReady = false
    #if DEBUG
    /// DispatchProbe: a service this app does not supervise is up (the probe's `-localPort`).
    func probeServiceUp() { daemonReady = true }
    #endif
    private(set) var remote: RemoteInfo?
    private(set) var remoteProblem: String?
    private(set) var devices: [Device] = []
    private(set) var loginPath: LoginShellPath.Resolution?
    private(set) var harnesses: [HarnessReport] = []
    private(set) var tailscale: TailscaleStatus?
    private(set) var caCopy: GateCA.CopyResult?
    private(set) var caTrusted = false
    private(set) var keys: [Keypair] = []
    private(set) var bonjourStatus = StatusLine("Off", .off)
    private(set) var detecting = false
    /// First-run facts worth telling once (keypair created, CA copied).
    private(set) var notices: [String] = []
    /// The build time of a newer AgentSwitch.app staged next to this one (assistant-v0 §5), if any.
    private(set) var stagedUpdate: String?
    /// `GET /quota` (docs/ui-v0.md §4.2): nil until the daemon first answers, empty from one without the route.
    private(set) var quota: [QuotaReading]?
    /// A forced re-read (模型 › 用量 › 刷新) is under way.
    private(set) var usageRefreshing = false
    @ObservationIgnored private var usageLoading = false
    /// An install is being checked or started: a second request waits for its outcome.
    @ObservationIgnored private var installing = false
    var errorMessage: String?

    // MARK: agents (docs/agents-v0.md); written by AppModel+Agents.swift

    /// Every install of the four agent CLIs found on this Mac, with versions and sizes as they come in.
    var agents: [AgentReport] = []
    /// What the vendors published when last asked: the saved answer until the first check of this launch.
    var agentReleases: AgentReleaseInfo?
    var agentsChecking = false
    /// 设置 › Agents: which install AgentSwitch runs, the agent's raw value → the install's key.
    var agentUse: [String: String] = [:]
    /// The programs the running service was started with; a choice made since applies when it restarts.
    var agentsApplied: [AgentCLI: String] = [:]
    @ObservationIgnored var agentsScanning = false
    @ObservationIgnored var agentsScanned: Date?
    /// Asked to read again while a read was under way: done once that one ends.
    @ObservationIgnored var agentsRescan = false
    /// An install, update or delete under way, by the agent's raw value: one at a time per agent.
    var agentJobs: [String: AgentJob] = [:]
    @ObservationIgnored var agentTasks: [String: Task<Void, Never>] = [:]

    // MARK: gate service (docs/gate-service-v0.md); written by AppModel+GateService.swift

    /// What `system status --json` and the disk say; `.unknown` until the first check at launch.
    var gateService = GateServiceState.unknown
    /// The mode the children run in; switches only through `adoptGateMode()`.
    var gateMode: GateRunMode = .userProcess
    var serviceHealth = GateServiceHealth.initial
    /// An install, update or uninstall under way (one at a time).
    var gateServiceOperation: GateServiceOperation?
    /// The last one's outcome, shown by the sheet that started it.
    var gateServiceResult: GateServiceResult?
    /// The confirmation sheet on screen (环境, 通用, the wizard).
    var gateServiceRequest: GateServiceRequest?
    /// Keychain trust of the pre-install CA and the regenerated one, while a copy of the old one is kept.
    var previousCA: PreviousCATrust?
    /// When `system status --json` last ran (AppModel+GateService throttles it).
    @ObservationIgnored var lastServiceStatus: Date?

    let pairingSession = PairingSession()
    /// The daemon-side settings of control-v0 §1–2: approval policy and the default work dir.
    let control = ControlSettings()
    /// The device list has been read at least once; until then the checklist and the first-run wizard do not know
    /// whether a phone is paired.
    private(set) var devicesKnown = false
    /// Logins opened in Terminal (control-v0 §6): the environment is checked again when the app comes back to the front.
    private(set) var loginWatch = LoginWatch()
    @ObservationIgnored private var lastDetected: Date?
    /// Sample data for `-designPreview` (debug builds, docs/ui-v0.md §5): nothing is started, polled or probed.
    @ObservationIgnored private(set) var isDemo = false
    #if DEBUG
    @ObservationIgnored private var demoTransport: HTTPTransport?
    /// What DemoTransport answers from; the preview changes it between renders.
    @ObservationIgnored private(set) var demoBackend: DemoBackend?
    #endif

    // MARK: plumbing

    @ObservationIgnored let config: Locked<RuntimeConfig>
    @ObservationIgnored private(set) var gate: ProcessSupervisor!
    @ObservationIgnored private(set) var daemon: ProcessSupervisor!
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
        agentUse = defaults.dictionary(forKey: AgentSelection.defaultsKey) as? [String: String] ?? [:]
        config = Locked(RuntimeConfig(paths: paths, ports: ports, options: options, path: LoginShellPath.merge(shellPath: nil, home: home.path),
                                      baseEnvironment: base, remoteName: name, remoteEnabled: remoteEnabled))
        let box = config
        gate = ProcessSupervisor(name: "gate", preflight: { await RuntimePreflight.gate(box.get()) },
                                 observer: { [weak self] s in Task { @MainActor in self?.gateChanged(s) } })
        daemon = ProcessSupervisor(name: "daemon", preflight: { await RuntimePreflight.daemon(box.get()) },
                                   observer: { [weak self] s in Task { @MainActor in self?.daemonChanged(s) } })
        bonjour.onStatus = { [weak self] line in self?.bonjourStatus = line }
    }

    var client: DaemonClient {
        #if DEBUG
        if let demoTransport { return DaemonClient(port: ports.local, transport: demoTransport) }
        #endif
        return DaemonClient(port: ports.local, tokenFile: paths.agentswitchHome.appendingPathComponent(DaemonClient.tokenFileName))
    }
    var gateCLI: GateCLI { config.get().gateCLI }

    // MARK: status lines

    /// The service's line while it is installed or an operation runs; the own child's otherwise.
    var gateLine: StatusLine {
        showsServiceGate ? GateServiceText.line(gateServiceFacts) : StatusText.gate(gateState, healthy: gateHealthy, port: ports.gate)
    }
    /// One word for the menu row.
    var gateShortLine: StatusLine {
        showsServiceGate ? GateServiceText.short(gateServiceFacts) : StatusText.service(gateState, ready: gateHealthy)
    }
    private var showsServiceGate: Bool { gateMode.isService || gateServiceOperation != nil }
    var daemonLine: StatusLine { StatusText.daemon(daemonState, ready: daemonReady, port: ports.local) }
    var remoteLine: StatusLine { StatusText.remote(remote, problem: remoteProblem, daemonReady: daemonReady, enabled: remoteEnabled) }
    var devicesLine: StatusLine { StatusText.devices(devices, online: remote?.onlineDevices) }
    var bonjourLine: StatusLine { StatusText.bonjour(bonjourStatus, remoteEnabled: remoteEnabled) }
    var overallLevel: StatusLevel { StatusText.overall([gateLine, daemonLine]) }
    var lanAddresses: [String] { remote?.lan.isEmpty == false ? remote!.lan : NetworkAddresses.lanIPv4() }
    var tailnetAddresses: [String] { remote?.tailnet ?? [] }
    var activeDevices: [Device] { devices.filter { !$0.isRevoked } }
    /// Claude Code, Codex, OpenCode; none while the daemon is not up or has no readings.
    var usageRows: [UsageRow] { daemonReady ? Usage.rows(quota ?? []) : [] }
    var usageReadAt: Date? { quota.flatMap(Usage.readAt) }

    // MARK: lifecycle

    /// First run and every launch: login PATH, which gate (system service or own child), the gate (keypair on first
    /// run), then the daemon, then polling.
    func launch() {
        Task {
            do {
                try paths.prepareDirectories()
            } catch {
                errorMessage = "无法创建目录：\(error.localizedDescription)"
            }
            let resolution = await LoginShellPath.resolve(shell: baseEnvironment["SHELL"], home: paths.userHome.path,
                                                          base: baseEnvironment)
            loginPath = resolution
            config.set(makeConfig(ports: ports, path: resolution.path))
            sweepAgentStore()
            await detectGateService()
            setGateMode(gateService.runMode(paths: paths.gateService, fallbackPort: ports.gate))
            await startGate()
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

    /// 重启服务: the daemon, and the gate when it is the app's own child (the system service is launchd's).
    func restartAll() {
        Task {
            if gateMode.isService {
                await detectGateService()
            } else {
                await gate.restart()
                _ = await waitFor(seconds: 20) { self.gateState.isServing && self.gateHealthy || self.gateState.phase.isFailed }
            }
            await daemon.restart()
        }
    }

    /// User process: a keypair first, then the child, waited for. Service: nothing to start; a short wait for it.
    func startGate() async {
        if gateMode.isService {
            _ = await waitFor(seconds: 10) { self.serviceHealth.verdict == .responding }
            return
        }
        await ensureKeypair()
        await gate.start()
        _ = await waitFor(seconds: 20) { self.gateState.isServing && self.gateHealthy || self.gateState.phase.isFailed }
    }

    func restartDaemon() {
        daemonReady = false
        Task { await daemon.restart() }
    }

    /// New ports take effect by restarting both children (the daemon also points at the gate port). In service mode
    /// a new gate port goes through `system update --port` first (GeneralView asks; AppModel+GateService saves).
    func applyPorts(_ next: PortSettings) {
        storePorts(next)
        restartAll()
    }

    /// Saved and put in the config for the next launches; nothing restarts here.
    func storePorts(_ next: PortSettings) {
        let defaults = UserDefaults.standard
        for (key, value) in next.keyed { defaults.set(value, forKey: key) }
        ports = next
        config.set(makeConfig(ports: next, path: config.get().path))
        remote = nil
    }

    /// The daemon is about to restart: its remote listener is read again on the next poll.
    func forgetRemote() { remote = nil }

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

    func makeConfig(ports: PortSettings, path: String) -> RuntimeConfig {
        // Each agent's program is the install chosen in 设置 › Agents (docs/agents-v0.md §3): the vendor's own when
        // nothing was chosen, as before. One the scan finds none of is left for the daemon to look for.
        let chosen = AgentSelection.binaries(AgentInventory.scan(layout: agentLayout, path: path), saved: agentUse)
        return RuntimeConfig(paths: paths, ports: ports, options: options, path: path, baseEnvironment: baseEnvironment,
                             remoteName: computerName, opencodeBinary: chosen[.opencode], claudeBinary: chosen[.claude],
                             codexBinary: chosen[.codex], piBinary: chosen[.pi], remoteEnabled: remoteEnabled, gateMode: gateMode)
    }

    /// The mode and the ports that follow from it (the service's proxy port is the gate port), saved, and the config
    /// the next launches read. Starts and stops nothing.
    func setGateMode(_ mode: GateRunMode) {
        gateMode = mode
        serviceHealth = .initial
        if case .service(_, let port) = mode, port != ports.gate {
            ports = ports.with(gate: port)
            UserDefaults.standard.set(port, forKey: PortSettings.Keys.gate)
        }
        config.set(makeConfig(ports: ports, path: config.get().path))
    }

    private func gateChanged(_ s: SupervisorState) {
        if !s.isServing { gateHealthy = false }
        gateState = s
    }

    private func daemonChanged(_ s: SupervisorState) {
        // A new process: it was started with the programs the config named just now.
        if let pid = s.pid, pid != daemonState.pid { agentsApplied = config.get().agentBinaries }
        if !s.isRunning {
            daemonReady = false
            remote = nil
            bonjour.update(nil)
            pairingSession.reset()
        }
        daemonState = s
    }

    func waitFor(seconds: TimeInterval, _ condition: @MainActor () -> Bool) async -> Bool {
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
        guard !isDemo else { return }
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
            writeUpdateResult(ok: false, reverted: false, from: from, to: staged, reason: "安装新版本失败：\(error.localizedDescription)")
            return await restart(app)
        case .timedOut:
            giveUp.now()
            writeUpdateResult(ok: false, reverted: false, from: from, to: staged, reason: "macOS 未允许替换 App。请检查「App 管理」权限。")
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
                              reason: "新版本 \(AppUpdate.healthWait) 秒内未启动（本机端口 \(ports.local)），已保留为 failed-AgentSwitch.app")
        case .failed(let error):
            writeUpdateResult(ok: false, reverted: false, from: from, to: staged, reason: "新版本未启动，恢复原版本失败：\(error.localizedDescription)")
        case .timedOut:
            writeUpdateResult(ok: false, reverted: false, from: from, to: staged, reason: "新版本未启动，macOS 未允许恢复原版本")
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

    /// The system service's health in service mode; the own child's otherwise, plus a look for a service installed
    /// meanwhile (the app then switches over).
    private func pollGate() async {
        if gateMode.isService { return await pollService() }
        await pollUserGate()
        await watchForService()
    }

    private func pollUserGate() async {
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
                await daemon.reportUnhealthy("健康检查连续失败")
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
        await control.refreshWorkDirIfStale(client)
        bonjour.update(remoteEnabled ? BonjourRecord.advertisement(info: remote, fallbackPort: ports.remote, computerName: computerName) : nil)
    }

    /// The panel opening and 模型 take the daemon's cached readings (it reads again once they are a minute old);
    /// `force` (模型 › 刷新) has every provider read now. Quiet on failure: the last readings stay, and a daemon without
    /// the route shows no usage at all.
    func refreshUsage(force: Bool = false) async {
        guard daemonReady, force || !usageLoading else { return }
        usageLoading = true
        if force { usageRefreshing = true }
        defer {
            usageLoading = false
            if force { usageRefreshing = false }
        }
        do {
            quota = try await client.quota(refresh: force)
        } catch DaemonError.notSupported {
            quota = []
        } catch {
            // Not running, timed out: keep what was read last.
        }
    }

    func refreshDevices() async {
        guard daemonReady else { return }
        do {
            devices = try await client.devices()
            devicesKnown = true
        } catch DaemonError.notSupported {
            devices = []
            devicesKnown = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: environment

    /// The login shell asked for its PATH again: a vendor's installer may just have added its folder to the profile.
    /// The service gets it at its next start.
    func reloadLoginPath() async {
        guard !isDemo else { return }
        let resolution = await LoginShellPath.resolve(shell: baseEnvironment["SHELL"], home: paths.userHome.path, base: baseEnvironment)
        loginPath = resolution
        config.set(makeConfig(ports: ports, path: resolution.path))
    }

    #if DEBUG
    /// `-designPreview`: the PATH the login shell is taken to have said.
    func setDemoShellPath(_ shell: String) {
        loginPath = LoginShellPath.Resolution(path: LoginShellPath.merge(shellPath: shell, home: paths.userHome.path), source: .loginShell, note: nil, shell: shell)
    }
    #endif

    func detectEnvironment() {
        guard !detecting, !isDemo else { return }
        refreshAgents()
        detecting = true
        let path = config.get().path
        let home = paths.userHome.path
        let env = baseEnvironment
        let ca = gateCA
        Task {
            async let reports = HarnessDetector(path: path, home: home, environment: env).detectAll()
            async let ts = Tailscale.detect(path: path, environment: env)
            harnesses = await reports
            loginWatch = loginWatch.settled(by: harnesses, now: Date())
            tailscale = await ts
            caTrusted = await Task.detached { GateCA.isTrusted(ca) }.value
            await checkPreviousCA()
            lastDetected = Date()
            detecting = false
        }
    }

    // MARK: login and the setup checklist (control-v0 §6)

    /// 登录: the harness's own login command in a new Terminal window, under the PATH the daemon gets. The environment is
    /// checked again when the user comes back to the app (`appBecameActive`) or taps 重新检测.
    func login(_ harness: Harness) {
        guard !isDemo else { return }
        let binary = harnesses.first { $0.harness == harness }?.binary
        let command = HarnessLogin.shellCommand(harness, binary: binary, path: config.get().path)
        loginWatch = loginWatch.starting(harness, at: Date())
        Task {
            // macOS asks once whether AgentSwitch may control Terminal; osascript waits for that answer.
            let result = try? await ProcessRunner.run(HarnessLogin.osascript, HarnessLogin.terminalScriptArguments(command: command),
                                                      timeout: 120)
            if let problem = HarnessLogin.problem(harness, result: result) {
                loginWatch = loginWatch.dropping(harness)
                errorMessage = problem
            }
        }
    }

    /// Back from Terminal: a login may have finished, or something was installed.
    func appBecameActive() {
        guard loginWatch.recheckDue(now: Date(), unmet: setupUnmet, lastDetected: lastDetected) else { return }
        detectEnvironment()
    }

    /// 环境 › 设置清单, from what the app already knows.
    var setupItems: [SetupItem] {
        SetupChecklist.items(SetupFacts(harnesses: harnesses, devices: devicesKnown ? devices : nil, tailscale: tailscale,
                                        tailnet: tailnetAddresses, workDir: control.workDir, home: paths.userHome.path,
                                        gateService: gateServiceFacts))
    }

    var setupUnmet: Int { SetupChecklist.unmet(setupItems) }

    /// `~/.secret-gate/ca.pem` follows the CA mitmproxy wrote on the proxy's first start (no keychain change).
    func syncCA() {
        let source = paths.mitmproxyCA, target = paths.gateCA
        Task {
            do {
                let result = try await Task.detached { try GateCA.ensureCopy(from: source, to: target) }.value
                caCopy = result
                if result == .copied { notices.append("网关证书已复制到 \(shortPath(target))") }
                if result == .replaced { notices.append("网关证书已更新：\(shortPath(target))") }
                caTrusted = await Task.detached { GateCA.isTrusted(target) }.value
            } catch {
                errorMessage = "复制网关证书失败：\(error.localizedDescription)"
            }
        }
    }

    // MARK: keys

    /// First run: a `default` keypair when the gate home has none (the gate preflight would make one too). Never in
    /// service mode: the service made its own keys at install.
    func ensureKeypair() async {
        guard paths.runtime.missing().isEmpty, !gateMode.isService else { return }
        do {
            let (list, created) = try await gateCLI.ensureKeypair()
            keys = list
            if created { notices.append("已新建网关密钥对 default（\(shortPath(paths.gateHome))）") }
        } catch {
            errorMessage = "无法准备网关密钥对：\(error.localizedDescription)"
        }
    }

    func refreshKeys() {
        guard !isDemo else { return }
        let cli = gateCLI
        Task {
            do { keys = try await cli.listKeys() } catch { errorMessage = error.localizedDescription }
        }
    }

    func createKey(named name: String, makeCurrent: Bool) {
        guard !isDemo else { return }
        let cli = gateCLI
        Task {
            do { keys = try await cli.newKey(named: name, makeCurrent: makeCurrent) } catch { errorMessage = error.localizedDescription }
        }
    }

    func useKey(_ key: Keypair) {
        guard !isDemo else { return }
        let cli = gateCLI
        Task {
            do { keys = try await cli.useKey(named: key.name) } catch { errorMessage = error.localizedDescription }
        }
    }

    /// Service mode: a legacy key deleted after the page's confirmation; the CLI refuses the current one.
    func retireKey(_ key: Keypair) {
        guard !isDemo, key.legacy, !key.current else { return }
        let cli = gateCLI
        Task {
            do { keys = try await cli.retireKey(named: key.name) } catch { errorMessage = error.localizedDescription }
        }
    }

    func addNotice(_ text: String) { notices.append(text) }
    func clearNotices() { notices = [] }

    /// The gate CA executors trust: `~/.secret-gate/ca.pem`, or the service's published `gate-public/ca.pem`.
    var gateCA: URL { paths.gateCA(in: gateMode) }

    /// The CA file is there (the user gate copies it on its first start; the service publishes it).
    var caFilePresent: Bool { isDemo || FileManager.default.fileExists(atPath: gateCA.path) }

    /// `name=version` of the bundled runtime (VERSIONS).
    var runtimeVersions: [String: String] {
        #if DEBUG
        if isDemo { return DemoData.versions }
        #endif
        return paths.runtime.versions()
    }

    #if DEBUG
    /// `-designPreview`: every piece of state a view reads, from DemoData; the daemon API answers from DemoTransport.
    /// `fresh`: a Mac on its first run (no phone paired, Codex missing, OpenCode logged out, Tailscale stopped).
    /// `gate`: the credential gate's state (docs/gate-service-v0.md); a set-up Mac runs it as a system service.
    func loadDemo(fresh: Bool = false, gate demoGate: DemoGate? = nil) {
        isDemo = true
        let backend = demoBackend ?? DemoBackend(home: paths.userHome.path)
        backend.set(pairedDevices: !fresh)
        demoBackend = backend
        demoTransport = DemoTransport(backend: backend)
        let now = Date()
        gateState = SupervisorState(phase: .running(pid: 51234, since: now.addingTimeInterval(-3 * 3600)), wanted: true,
                                    failures: 0, restarts: 0, lastExit: nil)
        gateHealthy = true
        daemonState = SupervisorState(phase: .running(pid: 51240, since: now.addingTimeInterval(-3 * 3600)), wanted: true,
                                      failures: 0, restarts: 0, lastExit: nil)
        daemonReady = true
        remote = DemoData.remote(fresh: fresh)
        remoteProblem = nil
        devices = fresh ? [] : DemoData.devices(now: now)
        devicesKnown = true
        loginPath = LoginShellPath.Resolution(path: DemoData.path(home: paths.userHome.path), source: .loginShell, note: nil,
                                              shell: DemoData.path(home: paths.userHome.path))
        harnesses = fresh ? DemoData.freshHarnesses(home: paths.userHome.path) : DemoData.harnesses(home: paths.userHome.path)
        loadDemoAgents(fresh: fresh)
        tailscale = fresh ? DemoData.tailscaleStopped : DemoData.tailscale
        caCopy = .upToDate
        caTrusted = false
        keys = DemoData.keys
        loadDemoGate(demoGate ?? (fresh ? .notInstalled : .installed))
        bonjourStatus = StatusLine("Published · Port 4713", .ok)
        // The user-process gate makes `default` on first run; the service makes `main` at install (no notice).
        notices = fresh || (demoGate ?? .installed).installed ? [] : ["已新建网关密钥对 default"]
        stagedUpdate = fresh ? nil : DemoData.stagedBuild
        quota = DemoData.quota(now: now, fresh: fresh)
    }

    /// The gate part of the demo: the service's state, health, keys and keychain rows.
    private func loadDemoGate(_ demo: DemoGate) {
        let service = paths.gateService
        gateServiceOperation = demo == .installing ? .install : nil
        gateServiceResult = nil
        gateServiceRequest = nil
        previousCA = demo == .justInstalled ? PreviousCATrust(oldTrusted: true, newTrusted: false) : nil
        guard demo.installed else {
            gateService = DemoData.gateService(installed: false)
            gateMode = .userProcess
            serviceHealth = .initial
            if demo == .installing {
                gateState = SupervisorState(phase: .stopped, wanted: false, failures: 0, restarts: 0, lastExit: nil)
                gateHealthy = false
            }
            return
        }
        gateService = DemoData.gateService(installed: true, running: demo != .notResponding,
                                           runtimeVersion: demo == .updateAvailable ? DemoData.olderGateBuild : DemoData.installedGateBuild)
        gateMode = .service(publicDir: service.publicDir, proxyPort: ports.gate)
        serviceHealth = demo == .notResponding ? GateServiceHealth(checks: 40, misses: 3) : GateServiceHealth(checks: 40, misses: 0)
        gateState = .initial
        gateHealthy = false
        keys = DemoData.serviceKeys
    }
    #endif
}

extension SupervisorPhase {
    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}
