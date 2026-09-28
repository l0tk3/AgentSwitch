import Darwin
import XCTest
@testable import AgentSwitchMacCore

/// docs/gate-service-v0.md §4 on the Mac side: what counts as installed, which mode the app runs in, and that the
/// user-process gate never comes back while the service is there.
final class GateServiceStateTests: XCTestCase {
    private let service = GateServicePaths(root: URL(fileURLWithPath: "/tmp/as-root"))

    private func result(_ status: Int32, stdout: String = "", stderr: String = "", timedOut: Bool = false) -> CommandResult {
        CommandResult(status: status, stdout: Data(stdout.utf8), stderr: Data(stderr.utf8), timedOut: timedOut)
    }

    func testPathsFollowTheSpec() {
        let p = GateServicePaths()
        XCTAssertEqual(p.publicDir.path, "/Library/Application Support/AgentSwitch/gate-public")
        XCTAssertEqual(p.socket.path, "/Library/Application Support/AgentSwitch/gate-public/gate.sock")
        XCTAssertEqual(p.ca.path, "/Library/Application Support/AgentSwitch/gate-public/ca.pem")
        XCTAssertEqual(p.keysFile.lastPathComponent, "keys.json")
        XCTAssertEqual(p.record.path, "/Library/Application Support/AgentSwitch/gate-service.json")
    }

