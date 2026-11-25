import CoreServices
import Foundation
import XCTest
@testable import AgentSwitchMacCore

/// The quarantine mark on what is brought down from a node (UploadFiles.swift).
final class QuarantineTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws { dir = TestSupport.tempDir("files") }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    func testQuarantineMark() throws {
        let url = dir.appendingPathComponent("x.pdf")
        try Data("x".utf8).write(to: url)
        XCTAssertNil(try url.resourceValues(forKeys: [.quarantinePropertiesKey]).quarantineProperties)
        try DispatchQuarantine.mark(url)
        let properties = try XCTUnwrap(try url.resourceValues(forKeys: [.quarantinePropertiesKey]).quarantineProperties)
        XCTAssertEqual(properties[kLSQuarantineAgentNameKey as String] as? String, DispatchQuarantine.agentName)
    }
}
