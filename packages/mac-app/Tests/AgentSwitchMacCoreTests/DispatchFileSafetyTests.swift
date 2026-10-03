import CoreServices
import Foundation
import XCTest
@testable import AgentSwitchMacCore

/// A task's files on this Mac (DispatchFileModels.swift): what a click on one does, the quarantine mark on every
/// download, and which version of the file a copy is.
final class DispatchFileSafetyTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws { dir = TestSupport.tempDir("files") }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private func copy(_ name: String) throws -> (DispatchTaskFile, URL) {
        let url = dir.appendingPathComponent(name)
        try Data("x".utf8).write(to: url)
        return (DispatchTaskFile(path: "out/\(name)", size: 1, isDeliverable: true), url.resolvingSymlinksInPath())
    }

    /// An executor's file is judged as a terminal link is: documents open, anything that could run is only shown.
    func testDocumentsOpenAndWhatCouldRunIsOnlyShown() throws {
        for name in ["report.pdf", "shot.png", "notes.txt", "data.json", "report.md", "brief.docx", "sheet.xlsx"] {
            let (file, url) = try copy(name)
            XCTAssertEqual(DispatchTaskFile.opening(file, at: url), .open(url), name)
        }
        for name in ["x.command", "x.terminal", "x.tool", "x.sh", "x.py", "x.jar", "x.pkg", "x.dmg", "x.webloc", "x.inetloc",
                     "x.fileloc", "x.mobileconfig", "x.scpt", "x.applescript", "x.workflow", "x.shortcut", "x.docm", "x.zip",
                     "x.exe", "x.bin"] {
            let (file, url) = try copy(name)
            XCTAssertEqual(DispatchTaskFile.opening(file, at: url), .reveal(url), name)
        }
        let app = dir.appendingPathComponent("Tool.app")
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        XCTAssertEqual(DispatchTaskFile.opening(DispatchTaskFile(path: "out/Tool.app", size: 0, isDeliverable: true), at: app),
                       .reveal(app.resolvingSymlinksInPath()), "an app is a folder that runs")
    }

    func testWebTypesAreShownAsSourceAndAMissingCopyOpensNothing() throws {
        for name in ["page.html", "logo.svg", "feed.xml", "a.xhtml", "saved.webarchive"] {
            let (file, url) = try copy(name)
            XCTAssertEqual(DispatchTaskFile.opening(file, at: url), .source(url), name)
        }
        let gone = DispatchTaskFile(path: "out/gone.pdf", size: 1, isDeliverable: true)
        XCTAssertEqual(DispatchTaskFile.opening(gone, at: dir.appendingPathComponent("gone.pdf")), .ignore)
    }

    func testAnExecutableBitMakesATextFileRunnable() throws {
        let (file, url) = try copy("notes.txt")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        XCTAssertEqual(DispatchTaskFile.opening(file, at: url), .reveal(url))
    }

    func testQuarantineMark() throws {
        let url = dir.appendingPathComponent("x.pdf")
        try Data("x".utf8).write(to: url)
        XCTAssertNil(try url.resourceValues(forKeys: [.quarantinePropertiesKey]).quarantineProperties)
        try DispatchQuarantine.mark(url)
        let properties = try XCTUnwrap(try url.resourceValues(forKeys: [.quarantinePropertiesKey]).quarantineProperties)
        XCTAssertEqual(properties[kLSQuarantineAgentNameKey as String] as? String, DispatchQuarantine.agentName)
    }

    /// Every download is written with the mark (the daemon's client, a fake transport).
    func testDownloadsAreQuarantined() async throws {
        try "tok\n".write(to: dir.appendingPathComponent(DaemonClient.tokenFileName), atomically: true, encoding: .utf8)
        let transport = DispatchFakeTransport { _, _ in (200, Data("#!/bin/sh\n".utf8)) }
        let api = DaemonClient(port: 4811, transport: transport, tokenFile: dir.appendingPathComponent(DaemonClient.tokenFileName))
        let target = dir.appendingPathComponent("cache/t1/out/run.command")
        try await api.downloadTaskFile(taskId: "t1", path: "out/run.command", to: target)
        XCTAssertNotNil(try target.resourceValues(forKeys: [.quarantinePropertiesKey]).quarantineProperties)
    }

    /// A copy is the file only while the Mac lists the same size and time written.
    func testVersionFollowsSizeAndTime() throws {
        let list = try DispatchFixture.decode(DispatchTaskFileList.self, object: [
            "root": "cwd", "files": [["path": "out/a.md", "size": 4, "mtime": 1_790_000_000_123.5], ["path": "out/b.md", "size": 4]],
        ]).taskFiles
        XCTAssertEqual(list[0].modified, 1_790_000_000_123.5)
        XCTAssertNil(list[1].modified, "a Mac that does not say")
        let rewritten = DispatchTaskFile(path: "out/a.md", size: 4, isDeliverable: true, modified: 1_790_000_009_000)
        let grown = DispatchTaskFile(path: "out/a.md", size: 5, isDeliverable: true, modified: 1_790_000_000_123.5)
        XCTAssertNotEqual(list[0].version, rewritten.version, "same size, written again")
        XCTAssertNotEqual(list[0].version, grown.version)
        XCTAssertEqual(list[0].version, DispatchTaskFile(path: "out/a.md", size: 4, isDeliverable: true, modified: 1_790_000_000_123.5).version)
    }
}

