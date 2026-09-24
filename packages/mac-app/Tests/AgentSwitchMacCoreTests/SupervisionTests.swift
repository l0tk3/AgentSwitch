import XCTest
@testable import AgentSwitchMacCore

final class BackoffPolicyTests: XCTestCase {
    func testDoublesUpToTheCap() {
        let p = BackoffPolicy.standard
        XCTAssertEqual((1...8).map { p.delay(forAttempt: $0) }, [1, 2, 4, 8, 16, 32, 60, 60])
        XCTAssertEqual(p.delay(forAttempt: 0), 1)
    }
}

final class SupervisorMachineTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func reduce(_ s: SupervisorState, _ e: SupervisorEvent) -> (SupervisorState, [SupervisorEffect]) {
        SupervisorMachine.reduce(s, e, policy: .standard)
    }

    private func running(pid: Int32 = 42, since: Date? = nil, failures: Int = 0) -> SupervisorState {
        SupervisorState(phase: .running(pid: pid, since: since ?? t0), wanted: true, failures: failures, restarts: 0, lastExit: nil)
    }

    func testStartLaunchesAndRuns() {
        let (starting, effects) = reduce(.initial, .startRequested)
        XCTAssertEqual(starting.phase, .starting)
        XCTAssertTrue(starting.wanted)
        XCTAssertEqual(effects, [.preflightAndLaunch])
        let (up, none) = reduce(starting, .launched(pid: 7, at: t0))
        XCTAssertEqual(up.phase, .running(pid: 7, since: t0))
        XCTAssertEqual(none, [])
        XCTAssertTrue(up.isServing)
    }

    func testCrashLoopBacksOffExponentially() {
        var s = running()
        var delays: [TimeInterval] = []
        for i in 0..<4 {
            let crashAt = t0.addingTimeInterval(Double(i) * 100 + 2)
            s = SupervisorState(phase: .running(pid: 42, since: crashAt.addingTimeInterval(-2)), wanted: true,
                                failures: s.failures, restarts: s.restarts, lastExit: s.lastExit)
            let (waiting, effects) = reduce(s, .exited(status: 1, signaled: false, at: crashAt))
            guard case .scheduleRetry(let delay) = effects.first else { return XCTFail("no retry scheduled") }
            delays.append(delay)
            XCTAssertEqual(waiting.phase, .waitingToRestart(attempt: i + 1, until: crashAt.addingTimeInterval(delay)))
            XCTAssertEqual(waiting.lastExit?.status, 1)
            let (again, launch) = reduce(waiting, .retryDue)
            XCTAssertEqual(again.phase, .starting)
            XCTAssertEqual(launch, [.preflightAndLaunch])
            XCTAssertEqual(again.restarts, i + 1)
            s = again
        }
        XCTAssertEqual(delays, [1, 2, 4, 8])
    }

    func testLongRunResetsTheBackoff() {
        let s = running(since: t0, failures: 5)
        let (waiting, effects) = reduce(s, .exited(status: 0, signaled: false, at: t0.addingTimeInterval(3600)))
        XCTAssertEqual(waiting.failures, 1)
        XCTAssertEqual(effects, [.scheduleRetry(after: 1)])
    }

    func testStopTerminatesThenSettles() {
        let (stopping, effects) = reduce(running(pid: 9), .stopRequested)
        XCTAssertEqual(stopping.phase, .stopping(pid: 9))
        XCTAssertFalse(stopping.wanted)
        XCTAssertEqual(effects, [.terminate(pid: 9)])
        let (stopped, none) = reduce(stopping, .exited(status: 0, signaled: false, at: t0))
        XCTAssertEqual(stopped.phase, .stopped)
        XCTAssertEqual(none, [])
    }

    func testStopDuringBackoffCancelsTheRetry() {
        let waiting = SupervisorState(phase: .waitingToRestart(attempt: 2, until: t0), wanted: true, failures: 2, restarts: 1, lastExit: nil)
        let (stopped, effects) = reduce(waiting, .stopRequested)
        XCTAssertEqual(stopped.phase, .stopped)
        XCTAssertEqual(effects, [.cancelRetry])
        XCTAssertEqual(reduce(stopped, .retryDue).0, stopped, "a late timer does nothing")
    }

    func testStopWhileStartingKillsWhatLaunches() {
        let (starting, _) = reduce(.initial, .startRequested)
        let (stillStarting, none) = reduce(starting, .stopRequested)
        XCTAssertEqual(stillStarting.phase, .starting)
        XCTAssertEqual(none, [])
        let (stopping, effects) = reduce(stillStarting, .launched(pid: 11, at: t0))
        XCTAssertEqual(stopping.phase, .stopping(pid: 11))
        XCTAssertEqual(effects, [.terminate(pid: 11)])
    }

    func testPreflightFailureNeedsTheUser() {
        let (starting, _) = reduce(.initial, .startRequested)
        let (failed, effects) = reduce(starting, .preflightFailed("端口已被占用"))
        XCTAssertEqual(failed.phase, .failed("端口已被占用"))
        XCTAssertEqual(effects, [])
        let (retry, again) = reduce(failed, .startRequested)
        XCTAssertEqual(retry.phase, .starting)
        XCTAssertEqual(again, [.preflightAndLaunch])
    }

    func testLaunchFailureBacksOffWithTheReason() {
        let (starting, _) = reduce(.initial, .startRequested)
        let (waiting, effects) = reduce(starting, .launchFailed("no such file", at: t0))
        XCTAssertEqual(effects, [.scheduleRetry(after: 1)])
        XCTAssertEqual(waiting.lastExit?.detail, "no such file")
        XCTAssertTrue(waiting.lastExit?.summary.contains("no such file") ?? false)
    }

    func testRestartStopsAndStartsWithoutBackoff() {
        let (stopping, effects) = reduce(running(pid: 5, failures: 3), .restartRequested)
        XCTAssertEqual(stopping.phase, .stopping(pid: 5))
        XCTAssertTrue(stopping.wanted)
        XCTAssertEqual(stopping.failures, 0)
        XCTAssertEqual(effects, [.terminate(pid: 5)])
        let (starting, launch) = reduce(stopping, .exited(status: 0, signaled: true, at: t0))
        XCTAssertEqual(starting.phase, .starting)
        XCTAssertEqual(launch, [.preflightAndLaunch])
    }

    func testUnhealthyRestartsAndCounts() {
        let (stopping, effects) = reduce(running(pid: 3, failures: 1), .unhealthy("probe failed"))
        XCTAssertEqual(stopping.phase, .stopping(pid: 3))
        XCTAssertEqual(stopping.failures, 2)
        XCTAssertEqual(effects, [.terminate(pid: 3)])
    }

    func testExternalAdoptionAndLoss() {
        let (starting, _) = reduce(.initial, .startRequested)
        let (external, _) = reduce(starting, .adoptedExternal("复用"))
        XCTAssertEqual(external.phase, .external("复用"))
        XCTAssertTrue(external.isServing)
        let (again, effects) = reduce(external, .externalLost)
        XCTAssertEqual(again.phase, .starting)
        XCTAssertEqual(effects, [.preflightAndLaunch])
        let (stopped, _) = reduce(external, .stopRequested)
        XCTAssertEqual(stopped.phase, .stopped)
    }

    func testReducerNeverMutatesItsInput() {
        let s = running()
        _ = reduce(s, .stopRequested)
        XCTAssertEqual(s.phase, .running(pid: 42, since: t0))
    }
}

