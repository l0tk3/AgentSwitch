import Darwin
import XCTest
@testable import AgentSwitchMacCore

/// Real children (`/bin/sh`) under the supervisor: restart with backoff, clean stop, SIGKILL escalation.
final class ProcessSupervisorTests: XCTestCase {
    private let fast = BackoffPolicy(initial: 0.05, multiplier: 2, maximum: 0.2, stableAfter: 30)

    private func spec(_ script: String, dir: URL, stopTimeout: TimeInterval = 2) -> LaunchSpec {
        LaunchSpec(executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", script], environment: ["PATH": "/usr/bin:/bin"],
                   workingDirectory: dir, logFile: dir.appendingPathComponent("child.log"),
                   pidFile: dir.appendingPathComponent("run/child.pid"), stopSignal: SIGINT, stopTimeout: stopTimeout)
    }

    private func supervisor(_ spec: LaunchSpec, record: StateLog) -> ProcessSupervisor {
        ProcessSupervisor(name: "test", policy: fast, preflight: { .launch(spec) }, observer: { record.append($0) })
    }

    func testCrashingChildIsRestartedWithBackoff() async throws {
        let dir = TestSupport.tempDir("crash")
        let log = StateLog()
        let sup = supervisor(spec("echo out; echo err >&2; exit 3", dir: dir), record: log)
        await sup.start()
        let restarted = await TestSupport.waitUntil(timeout: 5) { await sup.state.restarts >= 3 }
        XCTAssertTrue(restarted)
        let last = await sup.state.lastExit
        XCTAssertEqual(last?.status, 3)
        await sup.stop()
        let phase = await sup.state.phase
        XCTAssertEqual(phase, .stopped)
        let text = try String(contentsOf: dir.appendingPathComponent("child.log"), encoding: .utf8)
        XCTAssertTrue(text.contains("out") && text.contains("err"), "stdout and stderr go to the log")
        XCTAssertTrue(text.contains("test exited: status 3"))
        XCTAssertTrue(log.states.contains { if case .waitingToRestart = $0.phase { return true }; return false })
    }

    func testStopSendsTheGracefulSignalAndCleansThePidFile() async throws {
        let dir = TestSupport.tempDir("stop")
        let marker = dir.appendingPathComponent("got-int")
        let sup = supervisor(spec("trap 'touch \(marker.path); exit 0' INT; while true; do sleep 0.05; done", dir: dir), record: StateLog())
        await sup.start()
        let up = await TestSupport.waitUntil(timeout: 5) { await sup.state.isRunning }
        XCTAssertTrue(up)
        let pid = await sup.state.pid
        XCTAssertEqual(Leftovers.readPid(dir.appendingPathComponent("run/child.pid")), pid)
        try await Task.sleep(for: .milliseconds(200))   // let sh install its trap
        await sup.stop()
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path), "SIGINT reached the child")
        XCTAssertNil(Leftovers.readPid(dir.appendingPathComponent("run/child.pid")))
    }

    func testChildIgnoringTheSignalIsKilled() async throws {
        let dir = TestSupport.tempDir("kill")
        let sup = supervisor(spec("trap '' INT; while true; do sleep 0.05; done", dir: dir, stopTimeout: 0.3), record: StateLog())
        await sup.start()
        _ = await TestSupport.waitUntil(timeout: 5) { await sup.state.isRunning }
        try await Task.sleep(for: .milliseconds(200))
        let started = Date()
        await sup.stop()
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        let exit = await sup.state.lastExit
        XCTAssertEqual(exit?.signaled, true)
        XCTAssertEqual(exit?.status, SIGKILL)
    }

    func testPreflightFailureStopsWithoutRetrying() async {
        let log = StateLog()
        let sup = ProcessSupervisor(name: "t", policy: fast, preflight: { .fail("端口被占用") }, observer: { log.append($0) })
        await sup.start()
        let failed = await TestSupport.waitUntil(timeout: 2) { await sup.state.phase == .failed("端口被占用") }
        XCTAssertTrue(failed)
        try? await Task.sleep(for: .milliseconds(200))
        let phase = await sup.state.phase
        XCTAssertEqual(phase, .failed("端口被占用"))
    }

    func testAdoptionAndLossBringUpOurOwn() async {
        let dir = TestSupport.tempDir("adopt")
        let external = Flag(true)
        let launch = spec("while true; do sleep 0.05; done", dir: dir)
        let sup = ProcessSupervisor(name: "t", policy: fast, preflight: { external.value ? .adopt("外部") : .launch(launch) }, observer: { _ in })
        await sup.start()
        _ = await TestSupport.waitUntil(timeout: 2) { await sup.state.phase == .external("外部") }
        external.set(false)
        await sup.reportExternalLost()
        let own = await TestSupport.waitUntil(timeout: 5) { await sup.state.isRunning }
        XCTAssertTrue(own)
        await sup.stop()
    }

    func testMissingExecutableBacksOff() async {
        let dir = TestSupport.tempDir("missing")
        let bad = LaunchSpec(executable: URL(fileURLWithPath: "/nonexistent/node"), arguments: [], environment: [:], workingDirectory: nil,
                             logFile: dir.appendingPathComponent("x.log"), pidFile: nil, stopSignal: SIGINT, stopTimeout: 1)
        let sup = ProcessSupervisor(name: "t", policy: fast, preflight: { .launch(bad) }, observer: { _ in })
        await sup.start()
        let retried = await TestSupport.waitUntil(timeout: 3) { await sup.state.restarts >= 2 }
        XCTAssertTrue(retried)
        let detail = await sup.state.lastExit?.detail
        XCTAssertNotNil(detail)
        await sup.stop()
    }
}

final class StateLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [SupervisorState] = []
    func append(_ s: SupervisorState) { lock.lock(); items.append(s); lock.unlock() }
    var states: [SupervisorState] { lock.lock(); defer { lock.unlock() }; return items }
}

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Bool
    init(_ value: Bool) { current = value }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return current }
    func set(_ value: Bool) { lock.lock(); current = value; lock.unlock() }
}
