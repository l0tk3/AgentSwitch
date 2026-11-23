import XCTest
@testable import AgentSwitchMacCore

final class TrustedFoldersTests: XCTestCase {
    func testAddRemoveAndCover() throws {
        let list = TrustedFolders(folders: ["/Users/me/work"])
        XCTAssertEqual(list.adding("/Users/me/work/").folders, ["/Users/me/work"])
        XCTAssertEqual(list.adding("/Users/me/other").folders, ["/Users/me/work", "/Users/me/other"])
        XCTAssertEqual(list.removing("/Users/me/work/").folders, [])
        XCTAssertTrue(list.covers("/Users/me/work"))
        XCTAssertTrue(list.covers("/Users/me/work/app/src"))
        XCTAssertFalse(list.covers("/Users/me/workshop"))
        let decoded = try JSONDecoder().decode(TrustedFolders.self, from: Data(#"{"folders":["/a"]}"#.utf8))
        XCTAssertEqual(decoded.folders, ["/a"])
    }
}