/// The daemon's length limits, counted as it counts (UTF-16 units), and the refusals said in the page's words.
final class DispatchLimitsTests: XCTestCase {
    func testMessagesCountUTF16UnitsAfterTrimming() {
        XCTAssertFalse(DispatchLimits.messageTooLong(String(repeating: "a", count: 8000)))
        XCTAssertTrue(DispatchLimits.messageTooLong(String(repeating: "a", count: 8001)))
        XCTAssertFalse(DispatchLimits.messageTooLong("  \n" + String(repeating: "密", count: 8000) + "\n "), "trimmed first; one unit each")
        // 4000 emoji are 4000 characters to Swift but 8000 units to the daemon; one more is over.
        XCTAssertFalse(DispatchLimits.messageTooLong(String(repeating: "😀", count: 4000)))
        XCTAssertTrue(DispatchLimits.messageTooLong(String(repeating: "😀", count: 4001)))
        XCTAssertEqual(DispatchLimits.counter("😀a", limit: 8000), "3 / 8000")
        XCTAssertEqual(DispatchNewMessage.maxCharacters, 8000)
    }

    func testAnswersAndTitles() {
        let q = [DispatchQuestion(id: "a", text: "A?")]
        XCTAssertNil(DispatchAnswerCheck.problem(questions: q, answers: ["a": [String(repeating: "😀", count: 2000)]]))
        XCTAssertNotNil(DispatchAnswerCheck.problem(questions: q, answers: ["a": [String(repeating: "😀", count: 2001)]]),
                        "4002 units, over the daemon's 4000")
        XCTAssertNil(DispatchLimits.topicTitleProblem(" " + String(repeating: "题", count: 200) + " "))
        XCTAssertEqual(DispatchLimits.topicTitleProblem(String(repeating: "😀", count: 101)), "标题最多 200 个字符。")
    }

    func testAnApprovalHandledElsewhere() {
        XCTAssertTrue(DispatchApprovalRefusal.isHandledElsewhere(DaemonError.http(status: 404, message: "no pending approval with that id")))
        XCTAssertTrue(DispatchApprovalRefusal.isHandledElsewhere(DaemonError.http(status: 409, message: "already resolved")))
        XCTAssertFalse(DispatchApprovalRefusal.isHandledElsewhere(DaemonError.http(status: 400, message: "answers must map…")))
        XCTAssertFalse(DispatchApprovalRefusal.isHandledElsewhere(DaemonError.unreachable("x")))
        XCTAssertFalse(DispatchApprovalRefusal.isHandledElsewhere(DaemonError.notSupported("POST /tasks/t/approve")))
        XCTAssertEqual(DispatchApprovalRefusal.handledElsewhere, "该请求已在别处处理。")
    }
}
