import AgentSwitchMacCore
import XCTest

final class DockPresenceTests: XCTestCase {
    func testDockIconFollowsTheSettingsWindowUnlessAlwaysShown() {
        XCTAssertFalse(DockPresence.showsInDock(alwaysShow: false, settingsWindowOpen: false))
        XCTAssertTrue(DockPresence.showsInDock(alwaysShow: false, settingsWindowOpen: true))
        XCTAssertTrue(DockPresence.showsInDock(alwaysShow: true, settingsWindowOpen: false))
        XCTAssertTrue(DockPresence.showsInDock(alwaysShow: true, settingsWindowOpen: true))
    }
}
