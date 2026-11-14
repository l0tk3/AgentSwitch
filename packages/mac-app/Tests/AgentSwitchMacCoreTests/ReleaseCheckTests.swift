import XCTest
@testable import AgentSwitchMacCore

final class ReleaseCheckTests: XCTestCase {
    func testNumericVersions() throws {
        XCTAssertTrue(try ReleaseCheck.newer("0.10.0", than: "0.2.0"))
        XCTAssertFalse(try ReleaseCheck.newer("0.2.0", than: "0.2.0"))
        XCTAssertFalse(try ReleaseCheck.newer("0.1.9", than: "0.2.0"))
        for invalid in ["v0.2.0", "0.2", "0.2.0-beta.1", "01.2.0", "-1.2.0", "0.2.0/other"] {
            XCTAssertThrowsError(try ReleaseCheck.newer(invalid, than: "0.2.0"))
        }
    }
    func testStableReleaseAndTrustedLink() throws {
        let data = Data(#"{"tag_name":"v0.2.0","draft":false,"prerelease":false,"html_url":"https://untrusted.example"}"#.utf8)
        let release = try ReleaseCheck.decode(data, status: 200)
        XCTAssertEqual(release.page.absoluteString, "https://github.com/l0tk3/AgentSwitch/releases/tag/v0.2.0")
        for status in [404, 403, 429, 500] { XCTAssertThrowsError(try ReleaseCheck.decode(data, status: status)) }
        for field in ["draft", "prerelease"] {
            let value = Data("{\"tag_name\":\"v0.2.0\",\"draft\":false,\"prerelease\":false}".replacingOccurrences(of: "\"\(field)\":false", with: "\"\(field)\":true").utf8)
            XCTAssertThrowsError(try ReleaseCheck.decode(value, status: 200))
        }
    }
}
