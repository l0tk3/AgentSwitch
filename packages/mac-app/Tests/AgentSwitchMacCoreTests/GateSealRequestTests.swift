import XCTest
@testable import AgentSwitchMacCore

/// A value on its way to a node's vault (a profile's key, a proxy's password): what it must have before it is sent.
final class GateSealRequestTests: XCTestCase {
    func testASealRequestNeedsANameSitesAndAValue() {
        XCTAssertEqual(GateSealRequest(label: " ", sites: "a.com", value: "x").problem, "缺少名称")
        XCTAssertNotNil(GateSealRequest(label: "-bad", sites: "a.com", value: "x").problem)
        XCTAssertEqual(GateSealRequest(label: "corp/pass", sites: " , ", value: "x").problem, "须填写可使用此密文的站点")
        XCTAssertEqual(GateSealRequest(label: "corp/pass", sites: "a.com", value: "").problem, "缺少值")
        XCTAssertNil(GateSealRequest(label: "corp/pass", sites: "a.com", value: "x-long-pw").problem)
        // gate-simple-v0 §3.3: under 8 characters is not sealed (the gate's own words); counted as Unicode scalars.
        XCTAssertEqual(GateSealRequest(label: "corp/pass", sites: "a.com", value: "1234567").problem, "值至少需要 8 个字符（过短的值遮不住，也容易被猜到）")
        XCTAssertNotNil(GateSealRequest(label: "corp/pass", sites: "a.com", value: "密码密码密码密").problem)
        XCTAssertNil(GateSealRequest(label: "corp/pass", sites: "a.com", value: "12345678").problem)
        XCTAssertNil(GateSealRequest(label: "corp/pass", sites: "a.com", value: "密码密码密码密码").problem)
    }

    func testSitesBecomeHostsOnceEach() {
        let request = GateSealRequest(label: "fin/pass", sites: "https://me@Fin.example.com:8443/login?x，*.example.com fin.example.com:8443",
                                      value: "s3cret")
        XCTAssertEqual(request.hostList, ["fin.example.com:8443", "*.example.com"])
    }
}