final class StatusTextTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 2_000_000)

    private func state(_ phase: SupervisorPhase, lastExit: ExitRecord? = nil) -> SupervisorState {
        SupervisorState(phase: phase, wanted: true, failures: 1, restarts: 0, lastExit: lastExit)
    }

    func testGateAndDaemonLines() {
        XCTAssertEqual(StatusText.gate(state(.running(pid: 7, since: now)), healthy: true, port: 8080).level, .ok)
        XCTAssertEqual(StatusText.gate(state(.running(pid: 7, since: now)), healthy: false, port: 8080).level, .busy)
        XCTAssertTrue(StatusText.gate(state(.external("x")), healthy: true, port: 8180).text.contains("8180"))
        XCTAssertEqual(StatusText.daemon(state(.failed("端口已被占用")), ready: false, port: 4711), StatusLine("端口已被占用", .error))
        let exit = ExitRecord(status: 1, signaled: false, at: now, uptime: 3)
        let waiting = StatusText.daemon(state(.waitingToRestart(attempt: 2, until: now.addingTimeInterval(4)), lastExit: exit), ready: false, port: 4711, now: now)
        XCTAssertEqual(waiting.level, .warning)
        XCTAssertTrue(waiting.text.contains("退出码 1") && waiting.text.contains("4 秒后第 2 次重启"), waiting.text)
        XCTAssertEqual(StatusText.daemon(.initial, ready: false, port: 1).level, .off)
    }

    func testRemoteAndDevices() {
        XCTAssertEqual(StatusText.remote(nil, problem: nil, daemonReady: false).level, .off)
        XCTAssertEqual(StatusText.remote(nil, problem: "404", daemonReady: true).level, .warning)
        let info = RemoteInfo(port: 4713, fingerprint: String(repeating: "ab", count: 32), lan: [], tailnet: [], bonjour: nil, onlineDevices: 1)
        XCTAssertEqual(StatusText.remote(info, problem: nil, daemonReady: true).text, "HTTPS 0.0.0.0:4713 · 指纹 abababab…")
        XCTAssertEqual(StatusText.remote(RemoteInfo(enabled: false, port: nil, fingerprint: nil, lan: [], tailnet: [], bonjour: nil, onlineDevices: 0),
                                         problem: nil, daemonReady: true).level, .warning)
        let devices = [Device(id: "a", name: "A", platform: "ios", createdAt: nil, lastSeenAt: nil, revokedAt: nil, online: true),
                       Device(id: "b", name: "B", platform: "ios", createdAt: nil, lastSeenAt: nil, revokedAt: now)]
        XCTAssertEqual(StatusText.devices(devices, online: nil).text, "1 台（在线 1）")
        XCTAssertEqual(StatusText.remote(info, problem: nil, daemonReady: true, enabled: false), StatusLine("远程已关闭", .off))
        XCTAssertEqual(StatusText.remote(nil, problem: nil, daemonReady: false, enabled: false).text, "远程已关闭")
        let published = StatusLine("_agentswitch._tcp「x」端口 4713", .ok)
        XCTAssertEqual(StatusText.bonjour(published, remoteEnabled: true), published)
        XCTAssertEqual(StatusText.bonjour(published, remoteEnabled: false), StatusLine("远程已关闭", .off))
        XCTAssertEqual(StatusText.devices([], online: 0).level, .off)
        XCTAssertEqual(StatusText.overall([StatusLine("", .ok), StatusLine("", .warning)]), .warning)
    }
}
