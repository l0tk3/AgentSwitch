import XCTest
@testable import SecretGateCore

/// Drives the real Python CLI through the Swift bridge against a throw-away gate home.
/// Skipped when the venv CLI is not built on this machine.
final class GateCLIIntegrationTests: XCTestCase {
    func testKeysAndBatchRoundTrip() throws {
        let exe = GateCLI.defaultExecutable()
        try XCTSkipUnless(FileManager.default.isExecutableFile(atPath: exe.path), "secret-gate CLI not present")
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("sg-ui-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let cli = GateCLI(executable: exe, home: home)

        XCTAssertEqual(try cli.listKeys(), [])
        var keys = try cli.newKey(named: "work", makeCurrent: true)
        XCTAssertEqual(keys.map(\.name), ["work"])
        XCTAssertTrue(keys[0].current)
        keys = try cli.newKey(named: "home", makeCurrent: false)
        XCTAssertEqual(keys.first { $0.current }?.name, "work")
        keys = try cli.useKey(named: "home")
        XCTAssertEqual(keys.first { $0.current }?.name, "home")

        let entries = [
            TokenEntry(label: "a/pass", hosts: "a.example.com", value: "pw-fake-1234"),
            TokenEntry(label: "a/totp", kind: .totp, uses: [.otp], value: "JBSWY3DPEHPK3PXP"),
            TokenEntry(label: "bad/host", hosts: "bad_host!", value: "x"),
        ]
        let results = try cli.encrypt(entries)
        XCTAssertEqual(results.count, 3)
        XCTAssertTrue(results[0].token?.hasPrefix("enc:v1:") ?? false)
        XCTAssertTrue(results[1].ok)
        XCTAssertFalse(results[2].ok)
        XCTAssertFalse(results.description.contains("pw-fake-1234"))
    }

    func testMissingExecutableIsAClearError() {
        let cli = GateCLI(executable: URL(fileURLWithPath: "/nonexistent/secret-gate"), home: URL(fileURLWithPath: "/tmp"))
        XCTAssertThrowsError(try cli.listKeys()) { err in
            XCTAssertTrue(err.localizedDescription.contains("找不到"))
        }
    }
}
