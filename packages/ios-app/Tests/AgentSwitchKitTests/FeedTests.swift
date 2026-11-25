import XCTest
@testable import AgentSwitchKit

/// How a stored text reads on the phone.
final class FeedTests: XCTestCase {
    func testSealedMessageReadsWithoutTheLegendOrLongTokens() {
        let token = "enc:v1:" + String(repeating: "A", count: 80) + "xyz789"
        let stored = "登录 https://fin.example.test 用 \(token) 查报表\n\n[AgentSwitch sealed the credentials in this message. The following field names …]\nCandidate record layout: password\n- \(token): password → fin.example.test"
        XCTAssertEqual(MessageDisplay.readable(stored), "登录 https://fin.example.test 用 🔒密文 查报表")
        XCTAssertEqual(MessageDisplay.readable("no secrets here"), "no secrets here")
        XCTAssertEqual(MessageDisplay.readable("\(token) \(token)"), "🔒密文 🔒密文")
        XCTAssertEqual(MessageDisplay.readable("enc:v1:short"), "enc:v1:short", "only real-looking tokens are shortened")
    }
}
