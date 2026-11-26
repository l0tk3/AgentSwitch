import AgentSwitchMacCore
import XCTest

/// Replacement words that are regular expressions (docs/model-gate-v0.md, user #596).
final class RedactRegexTests: XCTestCase {
    func testAPatternIsShownBetweenSlashesAndAPlainWordAsItIs() throws {
        let json = #"[{"id":"a","value":"ghp_[A-Za-z0-9]{36}","restore":true,"regex":true,"addedAt":0},{"id":"b","value":"falcon","restore":true,"addedAt":0}]"#
        let words = try JSONDecoder().decode([RedactWord].self, from: Data(json.utf8))
        XCTAssertEqual(words.map(\.isRegex), [true, false])
        XCTAssertEqual(words.map(\.shown), ["/ghp_[A-Za-z0-9]{36}/", "falcon"])
    }
}
