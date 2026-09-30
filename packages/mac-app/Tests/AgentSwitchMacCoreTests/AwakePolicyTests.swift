import XCTest
@testable import AgentSwitchMacCore

/// The Mac stays awake for AgentSwitch (docs/app-v0.md §4 "有终端开着就不睡"): work, a phone, an open terminal on mains
/// power, and 15 minutes after the last of these.
final class AwakePolicyTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    func testNothingToDoLetsItSleep() {
        var policy = AwakePolicy()
        XCTAssertFalse(policy.wantsAwake(working: false, openTerminals: 0, phoneOnline: false, onBattery: false, at: t0))
    }

    /// The case that slept (12:39, 2026-09-30): the agent's turn over, the phone put away, the terminal still open.
    func testAnIdleOpenTerminalKeepsItAwakeOnMainsPower() {
        var policy = AwakePolicy()
        for minute in [0.0, 30, 600] {
            XCTAssertTrue(policy.wantsAwake(working: false, openTerminals: 1, phoneOnline: false, onBattery: false, at: t0 + minute * 60))
        }
    }

    func testOnBatteryAnOpenTerminalAloneDoesNot() {
        var policy = AwakePolicy()
        XCTAssertFalse(policy.wantsAwake(working: false, openTerminals: 2, phoneOnline: false, onBattery: true, at: t0))
        XCTAssertTrue(policy.wantsAwake(working: true, openTerminals: 2, phoneOnline: false, onBattery: true, at: t0))
        XCTAssertTrue(policy.wantsAwake(working: false, openTerminals: 0, phoneOnline: true, onBattery: true, at: t0))
    }

    func testItLingersAfterTheLastReason() {
        var policy = AwakePolicy()
        XCTAssertTrue(policy.wantsAwake(working: true, openTerminals: 0, phoneOnline: false, onBattery: false, at: t0))
        XCTAssertTrue(policy.wantsAwake(working: false, openTerminals: 0, phoneOnline: false, onBattery: false, at: t0 + 60))
        XCTAssertTrue(policy.wantsAwake(working: false, openTerminals: 0, phoneOnline: false, onBattery: false, at: t0 + AwakePolicy.linger - 1))
        XCTAssertFalse(policy.wantsAwake(working: false, openTerminals: 0, phoneOnline: false, onBattery: false, at: t0 + AwakePolicy.linger))
        // A new reason starts it over.
        XCTAssertTrue(policy.wantsAwake(working: false, openTerminals: 0, phoneOnline: true, onBattery: false, at: t0 + 2 * AwakePolicy.linger))
        XCTAssertTrue(policy.wantsAwake(working: false, openTerminals: 0, phoneOnline: false, onBattery: false, at: t0 + 2 * AwakePolicy.linger + 600))
    }

    func testTheSnapshotSaysHowManyTerminalsAreOpen() throws {
        let json = #"{"rows":[],"running":0,"waiting":0,"ended":[],"open":2,"now":1000}"#
        XCTAssertEqual(try JSONDecoder().decode(LiveSnapshot.self, from: Data(json.utf8)).open, 2)
        let older = #"{"rows":[],"now":1000}"#
        XCTAssertEqual(try JSONDecoder().decode(LiveSnapshot.self, from: Data(older.utf8)).open, 0)
    }
}
