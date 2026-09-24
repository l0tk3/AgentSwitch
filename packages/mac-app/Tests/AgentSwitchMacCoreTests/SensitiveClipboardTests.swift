import AppKit
import XCTest
@testable import AgentSwitchMacCore

final class SensitiveClipboardTests: XCTestCase {
    @MainActor
    func testPairingLinkIsMarkedAndClearedOnlyWhileStillOurs() {
        // A private named pasteboard: the test never touches the user's clipboard.
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("com.agentswitch.tests.\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        let written = SensitiveClipboard.copy("agentswitch://pair?p=abc", to: pasteboard)
        XCTAssertEqual(pasteboard.string(forType: .string), "agentswitch://pair?p=abc")
        let types = pasteboard.types ?? []
        XCTAssertTrue(types.contains(SensitiveClipboard.transientType))
        XCTAssertTrue(types.contains(SensitiveClipboard.concealedType))
        XCTAssertTrue(SensitiveClipboard.clear(pasteboard, ifStill: written))
        XCTAssertNil(pasteboard.string(forType: .string))

        // The user copied something else before the code expired: left alone.
        let again = SensitiveClipboard.copy("agentswitch://pair?p=def", to: pasteboard)
        pasteboard.clearContents()
        pasteboard.setString("something the user copied", forType: .string)
        XCTAssertFalse(SensitiveClipboard.clear(pasteboard, ifStill: again))
        XCTAssertEqual(pasteboard.string(forType: .string), "something the user copied")
    }
}
