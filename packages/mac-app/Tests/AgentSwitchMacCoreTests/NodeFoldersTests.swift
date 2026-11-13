import XCTest
@testable import AgentSwitchMacCore

final class NodeFoldersTests: XCTestCase {
    func testFoldersOfALevelAreFoldersAndLinksToThemWithoutCredentialPlaces() {
        let level = FileLevel(path: "/home/u", parent: "/home", home: "/home/u", entries: [
            FileEntry(name: "work", kind: .dir), FileEntry(name: "notes.md", kind: .file),
            FileEntry(name: "data", kind: .link, link: .init(target: "/mnt/data", kind: .dir)),
            FileEntry(name: "a.txt", kind: .link, link: .init(target: "/x/a.txt", kind: .file)),
            FileEntry(name: ".agentswitch", kind: .dir, locked: true),
        ])
        XCTAssertEqual(NodeFolders.folders(of: level).map(\.name), ["work", "data"])
    }

    func testPathsAndWhereThePickerStarts() {
        XCTAssertEqual(NodeFolders.path(of: "tmp", in: "/"), "/tmp")
        XCTAssertEqual(NodeFolders.path(of: "b", in: "/a"), "/a/b")
        XCTAssertEqual(NodeFolders.start(typed: " /tmp/demo ", home: nil), "/tmp/demo")
        XCTAssertNil(NodeFolders.start(typed: "~/work", home: nil))
        XCTAssertEqual(NodeFolders.start(typed: "~/work", home: "/home/u"), "/home/u/work")
        XCTAssertEqual(NodeFolders.start(typed: "~", home: "/home/u"), "/home/u")
        XCTAssertNil(NodeFolders.start(typed: "work", home: "/home/u"))
        XCTAssertNil(NodeFolders.start(typed: "", home: "/home/u"))
    }

    func testAPathIsShownWithTheNodesHomeAsATilde() {
        XCTAssertEqual(NodeFolders.shown("/home/u", home: "/home/u"), "~")
        XCTAssertEqual(NodeFolders.shown("/home/u/work", home: "/home/u"), "~/work")
        XCTAssertEqual(NodeFolders.shown("/home/user2", home: "/home/u"), "/home/user2")
        XCTAssertEqual(NodeFolders.shown("/tmp", home: ""), "/tmp")
    }
}
