import AgentSwitchMacCore
import Darwin
import Foundation

/// A confirmation sheet for one operation, shown by 环境, 通用 › 端口, the first-run wizard or (through 环境) the menu.
struct GateServiceRequest: Identifiable, Equatable {
    let operation: GateServiceOperation
    /// 通用 › 端口: the whole set, saved once the service listens on the new gate port.
    var ports: PortSettings?
    let id = UUID()
}

struct GateServiceResult: Equatable {
    let operation: GateServiceOperation
    let outcome: AdminOutcome
}

/// The gate as a system service (docs/gate-service-v0.md §4 Mac 应用): detection, health, the administrator operations
/// and the keychain follow-up. The app never starts `secret-gate proxy` as this user while the service is installed.
extension AppModel {
    /// Seconds between `system status --json` calls: a Python start each, so not on every 3 s poll.
    static let serviceStatusInterval: TimeInterval = 30
    static let serviceStatusIntervalUnhealthy: TimeInterval = 9
    static let serviceStatusIntervalCatchUp: TimeInterval = 2

    var gateServiceFacts: GateServiceFacts {
        GateServiceFacts(state: gateService, health: serviceHealth.verdict, updateAvailable: gateServiceUpdateAvailable,
                         operation: gateServiceOperation, previousCA: previousCA, uid: Int(getuid()), port: ports.gate)
    }

    /// The App bundle's gate program differs from the installed one: the CLI's own answer when it gave one, else
    /// runtime/VERSIONS against `runtimeVersion` (the record, when the status command could not run).
    var gateServiceUpdateAvailable: Bool {
        guard gateService.isInstalled else { return false }
        return gateService.updateAvailable
            ?? GateServiceUpdate.isAvailable(installed: gateService.runtimeVersion, bundled: runtimeVersions)
    }

    var bundledGateVersion: String? { GateServiceUpdate.bundledRuntimeVersion(runtimeVersions) }

    // MARK: detection

    /// `system status --json` plus the socket and the record on disk.
    func detectGateService() async {
        guard !isDemo else { return }
        lastServiceStatus = Date()
        gateService = await GateServiceProbe.detect(cli: gateCLI, paths: paths.gateService)
    }

    /// Service mode, every poll: gate.sock present and the proxy passing the bootstrap probe; the status command now
    /// and then (more often while it does not answer). Nothing is started when it fails: launchd restarts the service,
    /// and the user can 修复 it.
    func pollService() async {
        let port = ports.gate
        let socket = paths.gateService.socket
        let (present, probe) = await Task.detached { (FileManager.default.fileExists(atPath: socket.path), GateProbe.probe(port: port)) }.value
        let local = present && probe.isGate
        let idle = gateServiceOperation == nil
        // The proxy answers but the last status said not running (just installed, just restarted): ask again soon.
        let interval = local && gateService.running == false ? AppModel.serviceStatusIntervalCatchUp
            : serviceHealth.verdict == .responding ? AppModel.serviceStatusInterval : AppModel.serviceStatusIntervalUnhealthy
        let due = idle && (lastServiceStatus.map { Date().timeIntervalSince($0) >= interval } ?? true)
        if due { await detectGateService() }
        serviceHealth = serviceHealth.recording(local && gateService.running != false)
        if due { await adoptGateMode() }
    }

    /// User mode, every poll: a service installed outside the app (two stat calls) switches the app over.
    func watchForService() async {
        guard gateServiceOperation == nil, GateServiceProbe.installedOnDisk(paths.gateService) else { return }
        await detectGateService()
        await adoptGateMode()
    }

    /// Brings the children in line with the detected service: installed → the own gate child stops and the daemon
    /// restarts with the service's environment; removed → the own child starts again (keypair first), then the daemon.
    func adoptGateMode() async {
        let next = gateService.runMode(paths: paths.gateService, fallbackPort: ports.gate)
        guard next != gateMode else { return }
        setGateMode(next)
        if next.isService { await gate.stop() }
        await startGate()
        forgetRemote()
        await daemon.restart()
        refreshKeys()
        detectEnvironment()
    }

    // MARK: operations

    func requestGateService(_ operation: GateServiceOperation, ports: PortSettings? = nil) {
        guard gateServiceOperation == nil else { return }
        gateServiceResult = nil
        gateServiceRequest = GateServiceRequest(operation: operation, ports: ports)
    }

    func dismissGateServiceRequest() {
        guard gateServiceOperation == nil else { return }
        gateServiceRequest = nil
        gateServiceResult = nil
    }

    /// Confirmed in the sheet: pause what must not run meanwhile, one administrator prompt, then detect again and
    /// bring the children in line. A cancelled prompt changes nothing and says nothing.
    func runGateService(_ request: GateServiceRequest) async {
        guard !isDemo, gateServiceOperation == nil else { return }
        let operation = request.operation
        gateServiceOperation = operation
        gateServiceResult = nil
        let outcome: AdminOutcome
        if let refused = await pause(for: operation) {
            outcome = refused
        } else {
            let argv = GateServiceCommand.argv(operation, gate: paths.runtime.secretGate, runtime: paths.runtime.root,
                                               ownerUid: Int(getuid()), port: ports.gate, migrateFrom: paths.gateHome)
            outcome = await GateServiceAdmin().perform(argv, prompt: operation.prompt)
        }
        await detectGateService()
        gateServiceOperation = nil
        gateServiceResult = GateServiceResult(operation: operation, outcome: outcome)
        if case .changePort = operation, outcome.succeeded {
            await applyServicePorts(request.ports ?? ports)
        } else {
            await adoptGateMode()
        }
        await resumeChildren()
        refreshKeys()
        detectEnvironment()
    }

