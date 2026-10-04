import XCTest
@testable import AgentSwitchMacCore

/// What the Mac window tells its terminal page of the look (docs/ui-v0.md §8).
final class TerminalPageLookTests: XCTestCase {
    func testAColourIsSaidAsSixDigits() {
        XCTAssertEqual(TerminalPageLook.hex(red: 0, green: 0.518, blue: 1), "#0084ff")
        XCTAssertEqual(TerminalPageLook.hex(red: 1, green: 1, blue: 1), "#ffffff")
        XCTAssertEqual(TerminalPageLook.hex(red: -1, green: 2, blue: .nan), "#00ff00", "what is outside 0…1 is clamped")
    }

    func testThePageHearsTheLookAndTheAccentAtItsStart() {
        let classic = TerminalPageLook.startScript(look: .classic, accent: "#0A84FF")
        XCTAssertTrue(classic.contains("window.agentswitchLook = \"classic\""), classic)
        XCTAssertTrue(classic.contains("window.agentswitchAccent = \"#0a84ff\""), classic)
        XCTAssertTrue(classic.contains("classList.toggle(\"classic\", true)"), classic)
        let pixel = TerminalPageLook.startScript(look: .pixel, accent: nil)
        XCTAssertTrue(pixel.contains("window.agentswitchLook = \"pixel\""), pixel)
        XCTAssertTrue(pixel.contains("window.agentswitchAccent = undefined"), pixel)
        XCTAssertTrue(pixel.contains("classList.toggle(\"classic\", false)"), pixel)
    }

    func testAChangeIsToldToThePageOpen() {
        let classic = TerminalPageLook.changeScript(look: .classic, accent: "#ff9f0a")
        XCTAssertTrue(classic.hasSuffix("window.agentswitch?.look?.(\"classic\", \"#ff9f0a\")"), classic)
        // A page still starting reads what was said once it is ready.
        XCTAssertTrue(classic.hasPrefix("window.agentswitchLook = \"classic\"; window.agentswitchAccent = \"#ff9f0a\"; "), classic)
        let pixel = TerminalPageLook.changeScript(look: .pixel, accent: nil)
        XCTAssertTrue(pixel.hasSuffix("window.agentswitch?.look?.(\"pixel\", undefined)"), pixel)
    }

    func testOnlyASixDigitColourReachesThePage() {
        for bad in ["blue", "#fff", "0a84ff0", "#0a84fg", "#0a84ff\"; alert(1); \"", "＃0a84ff", ""] {
            XCTAssertEqual(TerminalPageLook.accentLiteral(bad), "undefined", bad)
        }
        XCTAssertEqual(TerminalPageLook.accentLiteral(nil), "undefined")
        XCTAssertEqual(TerminalPageLook.accentLiteral("#ABCDEF"), "\"#abcdef\"")
    }
}