    func testStatusDecodesBothSpellings() throws {
        let camel = #"{"installed":true,"running":true,"proxyPort":8080,"runtimeVersion":"2026-09-27T05:00:00Z","ownerUid":501,"publicDir":"/x"}"#
        XCTAssertEqual(try JSONDecoder().decode(GateServiceStatus.self, from: Data(camel.utf8)),
                       GateServiceStatus(installed: true, running: true, proxyPort: 8080, runtimeVersion: "2026-09-27T05:00:00Z",
                                         ownerUid: 501, publicDir: "/x"))
        let snake = #"{"installed":false,"running":false,"proxy_port":null,"owner_uid":null,"public_dir":"/y"}"#
        let s = try JSONDecoder().decode(GateServiceStatus.self, from: Data(snake.utf8))
        XCTAssertFalse(s.installed)
        XCTAssertNil(s.proxyPort)
        XCTAssertEqual(s.publicDir, "/y")
        XCTAssertThrowsError(try JSONDecoder().decode(GateServiceStatus.self, from: Data(#"{"running":true}"#.utf8)))
    }

    func testStatusOutcome() {
        guard case .status(let s) = GateServiceStatusOutcome.interpret(result(0, stdout: #"{"installed":true,"running":false}"#)) else {
            return XCTFail("JSON on stdout is a status")
        }
        XCTAssertTrue(s.installed)
        let argparse = "usage: secret-gate [-h] {keygen,keys,...}\nsecret-gate: error: argument cmd: invalid choice: 'system'"
        XCTAssertEqual(GateServiceStatusOutcome.interpret(result(2, stderr: argparse)), .unsupported)
        XCTAssertEqual(GateServiceStatusOutcome.interpret(result(1, stderr: "无法读取 gate-service.json\n")), .failed("无法读取 gate-service.json"))
        XCTAssertEqual(GateServiceStatusOutcome.interpret(result(0, timedOut: true)), .failed("secret-gate system status 超时"))
        guard case .failed = GateServiceStatusOutcome.interpret(result(0, stdout: "not json")) else { return XCTFail() }
    }

    func testNothingInstalledKeepsTheUserProcess() {
        let s = GateServiceState.evaluate(.status(GateServiceStatus(installed: false, running: false)), socketPresent: false, record: nil)
        XCTAssertEqual(s.availability, .notInstalled)
        XCTAssertEqual(s.runMode(paths: service, fallbackPort: 8080), .userProcess)
        XCTAssertEqual(GateServiceState.evaluate(.unsupported, socketPresent: false, record: nil).availability, .unsupported)
        XCTAssertEqual(GateServiceState.evaluate(nil, socketPresent: false, record: nil).availability, .unknown)
        let failed = GateServiceState.evaluate(.failed("boom"), socketPresent: false, record: nil)
        XCTAssertEqual(failed.availability, .notInstalled)
        XCTAssertEqual(failed.problem, "boom")
    }

    func testAnythingOnDiskMeansServiceMode() {
        // The status command says no, but the socket is there (the CLI's own test): service mode.
        let socket = GateServiceState.evaluate(.status(GateServiceStatus(installed: false, running: false)), socketPresent: true, record: nil)
        XCTAssertTrue(socket.isInstalled)
        // The command cannot run (older runtime, failure), but the root-owned record is there.
        let record = GateServiceRecord(ownerUid: 501, proxyPort: 8181, runtimeVersion: "v1")
        for outcome in [GateServiceStatusOutcome.unsupported, .failed("x"), nil] {
            let s = GateServiceState.evaluate(outcome, socketPresent: false, record: record)
            XCTAssertTrue(s.isInstalled)
            XCTAssertNil(s.running)
            XCTAssertEqual(s.proxyPort, 8181)
            XCTAssertEqual(s.runMode(paths: service, fallbackPort: 8080), .service(publicDir: service.publicDir, proxyPort: 8181))
        }
    }

    func testStatusWinsOverTheRecordAndPortFallsBack() {
        let s = GateServiceState.evaluate(.status(GateServiceStatus(installed: true, running: true, proxyPort: 9090, runtimeVersion: "b")),
                                          socketPresent: true, record: GateServiceRecord(ownerUid: 501, proxyPort: 8181, runtimeVersion: "a"))
        XCTAssertEqual(s.proxyPort, 9090)
        XCTAssertEqual(s.runtimeVersion, "b")
        XCTAssertEqual(s.ownerUid, 501, "the record fills what status leaves out")
        XCTAssertEqual(s.running, true)
        let noPort = GateServiceState.evaluate(.status(GateServiceStatus(installed: true, running: false)), socketPresent: false, record: nil)
        XCTAssertEqual(noPort.runMode(paths: service, fallbackPort: 8080), .service(publicDir: service.publicDir, proxyPort: 8080))
        XCTAssertTrue(noPort.ownedByAnotherUser(uid: 501) == false, "unknown owner is not someone else")
        let other = GateServiceState.evaluate(.status(GateServiceStatus(installed: true, running: true, ownerUid: 502)), socketPresent: true, record: nil)
        XCTAssertTrue(other.ownedByAnotherUser(uid: 501))
        XCTAssertFalse(other.ownedByAnotherUser(uid: 502))
    }

    func testRecordAndDiskProbe() throws {
        let root = TestSupport.tempDir("svc")
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = GateServicePaths(root: root)
        XCTAssertNil(GateServiceRecord.read(paths.record))
        XCTAssertFalse(GateServiceProbe.installedOnDisk(paths))
        try Data("{broken".utf8).write(to: paths.record)
        XCTAssertEqual(GateServiceRecord.read(paths.record), GateServiceRecord(), "unparsable still means installed")
        XCTAssertTrue(GateServiceProbe.installedOnDisk(paths))
        try Data(#"{"ownerUid":501,"proxyPort":8080,"runtimeVersion":"r","installedAt":"2026-09-27T00:00:00Z"}"#.utf8).write(to: paths.record)
        XCTAssertEqual(GateServiceRecord.read(paths.record), GateServiceRecord(ownerUid: 501, proxyPort: 8080, runtimeVersion: "r"))
        try FileManager.default.removeItem(at: paths.record)
        try FileManager.default.createDirectory(at: paths.publicDir, withIntermediateDirectories: true)
        try Data().write(to: paths.socket)
        XCTAssertTrue(GateServiceProbe.installedOnDisk(paths), "the socket alone counts")
    }

    func testUpdateComparesTheBundledBuild() {
        let bundled = ["built": "2026-09-27T05:04:07Z", "secret-gate": "0.1.0"]
        XCTAssertEqual(GateServiceUpdate.bundledIdentity(bundled), "2026-09-27T05:04:07Z")
        XCTAssertEqual(GateServiceUpdate.bundledIdentity(["secret-gate": "0.1.0"]), "0.1.0")
        XCTAssertNil(GateServiceUpdate.bundledIdentity([:]))
        XCTAssertFalse(GateServiceUpdate.isAvailable(installed: "2026-09-27T05:04:07Z", bundled: bundled))
        XCTAssertFalse(GateServiceUpdate.isAvailable(installed: "secret-gate=0.1.0 built=2026-09-27T05:04:07Z", bundled: bundled))
        XCTAssertTrue(GateServiceUpdate.isAvailable(installed: "2026-09-20T01:00:00Z", bundled: bundled))
        XCTAssertFalse(GateServiceUpdate.isAvailable(installed: nil, bundled: bundled), "unknown: nothing offered")
        XCTAssertFalse(GateServiceUpdate.isAvailable(installed: "  ", bundled: bundled))
        XCTAssertFalse(GateServiceUpdate.isAvailable(installed: "x", bundled: [:]))
        // What secret-gate's `system install` records (system_plan.runtime_version).
        XCTAssertEqual(GateServiceUpdate.bundledRuntimeVersion(bundled), "0.1.0+2026-09-27T05:04:07Z")
        XCTAssertEqual(GateServiceUpdate.bundledRuntimeVersion(["secret-gate": "0.1.0"]), "0.1.0")
        XCTAssertFalse(GateServiceUpdate.isAvailable(installed: "0.1.0+2026-09-27T05:04:07Z", bundled: bundled))
        XCTAssertTrue(GateServiceUpdate.isAvailable(installed: "0.1.0+2026-09-20T01:00:00Z", bundled: bundled))
    }

    /// The fields secret-gate's `system status --json` adds (system_cli.service_status).
    func testStatusCarriesTheCLIsOwnComparisonAndReason() throws {
        let json = #"{"installed":true,"running":false,"rpcRunning":true,"proxyRunning":false,"proxyPort":8080,"runtimeVersion":"0.1.0+a","ownerUid":501,"publicDir":"/p","bundledRuntimeVersion":"0.1.0+b","updateAvailable":true,"error":"代理未运行；见 /x/proxy.log"}"#
        let s = try JSONDecoder().decode(GateServiceStatus.self, from: Data(json.utf8))
        XCTAssertEqual(s.updateAvailable, true)
        XCTAssertEqual(s.error, "代理未运行；见 /x/proxy.log")
        let state = GateServiceState.evaluate(.status(s), socketPresent: true, record: nil)
        XCTAssertEqual(state.updateAvailable, true)
        XCTAssertEqual(state.problem, "代理未运行；见 /x/proxy.log")
        XCTAssertEqual(state.running, false)
        let none = #"{"installed":false,"running":false,"error":"无法读取 gate-service.json","updateAvailable":false}"#
        let notInstalled = GateServiceState.evaluate(.status(try JSONDecoder().decode(GateServiceStatus.self, from: Data(none.utf8))),
                                                     socketPresent: false, record: nil)
        XCTAssertNil(notInstalled.problem, "no service: its missing record is not a problem")
        XCTAssertNil(notInstalled.updateAvailable)
    }

    func testHealthNeedsTwoMissesForNotResponding() {
        var h = GateServiceHealth.initial
        XCTAssertEqual(h.verdict, .checking)
        h = h.recording(true)
        XCTAssertEqual(h.verdict, .responding)
        h = h.recording(false)
        XCTAssertEqual(h.verdict, .checking, "one miss: launchd may be restarting it")
        h = h.recording(false)
        XCTAssertEqual(h.verdict, .notResponding)
        XCTAssertEqual(h.recording(true).verdict, .responding)
        XCTAssertEqual(GateServiceHealth.initial.recording(false).recording(false).verdict, .notResponding)
    }
}

final class GateServiceModeTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/Users/u")
    private var paths: AppPaths {
        AppPaths.resolve(environment: [:], userHome: home, bundleResources: URL(fileURLWithPath: "/A.app/Contents/Resources"))
    }
    private var serviceMode: GateRunMode { .service(publicDir: paths.gateService.publicDir, proxyPort: 8181) }

    func testPathsAndOverride() {
        XCTAssertEqual(paths.gateService.root.path, "/Library/Application Support/AgentSwitch")
        XCTAssertEqual(paths.gateCA(in: .userProcess).path, "/Users/u/.secret-gate/ca.pem")
        XCTAssertEqual(paths.gateCA(in: serviceMode).path, "/Library/Application Support/AgentSwitch/gate-public/ca.pem")
        XCTAssertEqual(paths.previousGateCA.path, "/Users/u/Library/Application Support/AgentSwitch/gate-previous-ca.pem")
        let env = ["AGENTSWITCH_GATE_SERVICE_ROOT": "/tmp/svc"]
        XCTAssertEqual(AppPaths.resolve(environment: env, userHome: home, bundleResources: nil, allowRuntimeOverride: true).gateService.root.path,
                       "/tmp/svc")
        XCTAssertEqual(AppPaths.resolve(environment: env, userHome: home, bundleResources: nil).gateService.root.path,
                       "/Library/Application Support/AgentSwitch", "Release ignores the override")
    }

    func testServiceEnvironmentForDaemonAndCLI() {
        let user = ChildEnvironment.daemon(base: [:], paths: paths, ports: .defaults, options: .standard, path: "")
        XCTAssertNil(user["SECRET_GATE_PUBLIC"], "no service: today's environment")
        XCTAssertNil(user["SECRET_GATE_CA"])
        XCTAssertEqual(user["SECRET_GATE_PROXY"], "http://127.0.0.1:8080")
        let svc = ChildEnvironment.daemon(base: [:], paths: paths, ports: .defaults, options: .standard, path: "", gateMode: serviceMode)
        XCTAssertEqual(svc["SECRET_GATE_PUBLIC"], "/Library/Application Support/AgentSwitch/gate-public")
        XCTAssertEqual(svc["SECRET_GATE_CA"], "/Library/Application Support/AgentSwitch/gate-public/ca.pem")
        XCTAssertEqual(svc["SECRET_GATE_PROXY"], "http://127.0.0.1:8181", "the service's port, not the setting")
        XCTAssertEqual(svc["SECRET_GATE_BIN"], "/A.app/Contents/Resources/runtime/python/bin/secret-gate")
        let cli = ChildEnvironment.gate(base: [:], paths: paths, gateMode: serviceMode)
        XCTAssertEqual(cli["SECRET_GATE_PUBLIC"], svc["SECRET_GATE_PUBLIC"])
        XCTAssertEqual(cli["SECRET_GATE_CA"], svc["SECRET_GATE_CA"])
        XCTAssertNil(ChildEnvironment.gate(base: [:], paths: paths)["SECRET_GATE_PUBLIC"])
        let config = RuntimeConfig(paths: paths, ports: .defaults, options: .standard, path: "", baseEnvironment: [:], gateMode: serviceMode)
        XCTAssertEqual(config.gateCLI.environment["SECRET_GATE_PUBLIC"], svc["SECRET_GATE_PUBLIC"])
        XCTAssertEqual(RuntimePlan.daemonSpec(config).environment["SECRET_GATE_CA"], svc["SECRET_GATE_CA"])
    }

    func testServiceGuard() {
        XCTAssertNil(RuntimePlan.serviceGuard(mode: .userProcess, installedOnDisk: false))
        guard case .fail(let why) = RuntimePlan.serviceGuard(mode: serviceMode, installedOnDisk: true) else { return XCTFail() }
        XCTAssertTrue(why.contains("无响应"), why)
        guard case .fail = RuntimePlan.serviceGuard(mode: .userProcess, installedOnDisk: true) else {
            return XCTFail("installed behind the app's back: still no user gate")
        }
    }

    /// A lost adopted gate asks the supervisor for its own child. In service mode the preflight refuses: the gate ends
    /// failed with the guidance, and nothing is spawned (the runtime here would launch if asked).
    func testLostServiceGateIsNeverReplacedByAUserProcess() async throws {
        let root = TestSupport.tempDir("svcguard")
        defer { try? FileManager.default.removeItem(at: root) }
        let runtime = root.appendingPathComponent("runtime")
        let gate = runtime.appendingPathComponent("python/bin/secret-gate")
        try FileManager.default.createDirectory(at: gate.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\necho \"$@\" >> \"\(root.path)/ran\"\nsleep 30\n".write(to: gate, atomically: true, encoding: .utf8)
        chmod(gate.path, 0o755)
        let service = GateServicePaths(root: root.appendingPathComponent("svc"))
        let paths = AppPaths(userHome: root, agentswitchHome: root.appendingPathComponent("home"), gateHome: root.appendingPathComponent("sg"),
                             logsDir: root.appendingPathComponent("logs"), runtime: RuntimeLayout(root: runtime), gateService: service)
        let ports = PortSettings.defaults.with(gate: TestSupport.freePort())
        let config = RuntimeConfig(paths: paths, ports: ports, options: .standard, path: "/usr/bin", baseEnvironment: [:],
                                   gateMode: .service(publicDir: service.publicDir, proxyPort: ports.gate))
        let (s, effects) = SupervisorMachine.reduce(SupervisorState(phase: .external("svc"), wanted: true, failures: 0, restarts: 0, lastExit: nil),
                                                    .externalLost)
        XCTAssertEqual(effects, [.preflightAndLaunch], "the machine asks for a launch…")
        XCTAssertEqual(s.phase, .starting)
        guard case .fail(let why) = await RuntimePreflight.gate(config) else { return XCTFail("…the preflight refuses it") }
        XCTAssertEqual(why, RuntimePlan.serviceNotResponding)

        let supervisor = ProcessSupervisor(name: "gate", preflight: { await RuntimePreflight.gate(config) }, observer: { _ in })
        await supervisor.start()
        let failed = await TestSupport.waitUntil(timeout: 5) { await supervisor.state.phase.isFailedPhase }
        XCTAssertTrue(failed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("ran").path), "no secret-gate was started")

        // User mode, but the service appeared on disk meanwhile: refused as well.
        try FileManager.default.createDirectory(at: service.root, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: service.record)
        let user = RuntimeConfig(paths: paths, ports: ports, options: .standard, path: "/usr/bin", baseEnvironment: [:])
        guard case .fail = await RuntimePreflight.gate(user) else { return XCTFail("service on disk: no user gate") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("ran").path))
    }
}

private extension SupervisorPhase {
    var isFailedPhase: Bool {
        if case .failed = self { return true }
        return false
    }
}

final class GateServiceChecklistTests: XCTestCase {
    private let installed = GateServiceState(availability: .installed, running: true, socketPresent: true, proxyPort: 8080,
                                             runtimeVersion: "b", ownerUid: 501, problem: nil)

    private func facts(_ state: GateServiceState, _ health: GateServiceHealth.Verdict = .responding, update: Bool = false,
                       operation: GateServiceOperation? = nil, ca: PreviousCATrust? = nil) -> GateServiceFacts {
        GateServiceFacts(state: state, health: health, updateAvailable: update, operation: operation, previousCA: ca, uid: 501, port: 8080)
    }

    private func state(_ availability: GateServiceState.Availability) -> GateServiceState {
        GateServiceState(availability: availability, running: nil, socketPresent: false, proxyPort: nil, runtimeVersion: nil,
                         ownerUid: nil, problem: nil)
    }

    func testRows() {
        let missing = SetupChecklist.gateServiceItems(facts(state(.notInstalled)))
        XCTAssertEqual(missing.map(\.state), [.todo])
        XCTAssertEqual(missing.first?.action, .installGateService)
        XCTAssertEqual(missing.first?.status, "not installed")
        XCTAssertEqual(SetupChecklist.gateServiceItems(facts(state(.unsupported))), [], "an older runtime: no row")
        XCTAssertEqual(SetupChecklist.gateServiceItems(facts(state(.unknown))).map(\.state), [.checking])
        XCTAssertEqual(SetupChecklist.gateServiceItems(nil), [])

        XCTAssertEqual(SetupChecklist.gateServiceItems(facts(installed)).map(\.state), [.done])
        let update = SetupChecklist.gateServiceItems(facts(installed, update: true))
        XCTAssertEqual(update.first?.action, .updateGateService)
        XCTAssertEqual(update.first?.status, "update")
        let down = SetupChecklist.gateServiceItems(facts(installed, .notResponding, update: true))
        XCTAssertEqual(down.first?.action, .repairGateService)
        XCTAssertEqual(down.first?.status, "no response")
        XCTAssertEqual(SetupChecklist.gateServiceItems(facts(installed, .checking)).map(\.state), [.checking])

        let working = SetupChecklist.gateServiceItems(facts(state(.notInstalled), operation: .install))
        XCTAssertEqual(working.map(\.state), [.working])
        XCTAssertEqual(working.first?.status, "installing")
        XCTAssertEqual(SetupChecklist.unmet(working), 0, "under way is not unmet")

        let other = GateServiceState(availability: .installed, running: true, socketPresent: true, proxyPort: 8080, runtimeVersion: nil,
                                     ownerUid: 502, problem: nil)
        let foreign = SetupChecklist.gateServiceItems(facts(other))
        XCTAssertEqual(foreign.first?.state, .todo)
        XCTAssertNil(foreign.first?.action)
    }

    func testCertificateRowsAfterTheInstall() {
        let both = SetupChecklist.gateServiceItems(facts(installed, ca: PreviousCATrust(oldTrusted: true, newTrusted: false)))
        XCTAssertEqual(both.map(\.id), [SetupChecklist.gateServiceID, SetupChecklist.previousGateCAID, SetupChecklist.gateCAID])
        XCTAssertEqual(both.map(\.action), [nil, .removePreviousGateCA, .trustGateCA])
        let oldOnly = SetupChecklist.gateServiceItems(facts(installed, ca: PreviousCATrust(oldTrusted: true, newTrusted: true)))
        XCTAssertEqual(oldOnly.map(\.id), [SetupChecklist.gateServiceID, SetupChecklist.previousGateCAID])
        let settled = PreviousCATrust(oldTrusted: false, newTrusted: true)
        XCTAssertTrue(settled.settled)
        XCTAssertEqual(SetupChecklist.gateServiceItems(facts(installed, ca: settled)).count, 1)
        XCTAssertEqual(SetupChecklist.gateServiceItems(facts(state(.notInstalled), ca: PreviousCATrust(oldTrusted: true, newTrusted: false))).count, 1,
                       "no certificate rows before the service is there")
    }

    func testChecklistPlacesTheServiceAfterTheHarnesses() {
        let items = SetupChecklist.items(SetupFacts(harnesses: [], devices: [], tailscale: nil, workDir: .unsupported, home: "/h",
                                                    gateService: facts(state(.notInstalled))))
        XCTAssertEqual(items.map(\.id), ["claude", "codex", "opencode", SetupChecklist.gateServiceID, "phone", "tailscale"])
        let without = SetupChecklist.items(SetupFacts(harnesses: [], devices: [], tailscale: nil, workDir: .unsupported, home: "/h"))
        XCTAssertFalse(without.contains { $0.id == SetupChecklist.gateServiceID })
    }

    func testTexts() {
        XCTAssertEqual(GateServiceText.line(facts(installed)), StatusLine("ok · system service · 127.0.0.1:8080", .ok))
        XCTAssertEqual(GateServiceText.short(facts(installed)), StatusLine("ok", .ok))
        XCTAssertEqual(GateServiceText.line(facts(installed, .notResponding)), StatusLine("no response", .error))
        XCTAssertEqual(GateServiceText.short(facts(installed, .notResponding)), StatusLine("no response", .error))
        XCTAssertEqual(GateServiceText.short(facts(installed, operation: .update)), StatusLine("updating", .busy))
        XCTAssertEqual(GateServiceText.attention(facts(state(.notInstalled))), "gateway service: not installed")
        XCTAssertEqual(GateServiceText.attention(facts(installed, .notResponding)), "gateway service: no response")
        XCTAssertEqual(GateServiceText.attention(facts(installed, update: true)), "gateway service: update available")
        XCTAssertNil(GateServiceText.attention(facts(installed)))
        XCTAssertNil(GateServiceText.attention(facts(state(.notInstalled), operation: .install)))
        XCTAssertNil(GateServiceText.attention(facts(state(.unsupported))))
    }
}
