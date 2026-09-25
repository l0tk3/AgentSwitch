import Foundation
import XCTest
@testable import AgentSwitchMacCore

/// Swapping in a staged AgentSwitch.app (assistant-v0 §5), on bundles in a temp dir: what is offered, the swap and the
/// way back, the folder check, and the outcome left for the daemon.
final class AppUpdateTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-update-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
        try? FileManager.default.removeItem(at: dir)
    }

    private func bundle(_ path: String, built: String, mark: String) throws -> URL {
        let app = dir.appendingPathComponent(path)
        let runtime = app.appendingPathComponent("Contents/Resources/runtime")
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        try "node=24\nbuilt=\(built)\n".write(to: runtime.appendingPathComponent("VERSIONS"), atomically: true, encoding: .utf8)
        try mark.write(to: app.appendingPathComponent("mark"), atomically: true, encoding: .utf8)
        return app
    }

    private func mark(_ path: String) -> String? {
        try? String(contentsOf: dir.appendingPathComponent(path).appendingPathComponent("mark"), encoding: .utf8)
    }

    func testANewerStagedBuildIsOfferedAndAnOlderOneIsNot() throws {
        let app = try bundle("AgentSwitch.app", built: "2026-09-25T01:00:00Z", mark: "old")
        XCTAssertNil(AppUpdate.newerStaged(than: app))
        _ = try bundle("next/AgentSwitch.app", built: "2026-09-25T03:00:00Z", mark: "new")
        XCTAssertEqual(AppUpdate.newerStaged(than: app), "2026-09-25T03:00:00Z")
        _ = try bundle("next/AgentSwitch.app", built: "2026-09-24T00:00:00Z", mark: "older")
        XCTAssertNil(AppUpdate.newerStaged(than: app))
    }

    func testTheSwapKeepsTheRunningBundleAsPreviousAndTheWayBackKeepsTheFailedOne() throws {
        let app = try bundle("AgentSwitch.app", built: "2026-09-25T01:00:00Z", mark: "old")
        _ = try bundle(AppUpdate.previousName, built: "2026-09-24T00:00:00Z", mark: "older")
        _ = try bundle("next/AgentSwitch.app", built: "2026-09-25T03:00:00Z", mark: "new")
        try AppUpdate.swapIn(app: app)
        XCTAssertEqual(mark("AgentSwitch.app"), "new")
        XCTAssertEqual(mark(AppUpdate.previousName), "old", "the one before it goes")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("next").path))
        try AppUpdate.swapBack(app: app)
        XCTAssertEqual(mark("AgentSwitch.app"), "old")
        XCTAssertEqual(mark(AppUpdate.failedName), "new")
    }

    func testASwapThatCannotFinishLeavesTheRunningBundleWhereItWas() throws {
        let app = try bundle("AgentSwitch.app", built: "2026-09-25T01:00:00Z", mark: "old")
        XCTAssertThrowsError(try AppUpdate.swapIn(app: app), "nothing staged")
        XCTAssertEqual(mark("AgentSwitch.app"), "old")
        _ = try bundle("next/AgentSwitch.app", built: "2026-09-25T03:00:00Z", mark: "new")
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
        XCTAssertThrowsError(try AppUpdate.swapIn(app: app), "the folder cannot be changed")
        XCTAssertEqual(mark("AgentSwitch.app"), "old")
    }

    func testASwapGivenUpOnMovesNothing() throws {
        let app = try bundle("AgentSwitch.app", built: "2026-09-25T01:00:00Z", mark: "old")
        _ = try bundle("next/AgentSwitch.app", built: "2026-09-25T03:00:00Z", mark: "new")
        let giveUp = GiveUp()
        giveUp.now()
        XCTAssertThrowsError(try AppUpdate.swapIn(app: app, proceed: { giveUp.proceed }))
        XCTAssertEqual(mark("AgentSwitch.app"), "old")
        XCTAssertEqual(mark("next/AgentSwitch.app"), "new")
    }

    func testAStepThatDoesNotEndInTimeIsGivenUpOn() async {
        let answer = await AppUpdate.offMain(wait: 0.2) { Thread.sleep(forTimeInterval: 2) }
        guard case .timedOut = answer else { return XCTFail("\(answer)") }
    }

    func testTheFolderCheckPassesWhereTheAppMayWriteAndSaysWhyWhereItMayNot() async throws {
        let app = try bundle("AgentSwitch.app", built: "2026-09-25T01:00:00Z", mark: "old")
        _ = try bundle("next/AgentSwitch.app", built: "2026-09-25T03:00:00Z", mark: "new")
        let fine = await AppUpdate.folderAccessProblem(app: app, wait: 5)
        XCTAssertNil(fine)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
        let blocked = await AppUpdate.folderAccessProblem(app: app, wait: 5)
        XCTAssertTrue(blocked?.contains("文件和文件夹") == true, blocked ?? "nil")
    }

    func testTheOutcomeIsWrittenForTheDaemon() throws {
        let data = AppUpdate.result(ok: false, reverted: true, from: "A", to: "B", reason: "没起来", at: Date(timeIntervalSince1970: 1))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["ok"] as? Bool, false)
        XCTAssertEqual(object["reverted"] as? Bool, true)
        XCTAssertEqual(object["from"] as? String, "A")
        XCTAssertEqual(object["reason"] as? String, "没起来")
        XCTAssertEqual(object["at"] as? Int, 1000)
    }

    func testTheDaemonLearnsWhichBundleItRunsFrom() {
        let runtime = RuntimeLayout(root: URL(fileURLWithPath: "/Apps/AgentSwitch.app/Contents/Resources/runtime"))
        XCTAssertEqual(runtime.appBundle?.path, "/Apps/AgentSwitch.app")
        XCTAssertNil(RuntimeLayout(root: URL(fileURLWithPath: "/dev/runtime")).appBundle, "a development runtime has no bundle to update")
    }
}