    /// Install: the old CA noted if trusted, the daemon and the own gate stopped (the keys move, the port changes
    /// hands), and the port checked free. Uninstall: the daemon stopped (its gate goes away). Nil: go ahead.
    private func pause(for operation: GateServiceOperation) async -> AdminOutcome? {
        switch operation {
        case .install:
            await rememberTrustedCA()
            await daemon.stop()
            await gate.stop()
            let port = ports.gate
            if await Task.detached(operation: { PortProbe.isListening(port: port) }).value {
                return .failed(reason: "端口 \(port) 仍被占用，占用程序并非由 AgentSwitch 启动（可能是手动运行的 secret-gate proxy，"
                                   + "或 secret-gate service install 安装的用户服务）。请停止该程序后重试。", output: "")
            }
        case .uninstall:
            await daemon.stop()
        case .update, .repair, .changePort:
            break
        }
        return nil
    }

    /// Whatever `pause` stopped and `adoptGateMode` did not start again (a cancelled or failed operation).
    private func resumeChildren() async {
        if !gateMode.isService, await !gate.state.wanted { await startGate() }
        if await !daemon.state.wanted { await daemon.start() }
    }

    /// 通用 › 端口 after `system update --port`: every port saved, the gate one as the service now reports it, then the
    /// daemon restarted with the new `SECRET_GATE_PROXY`.
    private func applyServicePorts(_ wanted: PortSettings) async {
        let merged = wanted.with(gate: gateService.proxyPort ?? wanted.gate)
        storePorts(merged)
        setGateMode(gateService.runMode(paths: paths.gateService, fallbackPort: merged.gate))
        await daemon.restart()
    }

    // MARK: keychain (gate-service-v0 §5.5)

    /// Before the install regenerates the CA: a copy of the certificate this user trusted, if any.
    private func rememberTrustedCA() async {
        let candidates = [paths.gateCA, paths.mitmproxyCA], target = paths.previousGateCA
        do {
            _ = try await Task.detached { try GateCA.rememberTrusted(candidates: candidates, into: target) }.value
        } catch {
            errorMessage = "无法保存旧网关证书的副本：\(error.localizedDescription)。安装后请在“钥匙串访问”中检查旧证书。"
        }
    }

    /// Service mode with a saved old CA: which of the two the login keychain trusts. Once the old one is out and the
    /// new one in (or both are the same certificate), the copy goes and the rows with it.
    func checkPreviousCA() async {
        let saved = paths.previousGateCA, current = gateCA
        guard gateMode.isService, FileManager.default.fileExists(atPath: saved.path) else {
            previousCA = nil
            return
        }
        let trust = await Task.detached { () -> PreviousCATrust? in
            if GateCA.sameCertificate(saved, current) { return nil }
            return PreviousCATrust(oldTrusted: GateCA.isTrusted(saved), newTrusted: GateCA.isTrusted(current))
        }.value
        guard let trust, !trust.settled else {
            try? FileManager.default.removeItem(at: saved)
            previousCA = nil
            return
        }
        previousCA = trust
    }

    /// 加入: the keychain step of `secret-gate install-ca` for the CA in use, only on the user's click (macOS asks for
    /// the login password). The result in words.
    func trustGateCA() async -> String {
        guard !isDemo else { return "trusted" }
        let (exe, args) = GateCA.trustCommand(ca: gateCA, userHome: paths.userHome)
        let text: String
        do {
            let result = try await ProcessRunner.run(exe, args, timeout: 120)
            text = result.ok ? "trusted" : "not trusted：\(result.stderrText.trimmingCharacters(in: .whitespacesAndNewlines))"
        } catch {
            text = error.localizedDescription
        }
        detectEnvironment()
        return text
    }

    /// 移除: the pre-install certificate's trust settings and the certificate itself, only on the user's click.
    func removePreviousCA() async {
        guard !isDemo else { return }
        let saved = paths.previousGateCA
        var problems: [String] = []
        for (exe, args) in GateCA.untrustCommands(pem: saved, userHome: paths.userHome) {
            do {
                let result = try await ProcessRunner.run(exe, args, timeout: 120)
                if !result.ok { problems.append(result.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)) }
            } catch {
                problems.append(error.localizedDescription)
            }
        }
        if await Task.detached(operation: { GateCA.isTrusted(saved) }).value {
            let detail = problems.filter { !$0.isEmpty }.joined(separator: "；")
            errorMessage = "旧网关证书仍受信任" + (detail.isEmpty ? "" : "：\(detail)") + "。可在“钥匙串访问”中手动删除。"
        }
        detectEnvironment()
    }

    // MARK: logs

    /// 通用 › gate.log in service mode: `logs tail` over gate.sock (the log files belong to the service account).
    func gateLog(_ name: GateLogName) async throws -> String {
        #if DEBUG
        if isDemo { return DemoData.gateLog(name) }
        #endif
        return try await gateCLI.tailLog(name)
    }
}
